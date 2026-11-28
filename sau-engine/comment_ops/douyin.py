# -*- coding: utf-8 -*-
"""抖音创作者中心评论管理适配器（仅操作用户已登录的 본인 创作者账号及自有作品）"""

from __future__ import annotations

import asyncio
import os
import re
from typing import Any

from patchright.async_api import Page, async_playwright

from comment_ops.base import (
    build_launch_kwargs,
    create_authenticated_context,
    format_unix_iso,
    human_type,
    make_result,
    normalize_match_text,
    save_diag_screenshot,
    titles_match,
)

DOUYIN_COMMENT_URL = "https://creator.douyin.com/creator-micro/interactive/comment"


async def _is_login_required(page: Page) -> bool:
    url = (page.url or "").lower()
    if "login" in url or "passport" in url:
        return True
    for marker_text in ("扫码登录", "手机号登录"):
        try:
            loc = page.get_by_text(marker_text, exact=False).first
            if await loc.count() and await loc.is_visible():
                return True
        except Exception:
            continue
    return False


async def _dismiss_douyin_guides(page: Page) -> None:
    """关闭抖音创作者后台偶发的新功能气泡引导（如“知道了”）"""
    for txt in ("知道了", "我知道了"):
        try:
            btn = page.get_by_role("button", name=txt).first
            if await btn.count() and await btn.is_visible():
                await btn.click()
                await page.wait_for_timeout(300)
        except Exception:
            pass


def _parse_douyin_item(item: dict[str, Any]) -> dict[str, Any]:
    vid = str(item.get("item_id_plain") or item.get("aweme_id") or item.get("id") or "").strip()
    title = str(item.get("title") or item.get("desc") or item.get("description") or "").strip()
    cover = str(item.get("cover_image_url") or "").strip()
    if not cover and isinstance(item.get("cover"), dict):
        urls = item["cover"].get("url_list") or []
        if urls:
            cover = str(urls[0])
    create_time = item.get("create_time")
    published_at = format_unix_iso(create_time) if isinstance(create_time, (int, float)) else str(create_time or "")
    metrics = item.get("metrics") if isinstance(item.get("metrics"), dict) else {}
    comment_count = int(item.get("comment_count") or metrics.get("comment_count") or 0)
    like_count = int(item.get("like_count") or metrics.get("like_count") or 0)
    play_count = int(item.get("play_count") or metrics.get("play_count") or 0)
    return {
        "video_id": vid,
        "item_id_enc": str(item.get("item_id") or ""),
        "title": title,
        "cover_url": cover,
        "published_at": published_at,
        "comment_count": comment_count,
        "like_count": like_count,
        "play_count": play_count,
        "video_url": str(item.get("item_link") or (f"https://www.douyin.com/video/{vid}" if vid else "")),
        "anchor_user_id": str(item.get("anchor_user_id") or item.get("user_id") or ""),
    }


def _parse_douyin_comment(
    raw: dict[str, Any],
    video_id: str,
    video_title: str,
    creator_uid: str,
    parent_comment_id: str = "",
) -> dict[str, Any]:
    user = raw.get("user") if isinstance(raw.get("user"), dict) else {}
    author_uid = str(user.get("uid") or "").strip()
    author_name = str(user.get("nickname") or "抖音用户").strip()
    cid = str(raw.get("cid") or "").strip()
    text = str(raw.get("text") or "").strip()
    reply_id = str(raw.get("reply_id") or "0")
    effective_parent = parent_comment_id or ("" if reply_id in ("", "0") else reply_id)
    is_author = bool(creator_uid and author_uid and author_uid == creator_uid)
    return {
        "video_id": video_id,
        "video_title": video_title,
        "comment_id": cid,
        "parent_comment_id": effective_parent,
        "author_uid": author_uid,
        "author_name": author_name,
        "text": text,
        "like_count": int(raw.get("digg_count") or 0),
        "created_at": format_unix_iso(raw.get("create_time")),
        "is_author": is_author,
        "has_author_reply": False,
        "reply_count": int(raw.get("reply_comment_total") or 0),
    }


async def _fetch_douyin_comments_via_page(
    page: Page,
    video_id: str,
    video_title: str,
    creator_uid: str,
    initial_comments: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """在已登录创作者中心页面上下文内拉取指定作品的一级评论与二级追评"""
    raw_top: list[dict[str, Any]] = list(initial_comments or [])
    if not raw_top:
        try:
            resp = await page.evaluate(
                """async (awemeId) => {
                    const url = `/web/api/third_party/aweme/api/comment/read/aweme/v1/web/comment/list/select/?aweme_id=${encodeURIComponent(awemeId)}&cursor=0&count=20&comment_select_options=0&sort_options=0&channel_id=618&app_id=2906&aid=2906&device_platform=webapp`;
                    const r = await fetch(url, { credentials: 'include' });
                    if (!r.ok) return null;
                    return await r.json();
                }""",
                video_id,
            )
            if isinstance(resp, dict) and resp.get("status_code") == 0:
                raw_top = resp.get("comments") or []
        except Exception:
            raw_top = []

    parsed_all: list[dict[str, Any]] = []
    for c in raw_top:
        if not isinstance(c, dict) or not c.get("cid"):
            continue
        top_item = _parse_douyin_comment(c, video_id, video_title, creator_uid)
        reply_total = top_item["reply_count"]
        sub_items: list[dict[str, Any]] = []

        if reply_total > 0:
            try:
                sub_resp = await page.evaluate(
                    """async ({ cid, awemeId }) => {
                        const url = `/web/api/third_party/aweme/api/comment/read/aweme/v1/web/comment/list/reply/?comment_id=${encodeURIComponent(cid)}&item_id=${encodeURIComponent(awemeId)}&cursor=0&count=20&app_id=2906&aid=2906&device_platform=webapp`;
                        const r = await fetch(url, { credentials: 'include' });
                        if (!r.ok) return null;
                        return await r.json();
                    }""",
                    {"cid": top_item["comment_id"], "awemeId": video_id},
                )
                if isinstance(sub_resp, dict) and sub_resp.get("status_code") == 0:
                    for sc in sub_resp.get("comments") or []:
                        if isinstance(sc, dict) and sc.get("cid"):
                            sub_items.append(
                                _parse_douyin_comment(
                                    sc,
                                    video_id,
                                    video_title,
                                    creator_uid,
                                    parent_comment_id=top_item["comment_id"],
                                )
                            )
            except Exception:
                pass

        # 判断作者是否已回复过该一级评论（若之后没有新粉丝追评，标记 has_author_reply=True 防止重复回复）
        if sub_items:
            author_replied = any(s["is_author"] for s in sub_items)
            if author_replied:
                top_item["has_author_reply"] = True
            # 若最后一条已经是作者回复，则其之前的粉丝二级追评也标记已覆盖
            last_author_idx = -1
            for idx, s in enumerate(sub_items):
                if s["is_author"]:
                    last_author_idx = idx
            if last_author_idx >= 0:
                for idx in range(last_author_idx):
                    sub_items[idx]["has_author_reply"] = True

        parsed_all.append(top_item)
        parsed_all.extend(sub_items)

    return parsed_all


async def _select_douyin_video(
    page: Page,
    video_id: str,
    video_title: str,
    loaded_items: list[dict[str, Any]],
    current_video_id: str,
) -> tuple[bool, str, str]:
    """在抖音评论管理页切换到指定作品，返回 (成功与否, 匹配到的 video_id, 匹配到的标题)"""
    # 1. 先检查当前默认选中的作品是否就是目标
    first_item = loaded_items[0] if loaded_items else None
    if current_video_id and video_id and current_video_id == video_id:
        return True, current_video_id, first_item["title"] if first_item else video_title
    if not video_id and not video_title and first_item:
        return True, first_item["video_id"], first_item["title"]
    if first_item and video_title and titles_match(first_item["title"], video_title):
        return True, first_item["video_id"], first_item["title"]

    # 2. 如果传了 video_id，从已拉取作品列表补全标题用于弹窗匹配
    target_title = video_title
    if video_id and not target_title:
        for it in loaded_items:
            if it["video_id"] == video_id:
                target_title = it["title"]
                break

    # 3. 打开右侧「选择作品」抽屉
    pick_btn = page.get_by_role("button", name="选择作品").first
    if not await pick_btn.count():
        pick_btn = page.locator("button").filter(has_text="选择作品").first
    if not await pick_btn.count():
        return False, "", ""

    await pick_btn.click()
    await page.wait_for_timeout(1500)

    drawer = page.locator('[class*="sidesheet"], [class*="drawer"]').filter(has_text="选择作品").first
    if not await drawer.count():
        drawer = page.locator('[role="dialog"]').first

    # 如果有目标标题，用抽屉内搜索框快速定位
    search_snippet = ""
    if target_title:
        clean_for_search = re.sub(r"#[^\s#]+", "", target_title).strip()
        search_snippet = clean_for_search[:14].strip()

    if search_snippet:
        search_input = drawer.locator('input[placeholder*="搜索作品"]').first
        if await search_input.count():
            await search_input.click()
            await search_input.fill(search_snippet)
            await page.keyboard.press("Enter")
            await page.wait_for_timeout(1800)

    # 在抽屉里寻找匹配作品卡片并点击
    matched_idx = await page.evaluate(
        """({ targetTitle }) => {
            const norm = (s) => (s || '')
                .replace(/#[^\\s#]+/g, '')
                .replace(/[\\s\\u3000.,，。！？!?：:；;、“”"'‘’（）()【】\\[\\]《》<>·—\\-_]+/g, '')
                .toLowerCase();
            const targetNorm = norm(targetTitle);
            const drawer = document.querySelector('[class*="sidesheet-inner"], [class*="drawer-"]');
            if (!drawer) return -1;
            const candidates = Array.from(drawer.querySelectorAll('div'))
                .filter(el => {
                    const txt = (el.innerText || '').trim();
                    const rect = el.getBoundingClientRect();
                    return rect.width > 200 && rect.height >= 60 && rect.height <= 220 && txt.includes('发布于');
                });
            // 优先取最小包围卡片（叶子候选）
            const cards = candidates.filter(el => !candidates.some(other => other !== el && el.contains(other)));
            if (!cards.length) return -1;
            if (!targetNorm) {
                cards[0].setAttribute('data-mmw-target-video', '1');
                return 0;
            }
            for (let i = 0; i < cards.length; i++) {
                const cNorm = norm(cards[i].innerText);
                const short = cNorm.length <= targetNorm.length ? cNorm : targetNorm;
                const longStr = cNorm.length <= targetNorm.length ? targetNorm : cNorm;
                const prefix = short.slice(0, Math.min(12, short.length));
                if (prefix.length >= 4 && longStr.includes(prefix)) {
                    cards[i].setAttribute('data-mmw-target-video', '1');
                    return i;
                }
            }
            return -1;
        }""",
        {"targetTitle": target_title},
    )

    if matched_idx < 0:
        # 找不到时若明确传了 video_id 匹配第一条则兜底，否则失败关闭抽屉
        try:
            await page.keyboard.press("Escape")
        except Exception:
            pass
        return False, "", ""

    selected_id = video_id
    selected_title = target_title

    def _on_select_resp(resp):
        nonlocal selected_id
        if "comment/list/select" in resp.url:
            m = re.search(r"aweme_id=(\d+)", resp.url)
            if m:
                selected_id = m.group(1)

    page.on("response", _on_select_resp)
    try:
        card = page.locator('[data-mmw-target-video="1"]').first
        await card.click()
        await page.wait_for_timeout(2800)
    finally:
        page.remove_listener("response", _on_select_resp)

    return True, selected_id or (first_item["video_id"] if first_item else ""), selected_title


async def sync_douyin_comments(
    cookie_path: str,
    max_videos: int = 20,
    only_video_id: str = "",
) -> dict[str, Any]:
    """同步抖音创作者账号下已发布作品列表及最新评论（含二级回复）"""
    if not cookie_path or not os.path.exists(cookie_path):
        return make_result(False, "未找到抖音账号登录文件，请先在视频发布页扫码登录", auth_required=True)

    creator_uid = ""
    creator_name = ""
    captured_items: list[dict[str, Any]] = []
    initial_comments_by_vid: dict[str, list[dict[str, Any]]] = {}

    async with async_playwright() as p:
        browser = await p.chromium.launch(**build_launch_kwargs(headless=True))
        try:
            context = await create_authenticated_context(browser, cookie_path)
            page = await context.new_page()

            async def on_resp(resp):
                nonlocal creator_uid, creator_name
                url = resp.url
                try:
                    if "/aweme/v1/creator/user/info/" in url:
                        data = await resp.json()
                        profile = data.get("user_profile") or data.get("douyin_user_verify_info") or {}
                        if profile.get("nick_name"):
                            creator_name = str(profile["nick_name"])
                    elif "/aweme/v1/creator/pc/user/info/" in url:
                        data = await resp.json()
                        if data.get("uid"):
                            creator_uid = str(data["uid"])
                    elif "/aweme/v1/creator/item/list" in url:
                        data = await resp.json()
                        for raw_it in data.get("item_info_list") or []:
                            parsed = _parse_douyin_item(raw_it)
                            if parsed["video_id"] and not any(x["video_id"] == parsed["video_id"] for x in captured_items):
                                captured_items.append(parsed)
                                if not creator_uid and parsed["anchor_user_id"]:
                                    creator_uid = parsed["anchor_user_id"]
                    elif "comment/list/select/" in url:
                        data = await resp.json()
                        if data.get("status_code") == 0:
                            m = re.search(r"aweme_id=(\d+)", url)
                            if m:
                                initial_comments_by_vid[m.group(1)] = data.get("comments") or []
                except Exception:
                    pass

            page.on("response", on_resp)

            await page.goto(DOUYIN_COMMENT_URL, wait_until="domcontentloaded", timeout=28000)
            await page.wait_for_timeout(4500)
            await _dismiss_douyin_guides(page)

            if await _is_login_required(page):
                return make_result(False, "抖音创作者登录态已失效，请在「视频发布 → 账号管理」重新扫码", auth_required=True)

            # 如需拉取更多作品，在页面上下文继续分页拉取 item/list
            if len(captured_items) < max_videos:
                try:
                    extra = await page.evaluate(
                        """async (limit) => {
                            const items = [];
                            let cursor = '';
                            for (let pageNo = 0; pageNo < 4 && items.length < limit; pageNo++) {
                                const url = `/aweme/v1/creator/item/list/?cursor=${encodeURIComponent(cursor)}&count=20&aid=2906`;
                                const r = await fetch(url, { credentials: 'include' });
                                if (!r.ok) break;
                                const data = await r.json();
                                const lst = data.item_info_list || [];
                                items.push(...lst);
                                if (!data.has_more || !data.cursor) break;
                                cursor = String(data.cursor);
                            }
                            return items;
                        }""",
                        max_videos,
                    )
                    for raw_it in extra or []:
                        parsed = _parse_douyin_item(raw_it)
                        if parsed["video_id"] and not any(x["video_id"] == parsed["video_id"] for x in captured_items):
                            captured_items.append(parsed)
                            if not creator_uid and parsed["anchor_user_id"]:
                                creator_uid = parsed["anchor_user_id"]
                except Exception:
                    pass

            videos = captured_items[:max_videos]
            all_comments: list[dict[str, Any]] = []

            for v in videos:
                vid = v["video_id"]
                if only_video_id and vid != only_video_id:
                    continue
                if not only_video_id and v["comment_count"] <= 0 and vid not in initial_comments_by_vid:
                    continue
                v_comments = await _fetch_douyin_comments_via_page(
                    page,
                    video_id=vid,
                    video_title=v["title"],
                    creator_uid=creator_uid,
                    initial_comments=initial_comments_by_vid.get(vid),
                )
                all_comments.extend(v_comments)

            return make_result(
                True,
                f"抖音同步完成：获取 {len(videos)} 条已发作品，{len(all_comments)} 条评论",
                platform_type=3,
                creator_uid=creator_uid,
                creator_name=creator_name,
                videos=videos,
                comments=all_comments,
            )
        except Exception as exc:
            return make_result(False, f"抖音评论同步异常: {exc}", platform_type=3)
        finally:
            await browser.close()


async def post_douyin_creator_comment(
    cookie_path: str,
    video_id: str = "",
    video_title: str = "",
    comment_text: str = "",
    dry_run: bool = False,
) -> dict[str, Any]:
    """用自己的抖音创作者账号，在自己已发布的视频评论区发表暖场/讨论评论"""
    cleaned_text = str(comment_text or "").strip()
    if not cleaned_text:
        return make_result(False, "评论内容不能为空", platform_type=3)
    if not cookie_path or not os.path.exists(cookie_path):
        return make_result(False, "未找到抖音账号登录文件", auth_required=True, platform_type=3)

    captured_items: list[dict[str, Any]] = []
    current_vid = ""

    async with async_playwright() as p:
        browser = await p.chromium.launch(**build_launch_kwargs(headless=True))
        try:
            context = await create_authenticated_context(browser, cookie_path)
            page = await context.new_page()

            async def on_resp(resp):
                nonlocal current_vid
                url = resp.url
                try:
                    if "/aweme/v1/creator/item/list" in url:
                        data = await resp.json()
                        for raw_it in data.get("item_info_list") or []:
                            parsed = _parse_douyin_item(raw_it)
                            if parsed["video_id"] and not any(x["video_id"] == parsed["video_id"] for x in captured_items):
                                captured_items.append(parsed)
                    elif "comment/list/select/" in url:
                        m = re.search(r"aweme_id=(\d+)", url)
                        if m:
                            current_vid = m.group(1)
                except Exception:
                    pass

            page.on("response", on_resp)
            await page.goto(DOUYIN_COMMENT_URL, wait_until="domcontentloaded", timeout=28000)
            await page.wait_for_timeout(4500)
            await _dismiss_douyin_guides(page)

            if await _is_login_required(page):
                return make_result(False, "抖音创作者登录态已失效，请重新扫码", auth_required=True, platform_type=3)

            ok_sel, matched_vid, matched_title = await _select_douyin_video(
                page,
                video_id=video_id,
                video_title=video_title,
                loaded_items=captured_items,
                current_video_id=current_vid,
            )
            if not ok_sel:
                shot = await save_diag_screenshot(page, "dy_post_select_fail")
                return make_result(
                    False,
                    f"未在抖音创作者后台找到目标作品（可能仍在审核转码中，稍后将自动重试）",
                    platform_type=3,
                    retryable=True,
                    diag_screenshot=shot,
                )

            # 定位顶部作者评论输入框（区别于回复粉丝的内联输入框）
            composer = page.locator('[placeholder*="有爱评论"]').first
            if not await composer.count() or not await composer.is_visible():
                shot = await save_diag_screenshot(page, "dy_post_no_input")
                return make_result(False, "未找到抖音评论输入框", platform_type=3, diag_screenshot=shot)

            send_btn = page.locator("button").filter(has_text="发送").first
            if not await send_btn.count() or not await send_btn.is_visible():
                shot = await save_diag_screenshot(page, "dy_post_no_send")
                return make_result(False, "未找到抖音评论发送按钮", platform_type=3, diag_screenshot=shot)

            if dry_run:
                return make_result(
                    True,
                    "抖音暖评通道预检通过（dry_run 未真实发送）",
                    platform_type=3,
                    dry_run=True,
                    video_id=matched_vid,
                    video_title=matched_title,
                )

            publish_ack: dict[str, Any] = {}

            async def on_publish_resp(resp):
                if resp.request.method == "POST" and "comment" in resp.url and any(
                    k in resp.url for k in ("publish", "reply", "create")
                ):
                    try:
                        publish_ack["status"] = resp.status
                        publish_ack["data"] = await resp.json()
                    except Exception:
                        publish_ack["status"] = resp.status

            page.on("response", on_publish_resp)
            await composer.click()
            await page.wait_for_timeout(300)
            await human_type(page, cleaned_text)
            await page.wait_for_timeout(700)

            await send_btn.click()
            for _ in range(16):
                if publish_ack:
                    break
                await page.wait_for_timeout(500)

            data = publish_ack.get("data")
            if isinstance(data, dict):
                sc = data.get("status_code")
                if sc is not None and sc != 0:
                    shot = await save_diag_screenshot(page, "dy_post_rejected")
                    return make_result(
                        False,
                        f"抖音评论提交被拒: {data.get('status_msg') or f'status_code={sc}'}",
                        platform_type=3,
                        diag_screenshot=shot,
                    )
                cid = str((data.get("comment") or {}).get("cid") or data.get("cid") or "")
                return make_result(
                    True,
                    "抖音暖场评论发送成功",
                    platform_type=3,
                    video_id=matched_vid,
                    video_title=matched_title,
                    posted_comment_id=cid,
                )

            # 无明确报错且输入框已清空也视作成功
            remaining = (await composer.inner_text()).strip()
            if not remaining:
                return make_result(
                    True,
                    "抖音暖场评论已提交",
                    platform_type=3,
                    video_id=matched_vid,
                    video_title=matched_title,
                )

            shot = await save_diag_screenshot(page, "dy_post_uncertain")
            return make_result(False, "抖音评论发送超时，未收到平台确认回执", platform_type=3, diag_screenshot=shot)
        except Exception as exc:
            return make_result(False, f"抖音发表暖场评论失败: {exc}", platform_type=3)
        finally:
            await browser.close()


async def reply_douyin_comment(
    cookie_path: str,
    video_id: str = "",
    video_title: str = "",
    comment_id: str = "",
    comment_text: str = "",
    author_name: str = "",
    reply_text: str = "",
    dry_run: bool = False,
) -> dict[str, Any]:
    """用自己的抖音创作者账号回复指定粉丝评论"""
    cleaned_reply = str(reply_text or "").strip()
    if not cleaned_reply:
        return make_result(False, "回复内容不能为空", platform_type=3)
    if not cookie_path or not os.path.exists(cookie_path):
        return make_result(False, "未找到抖音账号登录文件", auth_required=True, platform_type=3)

    captured_items: list[dict[str, Any]] = []
    current_vid = ""

    async with async_playwright() as p:
        browser = await p.chromium.launch(**build_launch_kwargs(headless=True))
        try:
            context = await create_authenticated_context(browser, cookie_path)
            page = await context.new_page()

            async def on_resp(resp):
                nonlocal current_vid
                url = resp.url
                try:
                    if "/aweme/v1/creator/item/list" in url:
                        data = await resp.json()
                        for raw_it in data.get("item_info_list") or []:
                            parsed = _parse_douyin_item(raw_it)
                            if parsed["video_id"] and not any(x["video_id"] == parsed["video_id"] for x in captured_items):
                                captured_items.append(parsed)
                    elif "comment/list/select/" in url:
                        m = re.search(r"aweme_id=(\d+)", url)
                        if m:
                            current_vid = m.group(1)
                except Exception:
                    pass

            page.on("response", on_resp)
            await page.goto(DOUYIN_COMMENT_URL, wait_until="domcontentloaded", timeout=28000)
            await page.wait_for_timeout(4500)
            await _dismiss_douyin_guides(page)

            if await _is_login_required(page):
                return make_result(False, "抖音创作者登录态已失效，请重新扫码", auth_required=True, platform_type=3)

            ok_sel, matched_vid, matched_title = await _select_douyin_video(
                page,
                video_id=video_id,
                video_title=video_title,
                loaded_items=captured_items,
                current_video_id=current_vid,
            )
            if not ok_sel:
                shot = await save_diag_screenshot(page, "dy_reply_select_fail")
                return make_result(False, "未在抖音评论管理中找到对应视频", platform_type=3, diag_screenshot=shot)

            # 若评论区较长，先尝试展开二级回复或关键词搜索定位该评论
            target_snippet = normalize_match_text(comment_text)[:20]

            async def _locate_and_click_reply_btn() -> bool:
                return bool(
                    await page.evaluate(
                        """({ targetText, targetAuthor }) => {
                            const norm = (s) => (s || '')
                                .replace(/[\\s\\u3000.,，。！？!?：:；;、“”"'‘’（）()【】\\[\\]《》<>·—\\-_]+/g, '')
                                .toLowerCase();
                            const tNorm = norm(targetText);
                            const aNorm = norm(targetAuthor);
                            const allReplyBtns = Array.from(document.querySelectorAll('span, div, button'))
                                .filter(el => el.offsetParent !== null && (el.innerText || '').trim() === '回复');
                            let bestBtn = null;
                            let bestScore = -1;
                            for (const btn of allReplyBtns) {
                                // 向上回溯 6 层找到单条评论容器
                                let node = btn.parentElement;
                                for (let step = 0; step < 6 && node; step++) {
                                    const txt = norm(node.innerText || '');
                                    if (tNorm && txt.includes(tNorm.slice(0, Math.min(14, tNorm.length)))) {
                                        let score = 10;
                                        if (aNorm && txt.includes(aNorm)) score += 5;
                                        // 越小容器越精准（区分一级和二级回复按钮）
                                        score += Math.max(0, 6 - step);
                                        if (score > bestScore) {
                                            bestScore = score;
                                            bestBtn = btn;
                                        }
                                        break;
                                    }
                                    node = node.parentElement;
                                }
                            }
                            if (bestBtn) {
                                bestBtn.scrollIntoView({ block: 'center' });
                                bestBtn.click();
                                return true;
                            }
                            return false;
                        }""",
                        {"targetText": comment_text, "targetAuthor": author_name},
                    )
                )

            clicked = await _locate_and_click_reply_btn()
            if not clicked:
                # 展开可见的「查看X条回复」再试一次（可能是二级追评）
                expands = await page.locator("text=/查看\\d+条回复/").all()
                for exp in expands[:6]:
                    try:
                        if await exp.is_visible():
                            await exp.click()
                            await page.wait_for_timeout(900)
                    except Exception:
                        pass
                clicked = await _locate_and_click_reply_btn()

            if not clicked and target_snippet:
                # 使用页内「搜索评论关键词」再试一次
                search_box = page.locator('input[placeholder*="搜索评论"]').first
                if await search_box.count() and await search_box.is_visible():
                    await search_box.fill(comment_text[:16].strip())
                    await page.keyboard.press("Enter")
                    await page.wait_for_timeout(1800)
                    clicked = await _locate_and_click_reply_btn()

            if not clicked:
                shot = await save_diag_screenshot(page, "dy_reply_comment_not_found")
                return make_result(
                    False,
                    "未在页面找到该粉丝评论（可能已被对方删除或折叠）",
                    platform_type=3,
                    diag_screenshot=shot,
                )

            await page.wait_for_timeout(900)
            reply_input = page.locator('[placeholder^="回复"]').first
            if not await reply_input.count() or not await reply_input.is_visible():
                shot = await save_diag_screenshot(page, "dy_reply_no_input")
                return make_result(False, "点击回复后未出现抖音回复输入框", platform_type=3, diag_screenshot=shot)

            # 精准定位与「取消」按钮并排的内联回复「发送」按钮（绝不误点顶部作者评论发送键）
            cancel_btn = page.locator("button").filter(has_text="取消").first
            inline_send_btn = cancel_btn.locator("xpath=following-sibling::button[contains(., '发送')]").first
            if not await inline_send_btn.count():
                inline_send_btn = page.locator("button").filter(has_text="发送").last

            if dry_run:
                try:
                    if await cancel_btn.count() and await cancel_btn.is_visible():
                        await cancel_btn.click()
                except Exception:
                    pass
                return make_result(
                    True,
                    "抖音粉丝回复通道预检通过（dry_run 未真实发送）",
                    platform_type=3,
                    dry_run=True,
                    video_id=matched_vid,
                    video_title=matched_title,
                    comment_id=comment_id,
                )

            reply_ack: dict[str, Any] = {}

            async def on_reply_resp(resp):
                if resp.request.method == "POST" and "comment" in resp.url and any(
                    k in resp.url for k in ("publish", "reply", "create")
                ):
                    try:
                        reply_ack["status"] = resp.status
                        reply_ack["data"] = await resp.json()
                    except Exception:
                        reply_ack["status"] = resp.status

            page.on("response", on_reply_resp)
            await reply_input.click()
            await page.wait_for_timeout(250)
            await human_type(page, cleaned_reply)
            await page.wait_for_timeout(700)
            await inline_send_btn.click()

            for _ in range(16):
                if reply_ack:
                    break
                await page.wait_for_timeout(500)

            data = reply_ack.get("data")
            if isinstance(data, dict):
                sc = data.get("status_code")
                if sc is not None and sc != 0:
                    shot = await save_diag_screenshot(page, "dy_reply_rejected")
                    return make_result(
                        False,
                        f"抖音回复被拒: {data.get('status_msg') or f'status_code={sc}'}",
                        platform_type=3,
                        diag_screenshot=shot,
                    )
                return make_result(
                    True,
                    "抖音粉丝评论回复成功",
                    platform_type=3,
                    video_id=matched_vid,
                    video_title=matched_title,
                    comment_id=comment_id,
                )

            if not await reply_input.is_visible():
                return make_result(
                    True,
                    "抖音粉丝评论回复已提交",
                    platform_type=3,
                    video_id=matched_vid,
                    video_title=matched_title,
                    comment_id=comment_id,
                )

            shot = await save_diag_screenshot(page, "dy_reply_uncertain")
            return make_result(False, "抖音回复发送超时，未收到平台确认回执", platform_type=3, diag_screenshot=shot)
        except Exception as exc:
            return make_result(False, f"抖音回复粉丝评论失败: {exc}", platform_type=3)
        finally:
            await browser.close()
