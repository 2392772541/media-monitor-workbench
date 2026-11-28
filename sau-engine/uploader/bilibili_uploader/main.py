# -*- coding: utf-8 -*-
"""B站（Bilibili）官方网页扫码登录、极速 Cookie 校验与创作者中心视频投稿上传器。"""
from __future__ import annotations

import asyncio
import base64
import inspect
import io
import json
import os
import time
from datetime import datetime, timedelta
from pathlib import Path

import requests
from playwright.async_api import async_playwright

from conf import BASE_DIR, DEBUG_MODE, LOCAL_CHROME_HEADLESS
from uploader.base_video import BaseVideoUploader
from utils.browser_hook import resolve_chromium_launch_kwargs
from utils.log import bilibili_logger
from utils.login_qrcode import build_login_qrcode_path, remove_qrcode_file

BILIBILI_QR_GENERATE_URL = "https://passport.bilibili.com/x/passport-login/web/qrcode/generate"
BILIBILI_QR_POLL_URL = "https://passport.bilibili.com/x/passport-login/web/qrcode/poll"
BILIBILI_NAV_URL = "https://api.bilibili.com/x/web-interface/nav"
BILIBILI_SPI_URL = "https://api.bilibili.com/x/frontend/finger/spi"
BILIBILI_UPLOAD_URL = "https://member.bilibili.com/platform/upload/video/frame"

BILIBILI_PUBLISH_STRATEGY_IMMEDIATE = "immediate"
BILIBILI_PUBLISH_STRATEGY_SCHEDULED = "scheduled"

_PROXY_ENV_KEYS = (
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
)

_DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/132.0.0.0 Safari/537.36"
    ),
    "Referer": "https://www.bilibili.com/",
    "Origin": "https://www.bilibili.com",
    "Accept-Language": "zh-CN,zh;q=0.9",
}


def _build_direct_env() -> dict[str, str]:
    """构造无代理环境变量，确保 B站上传浏览器直连本机网络。"""
    env = {k: v for k, v in os.environ.items() if k not in _PROXY_ENV_KEYS}
    env["NO_PROXY"] = "*"
    env["no_proxy"] = "*"
    return env


def _new_direct_session() -> requests.Session:
    """创建强制直连（跳过系统 ALL_PROXY/HTTP_PROXY）的 requests 会话。"""
    session = requests.Session()
    session.trust_env = False
    session.headers.update(_DEFAULT_HEADERS)
    return session


async def _emit_qrcode_callback(qrcode_callback, payload: dict) -> None:
    if not qrcode_callback:
        return
    res = qrcode_callback(payload)
    if inspect.isawaitable(res):
        await res


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


def _render_qr_png_bytes(qr_url: str) -> bytes:
    """把 B站官方登录链接渲染成清晰 PNG 二维码（兼容 segno、qrcode+Pillow 及零依赖纯 Python PNG 编码）。"""
    try:
        import segno

        qr = segno.make(qr_url, error="m")
        buf = io.BytesIO()
        qr.save(buf, kind="png", scale=7, border=2)
        return buf.getvalue()
    except ImportError:
        pass

    import qrcode

    qr = qrcode.QRCode(
        version=None,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=7,
        border=2,
    )
    qr.add_data(qr_url)
    qr.make(fit=True)
    try:
        img = qr.make_image(fill_color="black", back_color="white")
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()
    except Exception:
        # 零依赖纯 Python PNG 兜底编码，防止缺少 Pillow 时出错
        import struct
        import zlib

        matrix = qr.get_matrix()
        scale = 7
        size = len(matrix) * scale
        rows = bytearray()
        for row in matrix:
            line = bytes([0 if cell else 255 for cell in row for _ in range(scale)])
            for _ in range(scale):
                rows.append(0)
                rows.extend(line)

        def _chunk(tag: bytes, data: bytes) -> bytes:
            return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

        ihdr = struct.pack(">IIBBBBB", size, size, 8, 0, 0, 0, 0)
        return b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", ihdr) + _chunk(b"IDAT", zlib.compress(bytes(rows))) + _chunk(b"IEND", b"")


def _render_qr_data_url(qr_url: str) -> tuple[str, bytes]:
    png_bytes = _render_qr_png_bytes(qr_url)
    data_url = f"data:image/png;base64,{base64.b64encode(png_bytes).decode('ascii')}"
    return data_url, png_bytes


def _session_to_storage_state(session: requests.Session, extra_cookies: dict[str, str] | None = None) -> dict:
    """将 B站官方登录返回的 Cookie 转成标准 Playwright storage_state JSON（可直接供投稿与对标采集复用）。"""
    cookies_out: list[dict] = []
    seen_keys: set[tuple[str, str, str]] = set()
    default_expires = float(int(time.time()) + 180 * 86400)

    for c in session.cookies:
        domain = c.domain or ".bilibili.com"
        if not domain.startswith(".") and "bilibili.com" in domain:
            domain = ".bilibili.com"
        path = c.path or "/"
        key = (c.name, domain, path)
        if key in seen_keys:
            continue
        seen_keys.add(key)
        cookies_out.append(
            {
                "name": str(c.name),
                "value": str(c.value or ""),
                "domain": domain,
                "path": path,
                "expires": float(c.expires) if c.expires else default_expires,
                "httpOnly": bool(c.name == "SESSDATA" or getattr(c, "_rest", {}).get("HttpOnly") is not None),
                "secure": bool(c.secure or c.name == "SESSDATA"),
                "sameSite": "Lax",
            }
        )

    for name, value in (extra_cookies or {}).items():
        if not value:
            continue
        key = (name, ".bilibili.com", "/")
        if key in seen_keys:
            continue
        seen_keys.add(key)
        cookies_out.append(
            {
                "name": str(name),
                "value": str(value),
                "domain": ".bilibili.com",
                "path": "/",
                "expires": default_expires,
                "httpOnly": False,
                "secure": False,
                "sameSite": "Lax",
            }
        )

    return {"cookies": cookies_out, "origins": []}


def _extract_bilibili_cookies_from_file(account_file: str) -> dict[str, str]:
    """从 Playwright storage_state JSON 中提取 bilibili.com 域名下的 Cookie 字典。"""
    try:
        raw = json.loads(Path(account_file).read_text(encoding="utf-8"))
    except Exception:
        return {}
    cookies = raw.get("cookies") if isinstance(raw, dict) else None
    if not isinstance(cookies, list):
        return {}
    result: dict[str, str] = {}
    for c in cookies:
        if not isinstance(c, dict):
            continue
        domain = str(c.get("domain") or "").lower()
        name = str(c.get("name") or "").strip()
        value = str(c.get("value") or "").strip()
        if "bilibili.com" in domain and name and value:
            result[name] = value
    return result


def _request_qr_sync(session: requests.Session) -> tuple[str, str]:
    resp = session.get(BILIBILI_QR_GENERATE_URL, timeout=12)
    resp.raise_for_status()
    payload = resp.json()
    if payload.get("code") != 0:
        raise RuntimeError(f"获取 B站二维码失败: {payload.get('message') or payload}")
    data = payload.get("data") or {}
    qr_url = str(data.get("url") or "").strip()
    qr_key = str(data.get("qrcode_key") or "").strip()
    if not qr_url or not qr_key:
        raise RuntimeError("B站二维码接口返回字段不完整")
    return qr_url, qr_key


def _poll_qr_sync(session: requests.Session, qr_key: str) -> dict:
    resp = session.get(BILIBILI_QR_POLL_URL, params={"qrcode_key": qr_key}, timeout=12)
    resp.raise_for_status()
    payload = resp.json()
    if payload.get("code") != 0:
        raise RuntimeError(f"查询 B站扫码状态失败: {payload.get('message') or payload}")
    return payload.get("data") or {}


def _warmup_and_verify_sync(session: requests.Session) -> tuple[bool, str, dict[str, str]]:
    """补全 buvid3/buvid4 指纹并调用官方 /nav 接口确认已真正登录。"""
    extra: dict[str, str] = {}
    try:
        spi_resp = session.get(BILIBILI_SPI_URL, timeout=10)
        if spi_resp.ok:
            spi_data = (spi_resp.json() or {}).get("data") or {}
            if spi_data.get("b_3"):
                extra["buvid3"] = str(spi_data["b_3"])
            if spi_data.get("b_4"):
                extra["buvid4"] = str(spi_data["b_4"])
    except Exception:
        pass

    nav_resp = session.get(BILIBILI_NAV_URL, timeout=12)
    nav_resp.raise_for_status()
    nav_json = nav_resp.json() or {}
    nav_data = nav_json.get("data") or {}
    is_login = nav_json.get("code") == 0 and bool(nav_data.get("isLogin"))
    uname = str(nav_data.get("uname") or "").strip()
    return is_login, uname, extra


def _cookie_auth_sync(account_file: str) -> bool:
    cookies = _extract_bilibili_cookies_from_file(account_file)
    if not cookies.get("SESSDATA"):
        return False
    session = _new_direct_session()
    try:
        for k, v in cookies.items():
            session.cookies.set(k, v, domain=".bilibili.com", path="/")
        resp = session.get(BILIBILI_NAV_URL, timeout=12)
        if not resp.ok:
            return False
        payload = resp.json() or {}
        data = payload.get("data") or {}
        return payload.get("code") == 0 and bool(data.get("isLogin"))
    except Exception as exc:
        bilibili_logger.warning(f"B站 cookie 校验异常: {exc}")
        return False
    finally:
        session.close()


async def cookie_auth(account_file) -> bool:
    """零浏览器极速校验 B站登录态（直接核验官方 nav 接口）。"""
    if not account_file or not os.path.exists(account_file):
        return False
    ok = await asyncio.to_thread(_cookie_auth_sync, str(account_file))
    if ok:
        bilibili_logger.success("B站 cookie 有效")
    else:
        bilibili_logger.info("B站 cookie 已失效，需要重新扫码登录")
    return ok


async def bilibili_cookie_gen(
    account_file,
    qrcode_callback=None,
    poll_interval: int = 2,
    max_checks: int = 135,
    headless: bool = LOCAL_CHROME_HEADLESS,  # 保持与其它平台签名一致
) -> dict:
    """调用 B站官方网页二维码接口完成扫码登录，零弹窗极速出码并保存标准 Playwright storage_state。"""
    del headless
    account_path = Path(account_file)
    account_path.parent.mkdir(parents=True, exist_ok=True)
    qrcode_path: Path | None = None
    qrcode_info: dict | None = None
    session = _new_direct_session()
    result = _build_login_result(False, "failed", "B站扫码登录失败", account_file)

    try:
        qr_url, qr_key = await asyncio.to_thread(_request_qr_sync, session)
        data_url, png_bytes = _render_qr_data_url(qr_url)
        qrcode_path = build_login_qrcode_path(account_file, suffix="bilibili_login_qrcode")
        qrcode_path.parent.mkdir(parents=True, exist_ok=True)
        qrcode_path.write_bytes(png_bytes)
        qrcode_info = {"image_path": str(qrcode_path), "image_data_url": data_url}
        await _emit_qrcode_callback(qrcode_callback, qrcode_info)
        bilibili_logger.info("B站官方登录二维码已生成，等待手机扫码...")

        scanned_notified = False
        refresh_count = 0

        for _ in range(max_checks):
            poll_data = await asyncio.to_thread(_poll_qr_sync, session, qr_key)
            code = int(poll_data.get("code", -1))

            if code == 0:
                # 扫码确认成功，核验登录态并补全 buvid3/buvid4
                is_login, uname, extra_cookies = await asyncio.to_thread(_warmup_and_verify_sync, session)
                storage_state = _session_to_storage_state(session, extra_cookies=extra_cookies)
                cookie_names = {c["name"] for c in storage_state.get("cookies", [])}
                if not is_login or "SESSDATA" not in cookie_names:
                    raise RuntimeError("B站已确认扫码，但未获取到有效 SESSDATA，请重试")

                tmp_path = account_path.with_suffix(".tmp")
                tmp_path.write_text(json.dumps(storage_state, ensure_ascii=False, indent=2), encoding="utf-8")
                tmp_path.replace(account_path)

                display_name = f"（{uname}）" if uname else ""
                bilibili_logger.success(f"B站扫码登录成功{display_name}")
                result = _build_login_result(
                    True,
                    "success",
                    f"B站扫码登录成功{display_name}",
                    account_file,
                    qrcode_info,
                    BILIBILI_UPLOAD_URL,
                )
                return result

            if code == 86090:
                if not scanned_notified:
                    scanned_notified = True
                    bilibili_logger.info("B站二维码已扫描，等待手机确认登录...")
                    await _emit_qrcode_callback(
                        qrcode_callback,
                        {"status_message": "手机已扫码，请在 B站 App 上点击「确认登录」"},
                    )
            elif code == 86038:
                if refresh_count >= 3:
                    result = _build_login_result(False, "expired", "B站二维码已多次过期，请重新获取", account_file, qrcode_info)
                    return result
                refresh_count += 1
                scanned_notified = False
                bilibili_logger.warning("B站二维码已过期，自动刷新新二维码...")
                qr_url, qr_key = await asyncio.to_thread(_request_qr_sync, session)
                data_url, png_bytes = _render_qr_data_url(qr_url)
                if qrcode_path:
                    qrcode_path.write_bytes(png_bytes)
                qrcode_info = {"image_path": str(qrcode_path), "image_data_url": data_url}
                await _emit_qrcode_callback(qrcode_callback, qrcode_info)

            await asyncio.sleep(poll_interval)

        result = _build_login_result(False, "timeout", "等待 B站扫码登录超时，请重试", account_file, qrcode_info)
    except Exception as exc:
        result = _build_login_result(False, "failed", str(exc), account_file, qrcode_info)
    finally:
        session.close()
        remove_qrcode_file(qrcode_path)
        if not result["success"] and account_path.exists():
            try:
                account_path.unlink()
            except OSError:
                pass
    return result


class BiliBiliVideo(BaseVideoUploader):
    """B站创作者中心网页端视频投稿上传器（支持标题、封面、简介、最多 10 个标签、立即/定时投稿）。"""

    def __init__(
        self,
        title: str,
        file_path: str | Path,
        tags: list[str] | None,
        publish_date: datetime | int,
        account_file: str | Path,
        thumbnail_path: str | Path | None = None,
        desc: str | None = None,
        category: str | int | None = None,
        publish_strategy: str = BILIBILI_PUBLISH_STRATEGY_IMMEDIATE,
        debug: bool = DEBUG_MODE,
        headless: bool = LOCAL_CHROME_HEADLESS,
    ):
        self.title = str(title or "").strip()
        self.file_path = str(file_path)
        self.tags = list(tags or [])
        self.publish_date = publish_date
        self.account_file = str(account_file)
        self.thumbnail_path = str(thumbnail_path) if thumbnail_path else None
        self.desc = str(desc or "").strip()
        self.category = category
        self.publish_strategy = publish_strategy
        self.debug = debug
        self.headless = headless

    async def validate_upload_args(self) -> None:
        if not os.path.exists(self.account_file):
            raise RuntimeError(f"B站 cookie 文件不存在，请先扫码登录: {self.account_file}")
        if not await cookie_auth(self.account_file):
            raise RuntimeError(f"B站 cookie 已失效，请先重新扫码登录: {self.account_file}")
        if not self.title:
            raise ValueError("B站投稿标题 title 不能为空")
        self.file_path = str(self.validate_video_file(self.file_path))
        if self.thumbnail_path:
            self.thumbnail_path = str(self.validate_image_file(self.thumbnail_path))
        if self.publish_strategy not in {
            BILIBILI_PUBLISH_STRATEGY_IMMEDIATE,
            BILIBILI_PUBLISH_STRATEGY_SCHEDULED,
        }:
            raise ValueError(f"不支持的 B站发布策略: {self.publish_strategy}")
        if self.publish_strategy == BILIBILI_PUBLISH_STRATEGY_SCHEDULED:
            self.publish_date = self.validate_publish_date(self.publish_date)
            if isinstance(self.publish_date, datetime):
                now = datetime.now(tz=self.publish_date.tzinfo) if self.publish_date.tzinfo else datetime.now()
                if self.publish_date > now + timedelta(days=15):
                    raise ValueError("B站定时发布时间不能超过未来 15 天")
        else:
            self.publish_date = 0

    async def _resolve_upload_scope(self, page):
        """兼容 B站主页面直出或 iframe 嵌套两种投稿页结构。"""
        for _ in range(25):
            if await page.locator('input[type="file"]').count():
                return page
            for frame in page.frames:
                if frame == page.main_frame:
                    continue
                try:
                    if await frame.locator('input[type="file"]').count():
                        return frame
                except Exception:
                    continue
            await asyncio.sleep(0.5)
        return page

    async def _wait_upload_complete(self, scope, timeout_sec: int = 540) -> None:
        """等待 B站视频文件上传完成。"""
        deadline = time.monotonic() + timeout_sec
        last_log = 0.0
        while time.monotonic() < deadline:
            try:
                for ok_text in ("上传完成", "更换视频", "已上传"):
                    loc = scope.get_by_text(ok_text).first
                    if await loc.count() and await loc.is_visible():
                        bilibili_logger.success(f"B站视频上传完成（检测到：{ok_text}）")
                        return
                # 兜底检测：上传进度条达到 100% 且标题栏可编辑
                pct_loc = scope.locator(".progress-text, .upload-progress").first
                if await pct_loc.count():
                    pct_text = (await pct_loc.inner_text()).strip()
                    if "100%" in pct_text:
                        bilibili_logger.success("B站视频上传进度已达 100%")
                        return
                    if time.monotonic() - last_log >= 10:
                        bilibili_logger.info(f"B站视频上传进度: {pct_text}")
                        last_log = time.monotonic()
            except Exception:
                pass
            await asyncio.sleep(2)
        raise TimeoutError("B站视频上传超时（超过 9 分钟），请检查视频大小或网络连接")

    async def _fill_title(self, scope) -> None:
        safe_title = self.title[:80]
        selectors = [
            'input[placeholder*="请输入稿件标题"]',
            'input[placeholder*="标题"]',
            '.video-title input[type="text"]',
            '.video-title input',
        ]
        for sel in selectors:
            loc = scope.locator(sel).first
            if await loc.count():
                await loc.wait_for(state="visible", timeout=15000)
                await loc.click()
                await loc.fill("")
                await loc.fill(safe_title)
                bilibili_logger.info(f"已填写 B站标题（{len(safe_title)} 字）")
                return
        raise RuntimeError("未找到 B站投稿标题输入框")

    async def _ensure_copyright_and_section(self, scope) -> None:
        """默认选择「自制」，若分区未选则自动选择常用知识/科技分区。"""
        try:
            self_made = scope.get_by_text("自制", exact=True).first
            if await self_made.count() and await self_made.is_visible():
                await self_made.click()
        except Exception:
            pass

        try:
            select_ctrl = scope.locator(".select-controller").first
            if await select_ctrl.count() and await select_ctrl.is_visible():
                ctrl_text = (await select_ctrl.inner_text()).strip()
                if not ctrl_text or "请选择" in ctrl_text:
                    await select_ctrl.click()
                    await asyncio.sleep(0.6)
                    for preferred in ("科技", "知识", "生活"):
                        opt = scope.locator(".drop-list-v2-item, .f-item-content").filter(has_text=preferred).first
                        if await opt.count() and await opt.is_visible():
                            await opt.click()
                            await asyncio.sleep(0.5)
                            sub_opt = scope.locator(".item-main, .drop-list-v2-sub-item").first
                            if await sub_opt.count() and await sub_opt.is_visible():
                                await sub_opt.click()
                            break
        except Exception as exc:
            bilibili_logger.warning(f"B站分区自动检查提示（若已默认选中可忽略）: {exc}")

    async def _fill_tags(self, scope, page) -> None:
        clean_tags: list[str] = []
        seen: set[str] = set()
        for raw in self.tags:
            t = str(raw or "").strip().lstrip("#").strip()[:20]
            if not t or t in seen:
                continue
            seen.add(t)
            clean_tags.append(t)
            if len(clean_tags) >= 10:
                break
        if not clean_tags:
            clean_tags = ["原创分享"]

        selectors = [
            'input[placeholder*="按回车键Enter创建标签"]',
            'input[placeholder*="创建标签"]',
            '.tag-input-wrp input',
        ]
        tag_input = None
        for sel in selectors:
            loc = scope.locator(sel).first
            if await loc.count():
                tag_input = loc
                break
        if tag_input is None:
            bilibili_logger.warning("未找到 B站标签输入框，跳过填写标签")
            return

        await tag_input.scroll_into_view_if_needed()
        for tag in clean_tags:
            try:
                await tag_input.click()
                await tag_input.fill(tag)
                await page.keyboard.press("Enter")
                await asyncio.sleep(0.35)
            except Exception as exc:
                bilibili_logger.warning(f"填写 B站标签 '{tag}' 时提示: {exc}")

    async def _fill_desc(self, scope, page) -> None:
        if not self.desc:
            return
        safe_desc = self.desc[:2000]
        selectors = [
            '.ql-editor',
            'div[data-placeholder*="填写更全面的相关信息"]',
            'textarea[placeholder*="填写更全面的相关信息"]',
            'textarea[placeholder*="简介"]',
        ]
        for sel in selectors:
            loc = scope.locator(sel).first
            if await loc.count():
                await loc.scroll_into_view_if_needed()
                await loc.click()
                try:
                    await loc.fill(safe_desc)
                except Exception:
                    await page.keyboard.press("Control+KeyA")
                    await page.keyboard.press("Backspace")
                    await page.keyboard.type(safe_desc)
                bilibili_logger.info(f"已填写 B站视频简介（{len(safe_desc)} 字）")
                return

    async def _set_thumbnail(self, scope) -> None:
        if not self.thumbnail_path:
            return
        try:
            change_btn = scope.get_by_text("更换封面").first
            if not await change_btn.count():
                change_btn = scope.get_by_text("上传封面").first
            if await change_btn.count() and await change_btn.is_visible():
                await change_btn.click()
                await asyncio.sleep(1.0)
                upload_tab = scope.get_by_text("上传封面").first
                if await upload_tab.count() and await upload_tab.is_visible():
                    await upload_tab.click()
                    await asyncio.sleep(0.5)
                img_input = scope.locator('input[type="file"][accept*="image"]').first
                if await img_input.count():
                    await img_input.set_input_files(self.thumbnail_path)
                    await asyncio.sleep(2.0)
                    done_btn = scope.get_by_text("完成", exact=True).first
                    if await done_btn.count() and await done_btn.is_visible():
                        await done_btn.click()
                        await asyncio.sleep(1.0)
                        bilibili_logger.success("B站自定义封面上传完成")
                        return
            bilibili_logger.warning("未匹配到 B站自定义封面入口，将使用系统默认封面帧")
        except Exception as exc:
            bilibili_logger.warning(f"B站自定义封面设置失败，继续投稿: {exc}")

    async def _set_schedule_time(self, scope) -> None:
        if self.publish_strategy != BILIBILI_PUBLISH_STRATEGY_SCHEDULED or not isinstance(self.publish_date, datetime):
            return
        bilibili_logger.info(f"准备设置 B站定时发布时间: {self.publish_date.strftime('%Y-%m-%d %H:%M')}")
        switch_row = scope.get_by_text("定时发布").first
        await switch_row.wait_for(state="visible", timeout=10000)
        # 点击同容器内的开关控件
        switch_btn = scope.locator('.switch-container, .bcc-switch, input[type="checkbox"]').filter(has_text="").first
        parent_switch = switch_row.locator("xpath=ancestor::div[contains(@class,'dtime') or contains(@class,'timer') or contains(@class,'switch')][1]//div[contains(@class,'switch')]").first
        if await parent_switch.count():
            await parent_switch.click()
        elif await switch_btn.count():
            await switch_btn.click()
        else:
            await switch_row.click()
        await asyncio.sleep(1.0)

        date_str = self.publish_date.strftime("%Y-%m-%d")
        time_str = self.publish_date.strftime("%H:%M")
        date_input = scope.locator('input[placeholder*="选择日期"], input[placeholder*="日期"]').first
        if await date_input.count():
            await date_input.click()
            await date_input.fill(date_str)
            await asyncio.sleep(0.5)
        time_input = scope.locator('input[placeholder*="选择时间"], input[placeholder*="时间"]').first
        if await time_input.count():
            await time_input.click()
            await time_input.fill(time_str)
            await asyncio.sleep(0.5)

    async def _submit_and_confirm(self, scope, page) -> None:
        submit_btn = scope.locator('span.submit-add, button:has-text("立即投稿"), div:has-text("立即投稿")').filter(has_text="立即投稿").last
        await submit_btn.scroll_into_view_if_needed()
        await submit_btn.click()
        bilibili_logger.info("已点击 B站「立即投稿」，等待提交结果...")

        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            url = page.url or ""
            if "upload-manager" in url or "video-up/done" in url:
                bilibili_logger.success("B站视频投稿成功！")
                return
            for ok_text in ("稿件投递成功", "投稿成功", "查看稿件", "再投一个"):
                try:
                    loc = scope.get_by_text(ok_text).first
                    if await loc.count() and await loc.is_visible():
                        bilibili_logger.success(f"B站视频投稿成功（{ok_text}）")
                        return
                except Exception:
                    continue
            await asyncio.sleep(1.0)
        raise RuntimeError("点击「立即投稿」后 30 秒内未检测到投稿成功提示，请检查 B站创作中心")

    async def upload(self, playwright) -> None:
        await self.validate_upload_args()
        launch_kwargs = resolve_chromium_launch_kwargs(
            playwright,
            headless=self.headless,
            args=[
                "--no-proxy-server",
                "--lang=zh-CN",
                "--no-first-run",
                "--no-default-browser-check",
            ],
        )
        launch_kwargs["env"] = _build_direct_env()
        browser = await playwright.chromium.launch(**launch_kwargs)
        context = await browser.new_context(storage_state=self.account_file)
        page = await context.new_page()
        try:
            bilibili_logger.info(f"正在打开 B站创作中心投稿页: {self.title}")
            await page.goto(BILIBILI_UPLOAD_URL, wait_until="domcontentloaded", timeout=30000)
            await asyncio.sleep(2.0)
            if "passport.bilibili.com/login" in (page.url or ""):
                raise RuntimeError("B站登录态已过期，请先在工作台重新扫码登录")

            scope = await self._resolve_upload_scope(page)
            file_input = scope.locator('input[type="file"]').first
            await file_input.wait_for(state="attached", timeout=30000)
            await file_input.set_input_files(self.file_path)
            bilibili_logger.info("已开始上传视频文件到 B站...")

            await self._wait_upload_complete(scope)
            await self._set_thumbnail(scope)
            await self._fill_title(scope)
            await self._ensure_copyright_and_section(scope)
            await self._fill_tags(scope, page)
            await self._fill_desc(scope, page)
            await self._set_schedule_time(scope)
            await self._submit_and_confirm(scope, page)

            await context.storage_state(path=self.account_file)
            bilibili_logger.success("B站投稿完成且登录态已更新")
        except Exception:
            try:
                logs_dir = Path(BASE_DIR) / "logs"
                logs_dir.mkdir(parents=True, exist_ok=True)
                shot = logs_dir / f"bilibili_upload_error_{int(time.time())}.png"
                await page.screenshot(path=str(shot), full_page=True)
                bilibili_logger.error(f"B站投稿失败，已保存诊断截图: {shot}")
            except Exception:
                pass
            raise
        finally:
            await context.close()
            await browser.close()

    async def main(self) -> None:
        async with async_playwright() as playwright:
            await self.upload(playwright)
