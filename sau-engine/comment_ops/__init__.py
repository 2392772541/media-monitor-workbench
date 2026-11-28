# -*- coding: utf-8 -*-
"""创作者自有视频评论管理与自动互动模块（支持抖音/快手实操，预留小红书/微信视频号扩展位）"""

from comment_ops.registry import (
    get_comment_platform_capabilities,
    post_creator_comment,
    reply_to_comment,
    sync_account_comments,
)

__all__ = [
    "get_comment_platform_capabilities",
    "sync_account_comments",
    "post_creator_comment",
    "reply_to_comment",
]
