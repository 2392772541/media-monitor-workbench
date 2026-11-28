# -*- coding: utf-8 -*-
"""评论互动模块公共基础：安全启动参数、标题模糊匹配、错误截图诊断与统一数据结构"""

from __future__ import annotations

import os
import random
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from conf import BASE_DIR, LOCAL_CHROME_PATH
from utils.base_social_media import set_init_script

PLATFORM_CAPABILITIES: dict[int, dict[str, Any]] = {
    3: {
        "platformType": 3,
        "key": "douyin",
        "name": "抖音",
        "supported": True,
        "reserved": False,
        "note": "已接入抖音创作者中心评论管理，支持同步作品评论、发暖场评与回复粉丝",
    },
    4: {
        "platformType": 4,
        "key": "kuaishou",
        "name": "快手",
        "supported": True,
        "reserved": False,
        "note": "已接入快手创作者服务平台评论管理，支持同步作品评论、发暖场评与回复粉丝",
    },
    1: {
        "platformType": 1,
        "key": "xiaohongshu",
        "name": "小红书",
        "supported": False,
        "reserved": True,
        "note": "已预留接口与开关位，后续扫码绑定小红书创作者账号并接入适配器即可启用",
    },
    2: {
        "platformType": 2,
        "key": "tencent",
        "name": "微信视频号",
        "supported": False,
        "reserved": True,
        "note": "已预留接口与开关位，后续扫码绑定微信视频号助手账号并接入适配器即可启用",
    },
}


def build_launch_kwargs(headless: bool = True) -> dict[str, Any]:
    """统一国内创作者平台直连浏览器参数（绕过本机代理防风控）"""
    args = [
        "--no-proxy-server",
        "--lang=zh-CN",
        "--no-first-run",
        "--no-default-browser-check",
    ]
    if not headless:
        args.append("--window-size=1440,900")
    kwargs: dict[str, Any] = {
        "headless": headless,
        "args": args,
    }
    if LOCAL_CHROME_PATH and os.path.exists(LOCAL_CHROME_PATH):
        kwargs["executable_path"] = LOCAL_CHROME_PATH
    else:
        kwargs["channel"] = "chrome"
    return kwargs


async def create_authenticated_context(browser, cookie_path: str):
    """基于已保存的创作者登录态创建绕过 CSP 限制的隔离上下文"""
    context = await browser.new_context(
        storage_state=cookie_path,
        bypass_csp=True,
        viewport={"width": 1440, "height": 900},
    )
    context = await set_init_script(context)
    return context


def normalize_match_text(text: str) -> str:
    """去除话题标签、标点和空白，用于稳健比对作品标题或评论内容"""
    raw = str(text or "")
    raw = re.sub(r"#[^\s#]+", "", raw)
    raw = re.sub(r"[\s\u3000\r\n\t.,，。！？!?：:；;、“”\"'‘’（）()【】\[\]《》<>·—\-_]+", "", raw)
    return raw.lower().strip()


def titles_match(candidate: str, target: str) -> bool:
    """判断平台展示标题与目标视频标题是否为同一作品"""
    norm_a = normalize_match_text(candidate)
    norm_b = normalize_match_text(target)
    if not norm_a or not norm_b:
        return False
    if norm_a == norm_b:
        return True
    short, long_ = (norm_a, norm_b) if len(norm_a) <= len(norm_b) else (norm_b, norm_a)
    if len(short) >= 6 and short in long_:
        return True
    prefix_len = min(14, len(short))
    if prefix_len >= 6 and short[:prefix_len] in long_:
        return True
    return False


def format_unix_iso(ts: Any) -> str:
    """将秒级或毫秒级时间戳安全转为 UTC ISO 字符串"""
    if ts is None or ts == "":
        return ""
    if isinstance(ts, str):
        s = ts.strip()
        if not s:
            return ""
        if not s.isdigit():
            return s
        ts = int(s)
    try:
        val = float(ts)
        if val <= 0:
            return ""
        if val > 1e12:
            val = val / 1000.0
        return datetime.fromtimestamp(val, tz=timezone.utc).isoformat()
    except Exception:
        return ""


async def human_type(page, text: str) -> None:
    """模拟真人在输入框逐字输入，降低平台异常检测概率"""
    cleaned = str(text or "").strip()
    if not cleaned:
        return
    delay = random.randint(25, 55)
    await page.keyboard.type(cleaned, delay=delay)


async def save_diag_screenshot(page, tag: str) -> str:
    """出错时保存诊断截图到 sau-engine/logs（不含任何 Cookie 信息）"""
    try:
        log_dir = Path(BASE_DIR / "logs")
        log_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        safe_tag = re.sub(r"[^a-zA-Z0-9_\-]", "_", tag)[:40]
        target = log_dir / f"comment_diag_{safe_tag}_{stamp}.png"
        await page.screenshot(path=str(target))
        return str(target)
    except Exception:
        return ""


def make_result(ok: bool, message: str = "", **extra: Any) -> dict[str, Any]:
    """构建统一返回结构"""
    payload: dict[str, Any] = {"ok": bool(ok), "message": message}
    payload.update(extra)
    return payload
