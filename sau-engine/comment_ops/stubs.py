# -*- coding: utf-8 -*-
"""小红书（1）与微信视频号（2）评论托管预留适配器：扫码绑定后平滑扩展"""

from __future__ import annotations

from typing import Any

from comment_ops.base import PLATFORM_CAPABILITIES, make_result


async def reserved_sync(platform_type: int, **_kwargs: Any) -> dict[str, Any]:
    meta = PLATFORM_CAPABILITIES.get(platform_type, {"name": f"平台({platform_type})"})
    return make_result(
        False,
        f"{meta['name']}评论托管已预留接口位；先完成扫码登录并开启对应适配器后即可自动巡检",
        platform_type=platform_type,
        reserved=True,
        videos=[],
        comments=[],
    )


async def reserved_post(platform_type: int, **_kwargs: Any) -> dict[str, Any]:
    meta = PLATFORM_CAPABILITIES.get(platform_type, {"name": f"平台({platform_type})"})
    return make_result(
        False,
        f"{meta['name']}暖场评论通道已预留，当前优先支持抖音与快手",
        platform_type=platform_type,
        reserved=True,
    )


async def reserved_reply(platform_type: int, **_kwargs: Any) -> dict[str, Any]:
    meta = PLATFORM_CAPABILITIES.get(platform_type, {"name": f"平台({platform_type})"})
    return make_result(
        False,
        f"{meta['name']}粉丝回复通道已预留，当前优先支持抖音与快手",
        platform_type=platform_type,
        reserved=True,
    )
