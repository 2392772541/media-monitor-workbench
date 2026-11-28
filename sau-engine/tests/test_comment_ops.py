# -*- coding: utf-8 -*-
"""评论托管底层模块单元测试（不触碰公网账号与真实发送）"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

import sau_backend
from comment_ops.base import format_unix_iso, normalize_match_text, titles_match
from comment_ops.douyin import _parse_douyin_comment, _parse_douyin_item
from comment_ops.kuaishou import _flatten_ks_comments, _parse_ks_photo
from comment_ops.registry import get_comment_platform_capabilities, post_creator_comment, reply_to_comment, sync_account_comments


def test_title_matching_ignores_hashtags_and_punctuation():
    pub_title = "AI学得越晚越占便宜？其实藏着大陷阱"
    platform_title = "AI学得越晚越占便宜？其实藏着大陷阱 很多人拿“AI越晚学越好”当理由 #AI学习 #人工智能"
    assert titles_match(platform_title, pub_title) is True
    assert titles_match("完全无关的另一条视频标题", pub_title) is False
    assert normalize_match_text("测试！#标签 123") == "测试123"
    assert format_unix_iso(1795865804).startswith("2026-")
    assert format_unix_iso(1795866413963).startswith("2026-")


def test_douyin_item_and_comment_parsers():
    item = _parse_douyin_item(
        {
            "item_id_plain": "7713184771119123738",
            "title": "测试抖音标题",
            "comment_count": 2,
            "anchor_user_id": "1920218263454848",
            "create_time": 1795865804,
        }
    )
    assert item["video_id"] == "7713184771119123738"
    assert item["comment_count"] == 2
    assert item["video_url"].endswith("7713184771119123738")

    fan_comment = _parse_douyin_comment(
        {
            "cid": "c1",
            "text": "这个观点挺有启发",
            "digg_count": 3,
            "create_time": 1795866853,
            "reply_comment_total": 1,
            "user": {"uid": "999", "nickname": "热心粉丝"},
        },
        video_id="7713184771119123738",
        video_title="测试抖音标题",
        creator_uid="1920218263454848",
    )
    assert fan_comment["is_author"] is False
    assert fan_comment["author_name"] == "热心粉丝"

    author_comment = _parse_douyin_comment(
        {
            "cid": "c2",
            "text": "谢谢认可，大家平时怎么用？",
            "user": {"uid": "1920218263454848", "nickname": "野生变量"},
        },
        video_id="7713184771119123738",
        video_title="测试抖音标题",
        creator_uid="1920218263454848",
    )
    assert author_comment["is_author"] is True


def test_kuaishou_parsers_and_author_reply_detection():
    photo = _parse_ks_photo(
        {
            "workId": "3x3tb9b5wfvpnxg",
            "title": "快手作品标题",
            "commentCount": 1,
            "uploadTime": 1795866413963,
            "userIdStr": "u100",
            "userName": "野生变量",
        }
    )
    assert photo["video_id"] == "3x3tb9b5wfvpnxg"
    assert photo["creator_uid"] == "u100"

    flattened = _flatten_ks_comments(
        [
            {
                "commentId": "kc1",
                "authorId": "fan1",
                "authorName": "老铁A",
                "content": "请问用哪个工具？",
                "subComments": [
                    {
                        "commentId": "kc2",
                        "authorId": "u100",
                        "authorName": "野生变量",
                        "content": "我用的是本地工作台",
                    }
                ],
            }
        ],
        video_id="3x3tb9b5wfvpnxg",
        video_title="快手作品标题",
        creator_uid="u100",
        creator_name="野生变量",
    )
    assert len(flattened) == 2
    assert flattened[0]["has_author_reply"] is True
    assert flattened[1]["is_author"] is True


def test_reserved_platforms_xhs_and_tencent_return_clean_reserved_status():
    for ptype in (1, 2):
        res_sync = sync_account_comments(platform_type=ptype)
        assert res_sync["ok"] is False
        assert res_sync["reserved"] is True

        res_post = post_creator_comment(platform_type=ptype, comment_text="测试暖评")
        assert res_post["ok"] is False
        assert res_post["reserved"] is True

        res_reply = reply_to_comment(platform_type=ptype, comment_text="原评论", reply_text="回复")
        assert res_reply["ok"] is False
        assert res_reply["reserved"] is True


def test_flask_comment_routes_validation_and_capabilities(monkeypatch, tmp_path):
    # 隔离临时数据库，确保不读真实 Cookie 路径
    (tmp_path / "db").mkdir(parents=True)
    (tmp_path / "cookiesFile").mkdir(parents=True)
    db_file = tmp_path / "db" / "database.db"
    with sqlite3.connect(db_file) as conn:
        conn.execute(
            "CREATE TABLE user_info (id INTEGER PRIMARY KEY AUTOINCREMENT, type INTEGER, filePath TEXT, userName TEXT, status INTEGER)"
        )
        conn.execute("INSERT INTO user_info (type, filePath, userName, status) VALUES (3, 'secret_cookie.json', '主号', 1)")
        conn.commit()

    monkeypatch.setattr("comment_ops.registry.BASE_DIR", tmp_path)
    monkeypatch.setattr("sau_backend.BASE_DIR", tmp_path)

    caps = get_comment_platform_capabilities()
    assert len(caps) == 4
    dy = next(c for c in caps if c["platformType"] == 3)
    assert dy["supported"] is True
    assert dy["hasValidAccount"] is True
    # 严禁泄露任何 Cookie 文件名
    assert "secret_cookie.json" not in str(caps)

    client = sau_backend.app.test_client()
    resp = client.get("/comments/capabilities")
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["code"] == 200
    assert "secret_cookie.json" not in str(body)

    bad_post = client.post("/comments/post", json={"type": 3, "commentText": "   "})
    assert bad_post.status_code == 400

    bad_reply = client.post("/comments/reply", json={"type": 3, "commentText": "", "replyText": "你好"})
    assert bad_reply.status_code == 400

    # 校验受控 stub 转发
    monkeypatch.setattr(
        sau_backend,
        "post_creator_comment",
        lambda **kw: {"ok": True, "message": "dry_ok", "dry_run": kw.get("dry_run"), "platform_type": kw.get("platform_type")},
    )
    ok_post = client.post("/comments/post", json={"type": 3, "videoTitle": "测试", "commentText": "你怎么看？", "dryRun": True})
    assert ok_post.status_code == 200
    assert ok_post.get_json()["data"]["dry_run"] is True
