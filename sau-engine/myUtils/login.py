import asyncio
import base64
import os
import sqlite3
import uuid
from pathlib import Path
from playwright.async_api import async_playwright

from conf import BASE_DIR, LOCAL_CHROME_HEADLESS, LOCAL_CHROME_PATH
from myUtils.auth import check_cookie
from uploader.douyin_uploader.main import douyin_cookie_gen as uploader_douyin_cookie_gen
from uploader.ks_uploader.main import get_ks_cookie as uploader_get_ks_cookie
from uploader.xiaohongshu_uploader.main import xiaohongshu_cookie_gen as uploader_xiaohongshu_cookie_gen
from utils.base_social_media import set_init_script
from utils.browser_hook import resolve_chromium_launch_kwargs

# 交互式扫码登录默认弹出可见窗口，方便人工过滑块与短信验证；如需无头可设 SAU_LOGIN_HEADLESS=1
LOGIN_BROWSER_HEADLESS = os.environ.get("SAU_LOGIN_HEADLESS", "0").strip().lower() in {"1", "true", "yes"}


# 统一获取浏览器启动配置（防风控+直连+引入本地浏览器）
def get_browser_options(playwright=None, headless: bool | None = None):
    return resolve_chromium_launch_kwargs(
        playwright,
        headless=LOGIN_BROWSER_HEADLESS if headless is None else headless,
        args=[
            '--no-proxy-server',
            '--disable-blink-features=AutomationControlled',  # 核心防爬屏蔽：去掉 window.navigator.webdriver 标签
            '--lang=zh-CN',
            '--disable-infobars',
            '--no-first-run',
            '--no-default-browser-check',
        ],
    )


async def _safe_close(page, context, browser):
    for resource in (page, context, browser):
        if resource is not None:
            try:
                await resource.close()
            except Exception:
                pass


def _emit_status(status_queue, value):
    if status_queue is not None:
        status_queue.put(value)


def _record_account(platform_type: int, cookie_filename: str, account_id: str):
    with sqlite3.connect(Path(BASE_DIR / "db" / "database.db")) as conn:
        cursor = conn.cursor()
        cursor.execute('''
            INSERT INTO user_info (type, filePath, userName, status)
            VALUES (?, ?, ?, ?)
        ''', (platform_type, cookie_filename, account_id, 1))
        conn.commit()
        print("✅ 用户状态已记录")


def _make_qr_callback(status_queue):
    async def _on_qr(payload: dict):
        status_message = (payload or {}).get("status_message") or ""
        if status_message:
            _emit_status(status_queue, f"STATUS:{status_message}")
            return
        data_url = (payload or {}).get("image_data_url") or ""
        image_path = (payload or {}).get("image_path") or ""
        if data_url.startswith(("data:image", "http://", "https://")):
            _emit_status(status_queue, data_url)
            return
        if image_path and Path(image_path).is_file():
            raw = Path(image_path).read_bytes()
            _emit_status(status_queue, f"data:image/png;base64,{base64.b64encode(raw).decode('ascii')}")
            return
        if data_url:
            _emit_status(status_queue, data_url)
    return _on_qr


async def _complete_login(platform_type, account_id, context, status_queue):
    uuid_v1 = uuid.uuid1()
    print(f"UUID v1: {uuid_v1}")
    cookies_dir = Path(BASE_DIR / "cookiesFile")
    cookies_dir.mkdir(parents=True, exist_ok=True)
    cookie_filename = f"{uuid_v1}.json"
    cookie_file = cookies_dir / cookie_filename
    await context.storage_state(path=cookie_file)
    result = await check_cookie(platform_type, cookie_filename)
    if not result:
        try:
            cookie_file.unlink(missing_ok=True)
        except OSError:
            pass
        return False
    _record_account(platform_type, cookie_filename, account_id)
    _emit_status(status_queue, "200")
    return True


async def _run_uploader_login(platform_type: int, account_id: str, status_queue, login_fn):
    uuid_v1 = uuid.uuid1()
    cookies_dir = Path(BASE_DIR / "cookiesFile")
    cookies_dir.mkdir(parents=True, exist_ok=True)
    cookie_filename = f"{uuid_v1}.json"
    cookie_path = cookies_dir / cookie_filename
    try:
        result = await login_fn(
            str(cookie_path),
            qrcode_callback=_make_qr_callback(status_queue),
            headless=LOGIN_BROWSER_HEADLESS,
        )
        if isinstance(result, dict) and result.get("success") and cookie_path.is_file():
            _record_account(platform_type, cookie_filename, account_id)
            _emit_status(status_queue, "200")
            return True
        err_msg = (result or {}).get("message") if isinstance(result, dict) else "登录失败"
        if err_msg:
            _emit_status(status_queue, f"ERROR:{err_msg}")
        _emit_status(status_queue, "500")
        return None
    except Exception as e:
        print(f"❌ 扫码登录失败 (type={platform_type}): {e}")
        _emit_status(status_queue, f"ERROR:{e}")
        _emit_status(status_queue, "500")
        return None


# 抖音登录
async def douyin_cookie_gen(id, status_queue):
    return await _run_uploader_login(3, id, status_queue, uploader_douyin_cookie_gen)


async def _capture_tencent_qr(page) -> str:
    iframe_locator = page.frame_locator("iframe").first
    img_locator = iframe_locator.get_by_role("img").first
    await img_locator.wait_for(state="visible", timeout=20000)
    # 等待二维码图片真正解码完成再截图，避免截到空白图
    for _ in range(20):
        try:
            ready = await img_locator.evaluate("el => Boolean(el.complete && el.naturalWidth > 0)")
            if ready:
                break
        except Exception:
            pass
        await asyncio.sleep(0.25)
    src = await img_locator.get_attribute("src")
    if src and src.startswith("data:image"):
        return src
    png_bytes = await img_locator.screenshot()
    return f"data:image/png;base64,{base64.b64encode(png_bytes).decode('ascii')}"


# 视频号登录
async def get_tencent_cookie(id, status_queue):
    browser = context = page = None
    async with async_playwright() as playwright:
        try:
            options = get_browser_options(playwright, headless=LOGIN_BROWSER_HEADLESS)
            browser = await playwright.chromium.launch(**options)
            context = await browser.new_context()
            context = await set_init_script(context)
            page = await context.new_page()
            await page.goto("https://channels.weixin.qq.com/login.html", wait_until="domcontentloaded", timeout=30000)

            try:
                qr_payload = await _capture_tencent_qr(page)
                print("✅ 获取视频号二维码成功")
                _emit_status(status_queue, qr_payload)
            except Exception as qr_exc:
                if LOGIN_BROWSER_HEADLESS:
                    raise
                print(f"⚠️ 未能自动截取视频号二维码，请直接在弹出窗口扫码: {qr_exc}")
                _emit_status(status_queue, "STATUS:已弹出微信视频号登录窗口，请直接在窗口内用微信扫码登录")

            # 轮询最多 270 秒，仅当真实进入 /platform 且离开登录页后校验并保存
            for _ in range(135):
                if page.is_closed():
                    _emit_status(status_queue, "ERROR:登录浏览器窗口已关闭，请重新扫码")
                    _emit_status(status_queue, "500")
                    return None

                url = page.url or ""
                if url.startswith("https://channels.weixin.qq.com/platform") and "/login" not in url.lower():
                    await asyncio.sleep(2)
                    if await _complete_login(2, id, context, status_queue):
                        print("监听视频号登录成功")
                        return True
                    print("⏳ 视频号已跳转但登录态校验暂未通过，继续等待...")

                # 若二维码过期则尝试自动刷新并重新推送
                try:
                    iframe_locator = page.frame_locator("iframe").first
                    for expired_text in ("二维码已失效", "重新获取", "刷新"):
                        btn = iframe_locator.get_by_text(expired_text).first
                        if await btn.count() and await btn.is_visible():
                            await btn.click()
                            await asyncio.sleep(1.5)
                            qr_payload = await _capture_tencent_qr(page)
                            _emit_status(status_queue, qr_payload)
                            break
                except Exception:
                    pass

                await asyncio.sleep(2)

            _emit_status(status_queue, "ERROR:视频号扫码等待超时，请重试")
            _emit_status(status_queue, "500")
            print("监听页面跳转超时")
            return None
        except Exception as e:
            print(f"❌ 视频号扫码登录失败: {e}")
            _emit_status(status_queue, f"ERROR:{e}")
            _emit_status(status_queue, "500")
            return None
        finally:
            await _safe_close(page, context, browser)


# 快手登录
async def get_ks_cookie(id, status_queue):
    return await _run_uploader_login(4, id, status_queue, uploader_get_ks_cookie)


# 小红书登录
async def xiaohongshu_cookie_gen(id, status_queue):
    return await _run_uploader_login(1, id, status_queue, uploader_xiaohongshu_cookie_gen)

# a = asyncio.run(xiaohongshu_cookie_gen(4,None))
# print(a)
