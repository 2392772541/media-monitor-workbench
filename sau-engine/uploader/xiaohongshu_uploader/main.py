# -*- coding: utf-8 -*-
from __future__ import annotations

import asyncio
import inspect
import json
import os
import socket
import subprocess
import time
import urllib.request
from datetime import datetime
from pathlib import Path

from patchright.async_api import Page
from patchright.async_api import Playwright
from patchright.async_api import async_playwright

from conf import BASE_DIR, DEBUG_MODE, LOCAL_CHROME_HEADLESS, LOCAL_CHROME_PATH
from uploader.base_video import BaseVideoUploader
from utils.login_qrcode import build_login_qrcode_path
from utils.login_qrcode import decode_qrcode_from_path
from utils.login_qrcode import print_terminal_qrcode
from utils.login_qrcode import remove_qrcode_file
from utils.login_qrcode import save_data_url_image
from utils.log import xiaohongshu_logger

XHS_LOGIN_URL = "https://creator.xiaohongshu.com/login"
XHS_PUBLISH_VIDEO_URL = "https://creator.xiaohongshu.com/publish/publish?from=homepage&target=video"
XHS_PUBLISH_NOTE_URL = "https://creator.xiaohongshu.com/publish/publish?from=homepage&target=image"
XHS_PUBLISH_SUCCESS_URL_PATTERN = "**/publish/success?**"
XHS_LOGIN_BOX_SELECTOR = "div[class*='login-box']"
XHS_LOGIN_SWITCH_SELECTOR = "img.css-wemwzq"
XIAOHONGSHU_PUBLISH_STRATEGY_IMMEDIATE = "immediate"
XIAOHONGSHU_PUBLISH_STRATEGY_SCHEDULED = "scheduled"

# 彻底剥离代理环境变量，确保小红书直连本机宽带网络，避免异地/代理 IP 触发 300012 风控
_PROXY_ENV_KEYS = (
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
)

# 小红书创作者中心有效登录 Cookie 名称集合
_XHS_AUTH_COOKIE_NAMES = (
    "web_session",
    "customer-sso-sid",
    "access-token-creator.xiaohongshu.com",
    "galaxy_creator_session_id",
)

_XHS_RISK_TEXTS = (
    "当前网络存在风险",
    "安全限制",
    "账号存在风险",
    "当前环境存在风险",
    "环境异常",
)


def _msg(emoji: str, text: str) -> str:
    return f"{emoji} {text}"


def _build_direct_env() -> dict[str, str]:
    """构造无代理环境变量字典，避免系统 ALL_PROXY/HTTP_PROXY 渗入小红书浏览器进程。"""
    env = {k: v for k, v in os.environ.items() if k not in _PROXY_ENV_KEYS}
    env["NO_PROXY"] = "*"
    env["no_proxy"] = "*"
    return env


def _resolve_real_chrome_executable() -> str | None:
    """优先寻找本机真实 Chrome（其次 Edge），避免使用内置测试壳触发风控。"""
    candidates: list[str] = []
    if LOCAL_CHROME_PATH:
        candidates.append(str(LOCAL_CHROME_PATH))
    local_app_data = os.environ.get("LOCALAPPDATA", "")
    candidates.extend([
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        os.path.join(local_app_data, r"Google\Chrome\Application\chrome.exe") if local_app_data else "",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    ])
    for candidate in candidates:
        if candidate and os.path.isfile(candidate):
            return candidate
    return None


def _get_xhs_profile_dir() -> Path:
    """小红书专用独立持久化配置目录（保留真实 a1/webId 设备指纹，与日常浏览器完全隔离）。"""
    profile_dir = Path(BASE_DIR) / "cookies" / "xhs_chrome_profile"
    profile_dir.mkdir(parents=True, exist_ok=True)
    return profile_dir


def _find_free_local_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _probe_cdp_ready(port: int, timeout: float = 1.0) -> bool:
    """使用无代理直连探活本机 Chrome CDP 调试接口。"""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(f"http://127.0.0.1:{port}/json/version", timeout=timeout) as resp:
            return resp.status == 200
    except Exception:
        return False


def _terminate_chrome_proc(proc: subprocess.Popen | None) -> None:
    if proc is None:
        return
    try:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=3)
    except Exception:
        pass


def _cleanup_stale_xhs_chrome(profile_dir: Path) -> None:
    """若上一次由本模块拉起的隔离 Chrome 尚未退出，先将其温和关闭，避免抢占同一配置目录。"""
    meta_file = profile_dir / ".sau_xhs_chrome.json"
    if not meta_file.is_file():
        return
    try:
        meta = json.loads(meta_file.read_text(encoding="utf-8"))
        old_pid = int(meta.get("pid") or 0)
    except Exception:
        old_pid = 0
    if old_pid > 0:
        try:
            if os.name == "nt":
                subprocess.run(
                    ["taskkill", "/PID", str(old_pid), "/T", "/F"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=5,
                    check=False,
                )
            else:
                os.kill(old_pid, 15)
            time.sleep(0.4)
        except Exception:
            pass
    try:
        meta_file.unlink(missing_ok=True)
    except OSError:
        pass


def _launch_clean_real_chrome_cdp(profile_dir: Path, timeout_sec: float = 15.0) -> tuple[subprocess.Popen, int]:
    """以纯原生方式启动真实系统 Chrome 并开放本机 CDP，无自动化标志、无注入脚本、无代理。"""
    chrome_exe = _resolve_real_chrome_executable()
    if not chrome_exe:
        raise RuntimeError("未在本机找到 Chrome 或 Edge 浏览器")

    profile_dir.mkdir(parents=True, exist_ok=True)
    _cleanup_stale_xhs_chrome(profile_dir)

    port = _find_free_local_port()
    cmd = [
        chrome_exe,
        f"--remote-debugging-port={port}",
        f"--user-data-dir={profile_dir}",
        "--no-proxy-server",
        "--no-first-run",
        "--no-default-browser-check",
        "--lang=zh-CN",
        "--window-size=1280,860",
        "about:blank",
    ]
    proc = subprocess.Popen(
        cmd,
        env=_build_direct_env(),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    meta_file = profile_dir / ".sau_xhs_chrome.json"
    try:
        meta_file.write_text(json.dumps({"pid": proc.pid, "port": port}), encoding="utf-8")
    except OSError:
        pass

    deadline = time.monotonic() + timeout_sec
    while time.monotonic() < deadline:
        if _probe_cdp_ready(port, timeout=1.0):
            return proc, port
        if proc.poll() is not None:
            break
        time.sleep(0.25)

    _terminate_chrome_proc(proc)
    try:
        meta_file.unlink(missing_ok=True)
    except OSError:
        pass
    raise RuntimeError(f"纯净真实 Chrome 启动超时，无法连接本机调试端口 {port}")


def _has_xhs_auth_cookies_in_list(cookies: list[dict] | None) -> bool:
    if not isinstance(cookies, list):
        return False
    for c in cookies:
        if not isinstance(c, dict):
            continue
        domain = str(c.get("domain") or "").lower()
        name = str(c.get("name") or "")
        value = str(c.get("value") or "").strip()
        if "xiaohongshu.com" in domain and name in _XHS_AUTH_COOKIE_NAMES and value:
            return True
    return False


def _has_xhs_auth_cookies_in_file(account_file: str) -> bool:
    try:
        raw = json.loads(Path(account_file).read_text(encoding="utf-8"))
        return _has_xhs_auth_cookies_in_list(raw.get("cookies") if isinstance(raw, dict) else [])
    except Exception:
        return False


async def _load_storage_cookies_into_context(context, account_file: str) -> int:
    """将保存的 storage_state 中的小红书 Cookie 同步写入纯净真实 Chrome 上下文。"""
    try:
        raw = json.loads(Path(account_file).read_text(encoding="utf-8"))
    except Exception:
        return 0
    cookies = raw.get("cookies") if isinstance(raw, dict) else None
    if not isinstance(cookies, list) or not cookies:
        return 0
    sanitized: list[dict] = []
    for c in cookies:
        if not isinstance(c, dict):
            continue
        name = c.get("name")
        value = c.get("value")
        domain = c.get("domain")
        if not name or value is None or not domain:
            continue
        item: dict = {
            "name": str(name),
            "value": str(value),
            "domain": str(domain),
            "path": str(c.get("path") or "/"),
            "httpOnly": bool(c.get("httpOnly", False)),
            "secure": bool(c.get("secure", False)),
        }
        same_site = c.get("sameSite")
        if same_site in ("Strict", "Lax", "None"):
            item["sameSite"] = same_site
        expires = c.get("expires")
        if isinstance(expires, (int, float)) and expires > 0:
            item["expires"] = float(expires)
        sanitized.append(item)
    if sanitized:
        await context.add_cookies(sanitized)
    return len(sanitized)


async def _page_has_xhs_risk_warning(page: Page) -> str:
    """检测页面是否出现小红书风控或环境异常提示，返回命中文本。"""
    for risk_text in _XHS_RISK_TEXTS:
        try:
            loc = page.get_by_text(risk_text).first
            if await loc.count() and await loc.is_visible():
                return risk_text
        except Exception:
            continue
    return ""


async def _emit_qrcode_callback(qrcode_callback, payload: dict):
    if not qrcode_callback:
        return

    callback_result = qrcode_callback(payload)
    if inspect.isawaitable(callback_result):
        await callback_result


def _build_login_result(
    success: bool,
    status: str,
    message: str,
    account_file: str,
    qrcode: dict | None = None,
    current_url: str = "",
) -> dict:
    return {
        "success": success,
        "status": status,
        "message": message,
        "account_file": str(account_file),
        "qrcode": qrcode,
        "current_url": current_url,
    }


async def _open_xhs_qrcode_panel(page: Page) -> None:
    login_box = page.locator(XHS_LOGIN_BOX_SELECTOR).first
    await login_box.wait_for(state="visible", timeout=30000)

    scan_text = login_box.locator("div:has-text('扫一扫')").first
    if await scan_text.count():
        return

    switch_img = login_box.locator(XHS_LOGIN_SWITCH_SELECTOR).first
    await switch_img.wait_for(state="visible", timeout=10000)
    await switch_img.click()
    await asyncio.sleep(1.5)
    if await page.get_by_text("当前网络存在风险").count() or await page.get_by_text("安全限制").count():
        raise RuntimeError("小红书安全限制：当前网络存在风险(300012)，请改用手机号+短信验证码登录或关闭代理后重试")
    await login_box.locator("div:has-text('扫一扫')").first.wait_for(state="visible", timeout=10000)


async def _find_xhs_qrcode_locator(page: Page):
    await _open_xhs_qrcode_panel(page)

    qrcode_img = page.locator('.login-box-container').get_by_text("APP扫一扫登录").filter(visible=True).locator("xpath=..//following-sibling::div//img").nth(0)

    if await qrcode_img.count():
        return qrcode_img

    raise RuntimeError("未在扫一扫登录区域找到小红书二维码图片")


async def _extract_xhs_qrcode_src(page: Page) -> str:
    qrcode_img = await _find_xhs_qrcode_locator(page)
    await qrcode_img.wait_for(state="visible", timeout=30000)
    qrcode_src = await qrcode_img.get_attribute("src")
    if not qrcode_src:
        raise RuntimeError("未获取到小红书登录二维码地址")
    return qrcode_src


async def _save_xhs_qrcode(
    page: Page,
    account_file: str,
    previous_qrcode_path: Path | None = None,
    qrcode_callback=None,
) -> dict:
    qrcode_src = await _extract_xhs_qrcode_src(page)
    qrcode_path = build_login_qrcode_path(account_file, suffix="xhs_login_qrcode")
    qrcode_img = await _find_xhs_qrcode_locator(page)

    if qrcode_src.startswith("data:image/"):
        save_data_url_image(qrcode_src, qrcode_path)
    else:
        qrcode_path.parent.mkdir(parents=True, exist_ok=True)
        await qrcode_img.screenshot(path=str(qrcode_path))

    if previous_qrcode_path and previous_qrcode_path != qrcode_path:
        if remove_qrcode_file(previous_qrcode_path):
            xiaohongshu_logger.info(_msg("🧹", f"临时二维码文件已清理: {previous_qrcode_path}"))

    xiaohongshu_logger.info(_msg("🖼️", f"二维码已经准备好啦，已保存到: {qrcode_path}"))
    qrcode_content = decode_qrcode_from_path(qrcode_path)
    if qrcode_content:
        print_terminal_qrcode(qrcode_content, qrcode_path, "小红书APP")
    else:
        xiaohongshu_logger.warning(_msg("😵", f"终端没法完整显示二维码，请打开 {qrcode_path} 扫码"))

    qrcode_info = {
        "image_path": str(qrcode_path),
        "image_data_url": qrcode_src,
    }
    await _emit_qrcode_callback(qrcode_callback, qrcode_info)
    return qrcode_info


def _xhs_launch_kwargs(headless: bool) -> dict:
    """小红书直连启动参数：彻底清代理、去掉自动化特征、绝不注入 stealth.min.js。"""
    kwargs: dict = {
        "headless": headless,
        "ignore_default_args": ["--enable-automation"],
        "env": _build_direct_env(),
        "args": [
            "--no-proxy-server",
            "--lang=zh-CN",
            "--no-first-run",
            "--no-default-browser-check",
        ],
    }
    real_chrome = _resolve_real_chrome_executable()
    if real_chrome:
        kwargs["executable_path"] = real_chrome
    else:
        kwargs["channel"] = "chrome"
    return kwargs


async def _is_xhs_login_completed(page: Page) -> bool:
    url = page.url or ""
    if not url.startswith("https://creator.xiaohongshu.com/"):
        return False
    if url.startswith(XHS_LOGIN_URL) or "/login" in url.lower():
        return False

    try:
        if await _page_has_xhs_risk_warning(page):
            return False
    except Exception:
        pass

    login_box = page.locator(XHS_LOGIN_BOX_SELECTOR).first
    if not await login_box.count():
        return True

    try:
        return not await login_box.is_visible()
    except Exception:
        return True


async def _verify_xhs_session_in_same_page(page: Page, context) -> bool:
    """在同一真实浏览器标签页内就地复核登录态，绝不新起第二个无头浏览器触发风控。"""
    try:
        cookies = await context.cookies("https://creator.xiaohongshu.com")
    except Exception:
        cookies = []
    if not _has_xhs_auth_cookies_in_list(cookies):
        return False

    try:
        current = page.url or ""
        if "/publish/publish" not in current:
            await page.goto(XHS_PUBLISH_VIDEO_URL, wait_until="domcontentloaded", timeout=20000)
            await page.wait_for_timeout(2200)
    except Exception:
        pass

    url = page.url or ""
    if url.startswith(XHS_LOGIN_URL) or "/login" in url.lower():
        return False
    if await _page_has_xhs_risk_warning(page):
        return False
    return True


async def cookie_auth(account_file):
    if not account_file or not os.path.exists(account_file):
        return False
    if not _has_xhs_auth_cookies_in_file(str(account_file)):
        xiaohongshu_logger.info(_msg("🥹", "cookie 文件中缺少小红书有效登录字段，按失效处理"))
        return False

    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(**_xhs_launch_kwargs(headless=True))
        try:
            # 严禁再注入 stealth.min.js（patchright 已做底层隐藏，叠加旧 stealth 会篡改原型链触发风控）
            context = await browser.new_context(storage_state=account_file)
            page = await context.new_page()
            await page.goto(XHS_PUBLISH_VIDEO_URL, wait_until="domcontentloaded", timeout=20000)
            await page.wait_for_timeout(3000)

            url = page.url or ""
            if url.startswith(XHS_LOGIN_URL) or "/login" in url.lower():
                xiaohongshu_logger.info(_msg("🥹", "cookie 已失效，得重新登录一下"))
                return False

            risk = await _page_has_xhs_risk_warning(page)
            if risk:
                xiaohongshu_logger.warning(_msg("😵", f"小红书触发安全风控({risk})，按失效处理"))
                return False

            login_box = page.locator(XHS_LOGIN_BOX_SELECTOR).first
            if await login_box.count():
                try:
                    if await login_box.is_visible():
                        xiaohongshu_logger.info(_msg("🥹", "页面仍然停留在登录页，按 cookie 失效处理"))
                        return False
                except Exception:
                    return False

            xiaohongshu_logger.success(_msg("🥳", "cookie 有效"))
            return True
        except Exception as exc:
            xiaohongshu_logger.warning(_msg("😵", f"cookie 校验时出错，按失效处理: {exc}"))
            return False
        finally:
            await browser.close()


async def xiaohongshu_setup(
    account_file,
    handle=False,
    return_detail=False,
    qrcode_callback=None,
    headless: bool = LOCAL_CHROME_HEADLESS,
):
    if not os.path.exists(account_file) or not await cookie_auth(account_file):
        if not handle:
            result = _build_login_result(False, "cookie_invalid", "cookie文件不存在或已失效", account_file)
            return result if return_detail else False
        xiaohongshu_logger.info(_msg("🥹", "cookie 失效了，准备打开浏览器重新登录"))
        result = await xiaohongshu_cookie_gen(
            account_file,
            qrcode_callback=qrcode_callback,
            headless=headless,
        )
        return result if return_detail else result["success"]

    result = _build_login_result(True, "cookie_valid", "cookie有效", account_file)
    return result if return_detail else True


async def xiaohongshu_cookie_gen(
    account_file,
    qrcode_callback=None,
    poll_interval: int = 2,
    max_checks: int = 135,
    headless: bool = LOCAL_CHROME_HEADLESS,
):
    """小红书防风控登录：优先拉起纯净直连真实 Chrome，保留设备指纹、不注入 stealth、不二次起无头校验。"""
    account_path = Path(account_file)
    account_path.parent.mkdir(parents=True, exist_ok=True)

    use_real_chrome_cdp = (not headless) and bool(_resolve_real_chrome_executable())
    chrome_proc: subprocess.Popen | None = None
    profile_dir = _get_xhs_profile_dir()
    qrcode_path = None
    qrcode_info = None
    result = _build_login_result(False, "failed", "小红书登录失败", account_file)

    async with async_playwright() as playwright:
        browser = None
        context = None
        page = None
        try:
            if use_real_chrome_cdp:
                xiaohongshu_logger.info(_msg("🛡️", "启动纯净直连真实 Chrome（隔离配置目录，无代理、无注入脚本）"))
                chrome_proc, cdp_port = await asyncio.to_thread(_launch_clean_real_chrome_cdp, profile_dir)
                browser = await playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{cdp_port}")
                context = browser.contexts[0] if browser.contexts else await browser.new_context()
                page = context.pages[0] if context.pages else await context.new_page()
            else:
                if headless:
                    xiaohongshu_logger.info(_msg("🖼️", "小红书登录将以无头模式运行，保存本地二维码图片"))
                browser = await playwright.chromium.launch(**_xhs_launch_kwargs(headless=headless))
                context = await browser.new_context()
                page = await context.new_page()

            await page.goto(XHS_LOGIN_URL, wait_until="domcontentloaded", timeout=30000)
            await asyncio.sleep(1.5)

            if use_real_chrome_cdp:
                # 严禁机械自动点击切换二维码图标：保留人类操作节奏，支持手机号+短信验证码或手动切扫码
                await _emit_qrcode_callback(
                    qrcode_callback,
                    {
                        "status_message": (
                            "已弹出纯净真实 Chrome 窗口（已直连关闭代理、去掉易触发风控的注入脚本）。"
                            "推荐直接在 Chrome 窗口用「手机号+短信验证码」登录（最稳不易被风控），"
                            "也可以手动点登录框右上角二维码图标用小红书 App 扫码，登完会自动保存！"
                        )
                    },
                )
            else:
                try:
                    qrcode_info = await _save_xhs_qrcode(page, account_file, qrcode_callback=qrcode_callback)
                    qrcode_path = Path(qrcode_info["image_path"])
                except Exception as qr_exc:
                    if headless:
                        raise
                    xiaohongshu_logger.warning(_msg("⚠️", f"未能自动抓取小红书二维码，请直接在弹出窗口登录: {qr_exc}"))
                    await _emit_qrcode_callback(
                        qrcode_callback,
                        {"status_message": "已弹出小红书登录窗口，请直接在窗口内用手机验证码或扫码登录"},
                    )

            xiaohongshu_logger.info(_msg("🧍", "正在等待小红书登录完成（支持手机验证码或扫码）"))
            risk_hint_sent = False

            for _ in range(max_checks):
                if chrome_proc is not None and chrome_proc.poll() is not None:
                    result = _build_login_result(False, "closed", "登录浏览器窗口已关闭，请重新登录", account_file, qrcode_info, "")
                    return result
                if page.is_closed():
                    if context.pages:
                        page = context.pages[-1]
                    else:
                        result = _build_login_result(False, "closed", "登录浏览器窗口已关闭，请重新登录", account_file, qrcode_info, "")
                        return result

                if await _is_xhs_login_completed(page):
                    await asyncio.sleep(2)
                    if await _verify_xhs_session_in_same_page(page, context):
                        await context.storage_state(path=account_file)
                        xiaohongshu_logger.success(_msg("🥳", "小红书登录成功并已安全保存登录态（同页验证，未触发二次无头探测）"))
                        result = _build_login_result(True, "success", "小红书登录成功", account_file, qrcode_info, page.url)
                        return result
                    xiaohongshu_logger.warning(_msg("⏳", "检测到页面跳转但登录态尚未就绪，继续等待"))

                # 如检测到扫码风控弹窗，立即在工作台提示切换手机短信登录，不直接强退中断用户操作
                if not risk_hint_sent:
                    risk_text = await _page_has_xhs_risk_warning(page)
                    if risk_text:
                        risk_hint_sent = True
                        xiaohongshu_logger.warning(_msg("⚠️", f"页面出现小红书提示({risk_text})，建议切换手机短信验证码登录"))
                        await _emit_qrcode_callback(
                            qrcode_callback,
                            {
                                "status_message": (
                                    f"检测到小红书风控提示（{risk_text}）："
                                    "请不要继续点扫码，直接在当前弹出的 Chrome 窗口切回「手机号 + 短信验证码」登录即可绕过扫码风控！"
                                )
                            },
                        )

                if not use_real_chrome_cdp:
                    for expired_text in ("二维码已过期", "二维码失效", "点击刷新"):
                        try:
                            expired_btn = page.get_by_text(expired_text).first
                            if await expired_btn.count() and await expired_btn.is_visible():
                                xiaohongshu_logger.warning(_msg("😵", "小红书二维码失效了，自动刷新中"))
                                await expired_btn.click()
                                await asyncio.sleep(1.5)
                                qrcode_info = await _save_xhs_qrcode(
                                    page,
                                    account_file,
                                    qrcode_path,
                                    qrcode_callback=qrcode_callback,
                                )
                                qrcode_path = Path(qrcode_info["image_path"])
                                break
                        except Exception:
                            continue

                await asyncio.sleep(poll_interval)

            result = _build_login_result(
                False,
                "timeout",
                "等待小红书登录超时，请重试",
                account_file,
                qrcode_info,
                "" if page.is_closed() else page.url,
            )
        except Exception as exc:
            current_url = ""
            if page is not None and not page.is_closed():
                current_url = page.url
            result = _build_login_result(False, "failed", str(exc), account_file, current_url=current_url)
        finally:
            if remove_qrcode_file(qrcode_path):
                xiaohongshu_logger.info(_msg("🧹", f"临时二维码文件已清理: {qrcode_path}"))
            if not result["success"]:
                if os.path.exists(account_file):
                    try:
                        os.remove(account_file)
                    except OSError:
                        pass
                xiaohongshu_logger.error(_msg("😢", f"登录失败: {result['message']}"))
            if use_real_chrome_cdp:
                if browser is not None:
                    try:
                        await browser.close()
                    except Exception:
                        pass
                _terminate_chrome_proc(chrome_proc)
                try:
                    (profile_dir / ".sau_xhs_chrome.json").unlink(missing_ok=True)
                except OSError:
                    pass
            else:
                if context is not None:
                    try:
                        await context.close()
                    except Exception:
                        pass
                if browser is not None:
                    try:
                        await browser.close()
                    except Exception:
                        pass
        return result


class XiaoHongShuBaseUploader(BaseVideoUploader):
    def __init__(
        self,
        publish_date: datetime | int,
        account_file,
        publish_strategy: str = XIAOHONGSHU_PUBLISH_STRATEGY_IMMEDIATE,
        debug: bool = DEBUG_MODE,
        headless: bool = LOCAL_CHROME_HEADLESS,
    ):
        self.publish_date = publish_date
        self.account_file = str(account_file)
        self.publish_strategy = publish_strategy
        self.debug = debug
        self.date_format = "%Y年%m月%d日 %H:%M"
        self.local_executable_path = LOCAL_CHROME_PATH
        self.headless = headless

    async def validate_base_args(self):
        if not os.path.exists(self.account_file):
            raise RuntimeError(f"cookie文件不存在，请先完成小红书登录: {self.account_file}")
        if not await cookie_auth(self.account_file):
            raise RuntimeError(f"cookie文件已失效，请先完成小红书登录: {self.account_file}")

        if self.publish_strategy not in {
            XIAOHONGSHU_PUBLISH_STRATEGY_IMMEDIATE,
            XIAOHONGSHU_PUBLISH_STRATEGY_SCHEDULED,
        }:
            raise ValueError(f"不支持的发布策略: {self.publish_strategy}")

        if self.publish_strategy == XIAOHONGSHU_PUBLISH_STRATEGY_SCHEDULED:
            self.publish_date = self.validate_publish_date(self.publish_date)
        else:
            self.publish_date = 0

    async def _run_with_clean_browser(self, playwright: Playwright, work_coro):
        """使用纯净直连浏览器执行上传（可见模式复用真实 Chrome 指纹，无头模式亦不注入 stealth）。"""
        use_real_chrome_cdp = (not self.headless) and bool(_resolve_real_chrome_executable())
        chrome_proc: subprocess.Popen | None = None
        profile_dir = _get_xhs_profile_dir()
        browser = None
        context = None
        try:
            if use_real_chrome_cdp:
                chrome_proc, cdp_port = await asyncio.to_thread(_launch_clean_real_chrome_cdp, profile_dir)
                browser = await playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{cdp_port}")
                context = browser.contexts[0] if browser.contexts else await browser.new_context()
                await _load_storage_cookies_into_context(context, self.account_file)
                page = context.pages[0] if context.pages else await context.new_page()
            else:
                browser = await playwright.chromium.launch(**_xhs_launch_kwargs(headless=self.headless))
                context = await browser.new_context(
                    permissions=["geolocation"],
                    storage_state=self.account_file,
                    bypass_csp=True,
                )
                page = await context.new_page()

            await work_coro(page)
            await context.storage_state(path=self.account_file)
            xiaohongshu_logger.success(_msg("🥳", "cookie 更新完毕"))
        finally:
            if use_real_chrome_cdp:
                if browser is not None:
                    try:
                        await browser.close()
                    except Exception:
                        pass
                _terminate_chrome_proc(chrome_proc)
                try:
                    (profile_dir / ".sau_xhs_chrome.json").unlink(missing_ok=True)
                except OSError:
                    pass
            else:
                if context is not None:
                    try:
                        await context.close()
                    except Exception:
                        pass
                if browser is not None:
                    try:
                        await browser.close()
                    except Exception:
                        pass

    async def set_schedule_time_xiaohongshu(self, page: Page, publish_date: datetime):
        xiaohongshu_logger.info(_msg("🕒", f"小人准备设置定时发布时间: {publish_date.strftime(self.date_format)}"))
        await page.locator('.custom-switch-card').filter(has_text="定时发布").locator('.d-switch').click()
        await asyncio.sleep(1)
        publish_date_hour = publish_date.strftime("%Y-%m-%d %H:%M")
        time_input = page.locator('.d-datepicker-input-filter input.d-text')
        await time_input.fill(str(publish_date_hour))
        await asyncio.sleep(1)

    async def set_location(self, page: Page, location: str = "青岛市"):
        if not location:
            return True

        xiaohongshu_logger.info(_msg("📍", f"小人准备设置位置: {location}"))
        loc_ele = await page.wait_for_selector('div.d-text.d-select-placeholder.d-text-ellipsis.d-text-nowrap')
        await loc_ele.click()
        await page.wait_for_timeout(1000)
        await page.keyboard.type(location)
        dropdown_selector = 'div.d-popover.d-popover-default.d-dropdown.--size-min-width-large'
        await page.wait_for_timeout(2000)
        try:
            await page.wait_for_selector(dropdown_selector, timeout=3000)
        except Exception:
            xiaohongshu_logger.warning(_msg("😵", "位置下拉列表没按预期出现，小人继续按旧逻辑查找"))
        await page.wait_for_timeout(1000)
        flexible_xpath = (
            f'//div[contains(@class, "d-popover") and contains(@class, "d-dropdown")]'
            f'//div[contains(@class, "d-options-wrapper")]'
            f'//div[contains(@class, "d-grid") and contains(@class, "d-options")]'
            f'//div[contains(@class, "name") and text()="{location}"]'
        )
        await page.wait_for_timeout(3000)
        try:
            location_option = await page.wait_for_selector(
                flexible_xpath,
                timeout=3000
            )

            if not location_option:
                location_option = await page.wait_for_selector(
                    f'//div[contains(@class, "d-popover") and contains(@class, "d-dropdown")]'
                    f'//div[contains(@class, "d-options-wrapper")]'
                    f'//div[contains(@class, "d-grid") and contains(@class, "d-options")]'
                    f'/div[1]//div[contains(@class, "name") and text()="{location}"]',
                    timeout=2000
                )

            await location_option.scroll_into_view_if_needed()
            await location_option.click()
            xiaohongshu_logger.success(_msg("🥳", f"位置已经设置成 {location}"))
            return True
        except Exception as e:
            xiaohongshu_logger.error(_msg("😢", f"设置位置失败: {e}"))
            try:
                all_options = await page.query_selector_all(
                    '//div[contains(@class, "d-popover") and contains(@class, "d-dropdown")]'
                    '//div[contains(@class, "d-options-wrapper")]'
                    '//div[contains(@class, "d-grid") and contains(@class, "d-options")]'
                    '/div'
                )
                xiaohongshu_logger.debug(_msg("🧍", f"位置下拉里一共找到 {len(all_options)} 个选项"))
                for i, option in enumerate(all_options[:3]):
                    option_text = await option.inner_text()
                    xiaohongshu_logger.debug(_msg("🧾", f"候选位置 {i + 1}: {option_text.strip()[:50]}"))
            except Exception as inner_e:
                xiaohongshu_logger.debug(_msg("😵", f"读取位置候选列表失败: {inner_e}"))
            return False

    async def fill_title(self, page: Page) -> None:
        title_container = page.locator('input[placeholder*="填写标题"]')
        await title_container.fill(self.title[:20])

    async def fill_desc(self, page: Page) -> None:
        if not getattr(self, "desc", ""):
            return

        desc = page.locator('p[data-placeholder*="输入正文描述"]')
        await desc.click()
        await page.keyboard.press("Backspace")
        await page.keyboard.press("Control+KeyA")
        await page.keyboard.press("Delete")
        await page.keyboard.type(self.desc)
        await page.keyboard.press("Enter")

    async def fill_tags(self, page: Page) -> None:
        # 清洗标签：去空白与前导 #、保序去重、最多保留 6 个
        raw_tags = getattr(self, "tags", None) or []
        clean_tags: list[str] = []
        seen: set[str] = set()
        for raw in raw_tags:
            cleaned = str(raw).strip().lstrip("#").strip()
            if not cleaned or cleaned in seen:
                continue
            seen.add(cleaned)
            clean_tags.append(cleaned)
            if len(clean_tags) >= 6:
                break

        if not clean_tags:
            return

        if not getattr(self, "desc", ""):
            desc = page.locator('p[data-placeholder*="输入正文描述"]')
            await desc.click()

        for tag in clean_tags:
            await page.keyboard.type("#" + tag, delay=30)
            try:
                await page.locator('#creator-editor-topic-container').wait_for(
                    state="visible",
                    timeout=3000
                )
                first_item = page.locator('#creator-editor-topic-container .item').first
                await first_item.wait_for(state="visible", timeout=2000)
                await first_item.click()
            except Exception as exc:
                xiaohongshu_logger.warning(f"未匹配到小红书话题建议 '{tag}'，使用空格跳过: {exc}")
                await page.keyboard.press("Space")

    async def fill_meta(self, page: Page) -> None:
        await self.fill_title(page)
        await self.fill_desc(page)
        await self.fill_tags(page)


class XiaoHongShuVideo(XiaoHongShuBaseUploader):
    def __init__(
        self,
        title,
        file_path,
        tags,
        publish_date: datetime | int,
        account_file,
        thumbnail_path=None,
        desc: str | None = None,
        publish_strategy: str = XIAOHONGSHU_PUBLISH_STRATEGY_IMMEDIATE,
        debug: bool = DEBUG_MODE,
        headless: bool = LOCAL_CHROME_HEADLESS,
    ):
        super().__init__(
            publish_date=publish_date,
            account_file=account_file,
            publish_strategy=publish_strategy,
            debug=debug,
            headless=headless,
        )
        self.title = title
        self.file_path = file_path
        self.tags = tags or []
        self.thumbnail_path = thumbnail_path
        self.desc = desc or ""

    async def validate_upload_args(self):
        await self.validate_base_args()
        if not self.title or not str(self.title).strip():
            raise ValueError("视频模式下，title 是必须的")

        self.file_path = str(self.validate_video_file(self.file_path))
        if self.thumbnail_path:
            self.thumbnail_path = str(self.validate_image_file(self.thumbnail_path))

    async def handle_upload_error(self, page: Page):
        xiaohongshu_logger.warning(_msg("😵", "视频上传摔了一跤，小人马上重新上传"))
        await page.locator('div.progress-div [class^="upload-btn-input"]').set_input_files(self.file_path)

    async def set_thumbnail(self, page: Page, thumbnail_path: str):
        if not thumbnail_path:
            return

        xiaohongshu_logger.info(_msg("🖼️", "小人准备设置封面"))

        cover_plugin_title = page.locator("div.cover-plugin-title").filter(has_text="设置封面")
        cover_upload_dialog = cover_plugin_title.locator(
            "xpath=ancestor::div[contains(@class, 'cover-plugin-preview')]"
        ).locator("div.cover > div.default:visible")
        await cover_upload_dialog.wait_for(state="visible", timeout=30000)

        await cover_upload_dialog.click(force=True)

        modal = page.locator("div.d-modal.cover-modal")
        await modal.wait_for(state="visible", timeout=30000)

        file_input = modal.locator('input[type="file"][accept*="image"]').first
        await file_input.wait_for(state="attached", timeout=10000)
        await file_input.set_input_files(thumbnail_path)
        await page.wait_for_timeout(2000)

        confirm_button = modal.locator("button.mojito-button").filter(has_text="确定").first
        await confirm_button.wait_for(state="visible", timeout=10000)
        await confirm_button.click()

        await modal.wait_for(state="hidden", timeout=30000)
        xiaohongshu_logger.success(_msg("🥳", "封面已经设置完成"))

    async def upload_video_content(self, page: Page) -> None:
        xiaohongshu_logger.info(_msg("🏃", f"小人开始搬运视频: {self.title}.mp4"))
        xiaohongshu_logger.info(_msg("🧭", "小人正在赶往视频发布页"))
        await page.goto(XHS_PUBLISH_VIDEO_URL)
        await page.wait_for_url(XHS_PUBLISH_VIDEO_URL)
        await page.locator("div[class^='upload-content'] input[class='upload-input']").set_input_files(self.file_path)

        while True:
            try:
                upload_input = await page.wait_for_selector('input.upload-input', timeout=3000)
                preview_new = await upload_input.query_selector(
                    'xpath=following-sibling::div[contains(@class, "preview-new")]')
                if preview_new:
                    stage_elements = await preview_new.query_selector_all('div.stage')
                    upload_success = False
                    for stage in stage_elements:
                        text_content = await page.evaluate('(element) => element.textContent', stage)
                        if '上传成功' in text_content or '分辨率' in text_content:
                            upload_success = True
                            break
                    if upload_success:
                        xiaohongshu_logger.success(_msg("🥳", "视频已经传完啦"))
                        break
                    xiaohongshu_logger.debug(_msg("🧍", "还没看到上传成功标识，小人继续等一会"))
                else:
                    xiaohongshu_logger.debug(_msg("🧍", "还没拿到预览区域，小人继续等一会"))
            except Exception as e:
                xiaohongshu_logger.debug(_msg("😵", f"上传状态还没稳定下来，小人继续观察: {e}"))
            await asyncio.sleep(2)

        xiaohongshu_logger.info(_msg("✍️", "小人开始填标题、描述和话题"))
        await self.fill_meta(page)

        await self.set_thumbnail(page, self.thumbnail_path)

        if self.publish_strategy == XIAOHONGSHU_PUBLISH_STRATEGY_SCHEDULED and self.publish_date != 0:
            await self.set_schedule_time_xiaohongshu(page, self.publish_date)

        while True:
            try:
                if self.publish_strategy == XIAOHONGSHU_PUBLISH_STRATEGY_SCHEDULED:
                    await page.locator('button:has-text("定时发布")').click()
                else:
                    await page.locator('button:has-text("发布")').click()
                await page.wait_for_url(
                    "https://creator.xiaohongshu.com/publish/success?**",
                    timeout=3000
                )
                xiaohongshu_logger.success(_msg("🥳", "视频发布成功，小人开心收工"))
                break
            except Exception:
                xiaohongshu_logger.info(_msg("🏃", "小人正在冲刺发布视频"))
                if self.debug:
                    await page.screenshot(full_page=True)
                await asyncio.sleep(0.5)

    async def upload(self, playwright: Playwright) -> None:
        xiaohongshu_logger.info(_msg("🧍", "小人先检查 cookie、视频文件、封面和发布时间"))
        await self.validate_upload_args()
        xiaohongshu_logger.info(_msg("🥳", "上传前检查通过"))
        await self._run_with_clean_browser(playwright, self.upload_video_content)

    async def xiaohongshu_upload_video(self):
        async with async_playwright() as playwright:
            await self.upload(playwright)

    async def main(self):
        await self.xiaohongshu_upload_video()


class XiaoHongShuNote(XiaoHongShuBaseUploader):
    def __init__(
        self,
        image_paths,
        note,
        tags,
        publish_date: datetime | int,
        account_file,
        title: str | None = None,
        desc: str | None = None,
        publish_strategy: str = XIAOHONGSHU_PUBLISH_STRATEGY_IMMEDIATE,
        debug: bool = DEBUG_MODE,
        headless: bool = LOCAL_CHROME_HEADLESS,
    ):
        super().__init__(
            publish_date=publish_date,
            account_file=account_file,
            publish_strategy=publish_strategy,
            debug=debug,
            headless=headless,
        )
        self.image_paths = image_paths
        self.note = note or ""
        self.tags = tags or []
        self.desc = desc if desc is not None else self.note
        self.title = title or ((self.desc or self.note)[:20] if (self.desc or self.note) else "")

    async def validate_upload_args(self):
        await self.validate_base_args()
        if not self.image_paths:
            raise ValueError("图文模式下，图片是必须的")
        if not self.title or not str(self.title).strip():
            raise ValueError("图文模式下，title 是必须的")

        if isinstance(self.image_paths, (str, Path)):
            self.image_paths = [self.image_paths]

        normalized_image_paths = []
        for image_path in self.image_paths:
            normalized_image_paths.append(str(self.validate_image_file(image_path)))
        self.image_paths = normalized_image_paths

    async def upload_note_content(self, page: Page) -> None:
        xiaohongshu_logger.info(_msg("🏃", f"小人开始搬运图文，共 {len(self.image_paths)} 张图片"))
        xiaohongshu_logger.info(_msg("🧭", "小人正在赶往图文发布页"))
        await page.goto(XHS_PUBLISH_NOTE_URL)
        await page.wait_for_url(XHS_PUBLISH_NOTE_URL)

        upload_input = page.locator('input[type="file"][accept*="image"]').first
        if not await upload_input.count():
            upload_input = page.locator("div[class^='upload-content'] input[class='upload-input']").first

        await upload_input.wait_for(state="attached", timeout=30000)
        xiaohongshu_logger.info(_msg("📤", "小人正在上传图片"))
        await upload_input.set_input_files(self.image_paths)

        while True:
            try:
                title_container = page.locator('input[placeholder*="填写标题"]').first
                await title_container.wait_for(state="visible", timeout=3000)
                xiaohongshu_logger.success(_msg("🥳", "图文素材已经传完，可以开始填写内容了"))
                break
            except Exception:
                xiaohongshu_logger.debug(_msg("🧍", "图文素材还在上传，小人继续等一会"))
                await asyncio.sleep(1)

        xiaohongshu_logger.info(_msg("✍️", "小人开始填标题、描述和话题"))
        await self.fill_meta(page)

        if self.publish_strategy == XIAOHONGSHU_PUBLISH_STRATEGY_SCHEDULED and self.publish_date != 0:
            await self.set_schedule_time_xiaohongshu(page, self.publish_date)

        while True:
            try:
                if self.publish_strategy == XIAOHONGSHU_PUBLISH_STRATEGY_SCHEDULED:
                    await page.locator('button:has-text("定时发布")').click()
                else:
                    await page.locator('button:has-text("发布")').click()
                await page.wait_for_url(
                    XHS_PUBLISH_SUCCESS_URL_PATTERN,
                    timeout=3000
                )
                xiaohongshu_logger.success(_msg("🥳", "图文发布成功，小人开心收工"))
                break
            except Exception:
                xiaohongshu_logger.info(_msg("🏃", "小人正在冲刺发布图文"))
                if self.debug:
                    await page.screenshot(full_page=True)
                await asyncio.sleep(0.5)

    async def upload(self, playwright: Playwright) -> None:
        xiaohongshu_logger.info(_msg("🧍", "小人先检查 cookie、图片和发布时间"))
        await self.validate_upload_args()
        xiaohongshu_logger.info(_msg("🥳", "图文上传前检查通过"))
        await self._run_with_clean_browser(playwright, self.upload_note_content)

    async def xiaohongshu_upload_note(self):
        async with async_playwright() as playwright:
            await self.upload(playwright)

    async def main(self):
        await self.xiaohongshu_upload_note()
