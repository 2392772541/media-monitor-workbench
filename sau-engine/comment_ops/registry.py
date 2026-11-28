# -*- coding: utf-8 -*-
"""多平台评论互动统一路由、按平台串行互斥锁与账号凭证解析（绝不向外部泄露 Cookie 路径）"""

from __future__ import annotations

import asyncio
import sqlite3
import threading
from pathlib import Path
from typing import Any

from conf import BASE_DIR
from comment_ops.base import PLATFORM_CAPABILITIES, make_result
from comment_ops.douyin import (
    post_douyin_creator_comment,
    reply_douyin_comment,
    sync_douyin_comments,
)
from comment_ops.kuaishou import (
    post_kuaishou_creator_comment,
    reply_kuaishou_comment,
    sync_kuaishou_comments,
)
from comment_ops.stubs import reserved_post, reserved_reply, reserved_sync

# 按平台维度加锁，避免同一账号并发起多个浏览器实例互相踩登录态
_PLATFORM_LOCKS: dict[int, threading.Lock] = {
    1: threading.Lock(),
    2: threading.Lock(),
    3: threading.Lock(),
    4: threading.Lock(),
    5: threading.Lock(),
}


def _run_coro(coro):
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def _resolve_account_cookie(platform_type: int, account_name: str = "") -> tuple[dict[str, Any] | None, str]:
    """根据平台类型（及可选账号昵称）从本地 user_info 解析有效登录凭证文件路径（仅内部使用）"""
    db_path = Path(BASE_DIR / "db" / "database.db")
    if not db_path.exists():
        return None, "尚未初始化发布账号数据库"

    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT id, type, filePath, userName, status FROM user_info WHERE type = ? ORDER BY status DESC, id ASC",
            (int(platform_type),),
        ).fetchall()

    if not rows:
        meta = PLATFORM_CAPABILITIES.get(int(platform_type), {"name": f"平台({platform_type})"})
        return None, f"尚未绑定{meta['name']}创作者账号，请先前往「视频发布 → 账号管理」扫码"

    chosen = None
    if account_name:
        for r in rows:
            if str(r["userName"] or "").strip() == account_name.strip():
                chosen = r
                break
    if chosen is None:
        chosen = rows[0]

    cookie_full = (Path(BASE_DIR / "cookiesFile") / str(chosen["filePath"])).resolve()
    cookies_root = Path(BASE_DIR / "cookiesFile").resolve()
    if not cookie_full.is_relative_to(cookies_root) or not cookie_full.exists():
        return None, "该账号登录凭证文件缺失，请重新扫码绑定"

    return {
        "id": int(chosen["id"]),
        "platform_type": int(chosen["type"]),
        "account_name": str(chosen["userName"] or ""),
        "status": int(chosen["status"] or 0),
        "_cookie_path": str(cookie_full),
    }, ""


def get_comment_platform_capabilities() -> list[dict[str, Any]]:
    """返回各平台评论托管支持度及当前账号绑定状态（不含任何敏感文件路径）"""
    db_path = Path(BASE_DIR / "db" / "database.db")
    counts: dict[int, list[dict[str, Any]]] = {}
    if db_path.exists():
        with sqlite3.connect(db_path) as conn:
            rows = conn.execute(
                "SELECT id, type, userName, status FROM user_info ORDER BY status DESC, id ASC"
            ).fetchall()
            for uid, ptype, uname, status in rows:
                counts.setdefault(int(ptype), []).append(
                    {"id": int(uid), "accountName": str(uname or ""), "valid": int(status or 0) == 1}
                )

    result = []
    for ptype in (3, 4, 1, 2):
        cap = dict(PLATFORM_CAPABILITIES[ptype])
        bound = counts.get(ptype, [])
        cap["accounts"] = bound
        cap["hasAccount"] = len(bound) > 0
        cap["hasValidAccount"] = any(a["valid"] for a in bound)
        result.append(cap)
    return result


def sync_account_comments(
    platform_type: int,
    account_name: str = "",
    max_videos: int = 20,
    only_video_id: str = "",
) -> dict[str, Any]:
    ptype = int(platform_type)
    if ptype not in PLATFORM_CAPABILITIES:
        return make_result(False, f"不支持的平台类型: {ptype}", platform_type=ptype)
    if PLATFORM_CAPABILITIES[ptype].get("reserved"):
        return _run_coro(reserved_sync(ptype))

    acc, err = _resolve_account_cookie(ptype, account_name)
    if not acc:
        return make_result(False, err, platform_type=ptype, auth_required=True, videos=[], comments=[])

    lock = _PLATFORM_LOCKS.setdefault(ptype, threading.Lock())
    with lock:
        if ptype == 3:
            res = _run_coro(sync_douyin_comments(acc["_cookie_path"], max_videos=max_videos, only_video_id=only_video_id))
        elif ptype == 4:
            res = _run_coro(sync_kuaishou_comments(acc["_cookie_path"], max_videos=max_videos, only_video_id=only_video_id))
        else:
            res = _run_coro(reserved_sync(ptype))
    res["account_name"] = acc["account_name"]
    return res


def post_creator_comment(
    platform_type: int,
    account_name: str = "",
    video_id: str = "",
    video_title: str = "",
    comment_text: str = "",
    dry_run: bool = False,
) -> dict[str, Any]:
    ptype = int(platform_type)
    if ptype not in PLATFORM_CAPABILITIES:
        return make_result(False, f"不支持的平台类型: {ptype}", platform_type=ptype)
    if PLATFORM_CAPABILITIES[ptype].get("reserved"):
        return _run_coro(reserved_post(ptype))

    acc, err = _resolve_account_cookie(ptype, account_name)
    if not acc:
        return make_result(False, err, platform_type=ptype, auth_required=True)

    lock = _PLATFORM_LOCKS.setdefault(ptype, threading.Lock())
    with lock:
        if ptype == 3:
            res = _run_coro(
                post_douyin_creator_comment(
                    acc["_cookie_path"],
                    video_id=video_id,
                    video_title=video_title,
                    comment_text=comment_text,
                    dry_run=dry_run,
                )
            )
        elif ptype == 4:
            res = _run_coro(
                post_kuaishou_creator_comment(
                    acc["_cookie_path"],
                    video_id=video_id,
                    video_title=video_title,
                    comment_text=comment_text,
                    dry_run=dry_run,
                )
            )
        else:
            res = _run_coro(reserved_post(ptype))
    res["account_name"] = acc["account_name"]
    return res


def reply_to_comment(
    platform_type: int,
    account_name: str = "",
    video_id: str = "",
    video_title: str = "",
    comment_id: str = "",
    comment_text: str = "",
    author_name: str = "",
    reply_text: str = "",
    dry_run: bool = False,
) -> dict[str, Any]:
    ptype = int(platform_type)
    if ptype not in PLATFORM_CAPABILITIES:
        return make_result(False, f"不支持的平台类型: {ptype}", platform_type=ptype)
    if PLATFORM_CAPABILITIES[ptype].get("reserved"):
        return _run_coro(reserved_reply(ptype))

    acc, err = _resolve_account_cookie(ptype, account_name)
    if not acc:
        return make_result(False, err, platform_type=ptype, auth_required=True)

    lock = _PLATFORM_LOCKS.setdefault(ptype, threading.Lock())
    with lock:
        if ptype == 3:
            res = _run_coro(
                reply_douyin_comment(
                    acc["_cookie_path"],
                    video_id=video_id,
                    video_title=video_title,
                    comment_id=comment_id,
                    comment_text=comment_text,
                    author_name=author_name,
                    reply_text=reply_text,
                    dry_run=dry_run,
                )
            )
        elif ptype == 4:
            res = _run_coro(
                reply_kuaishou_comment(
                    acc["_cookie_path"],
                    video_id=video_id,
                    video_title=video_title,
                    comment_id=comment_id,
                    comment_text=comment_text,
                    author_name=author_name,
                    reply_text=reply_text,
                    dry_run=dry_run,
                )
            )
        else:
            res = _run_coro(reserved_reply(ptype))
    res["account_name"] = acc["account_name"]
    return res
