# -*- coding: utf-8 -*-
"""快手创作者服务平台评论管理适配器（仅操作用户已登录的创作者账号及自有作品）"""

from __future__ import annotations

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
    save_diag_screenshot,
    titles_match,
)

KUAISHOU_COMMENT_URL = "https://cp.kuaishou.com/article/comment"
KUAISHOU_MANAGE_URL = "https://cp.kuaishou.com/article/manage/video"


async def _is_ks_login_required(page: Page) -> bool:
    url = (page.url or "").lower()
    if "passport.kuaishou.com" in url or "/login" in url or not url.startswith("https://cp.kuaishou.com/"):
        return True
    try:
        login_form = page.locator("main#login-form").first
        if await login_form.count() and await login_form.is_visible():
            return True
    except Exception:
        pass
    return False


def _parse_ks_photo(raw: dict[str, Any]) -> dict[str, Any]:
    vid = str(raw.get("photoId") or raw.get("workId") or raw.get("id") or "").strip()
    title = str(raw.get("title") or raw.get("caption") or "").strip()
    cover = str(raw.get("cover") or raw.get("publishCoverUrl") or raw.get("coverUrl") or "").strip()
    return {
        "video_id": vid,
        "title": title,
        "cover_url": cover,
        "published_at": format_unix_iso(raw.get("uploadTime") or raw.get("createTime")),
        "comment_count": int(raw.get("commentCount") or 0),
        "like_count": int(raw.get("likeCount") or 0),
        "play_count": int(raw.get("playCount") or 0),
        "video_url": f"https://www.kuaishou.com/short-video/{vid}" if vid else "",
        "creator_uid": str(raw.get("userIdStr") or raw.get("userId") or ""),
        "creator_name": str(raw.get("userName") or ""),
    }


def _parse_ks_comment(
    raw: dict[str, Any],
    video_id: str,
    video_title: str,
    creator_uid: str,
    creator_name: str,
    parent_comment_id: str = "",
) -> dict[str, Any]:
    cid = str(raw.get("commentId") or raw.get("id") or "").strip()
    author_uid = str(raw.get("authorId") or raw.get("userId") or raw.get("userIdStr") or "").strip()
    author_name = str(raw.get("authorName") or raw.get("userName") or raw.get("nickname") or "快手老铁").strip()
    text = str(raw.get("content") or raw.get("text") or "").strip()
    is_author = bool(
        raw.get("isAuthor")
        or (creator_uid and author_uid and author_uid == creator_uid)
        or (creator_name and author_name and author_name == creator_name)
    )
    sub_list = raw.get("subComments") or raw.get("subCommentList") or raw.get("replies") or []
    return {
        "video_id": video_id,
        "video_title": video_title,
        "comment_id": cid,
        "parent_comment_id": parent_comment_id,
        "author_uid": author_uid,
        "author_name": author_name,
        "text": text,
        "like_count": int(raw.get("likedCount") or raw.get("likeCount") or 0),
        "created_at": format_unix_iso(raw.get("timestamp") or raw.get("createTime") or raw.get("time")),
        "is_author": is_author,
        "has_author_reply": bool(raw.get("authorReplied")),
        "reply_count": int(raw.get("subCommentCount") or len(sub_list)),
        "_raw_subs": sub_list if isinstance(sub_list, list) else [],
    }


def _flatten_ks_comments(
    raw_list: list[dict[str, Any]],
    video_id: str,
    video_title: str,
    creator_uid: str,
    creator_name: str,
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for raw in raw_list or []:
        if not isinstance(raw, dict):
            continue
        top = _parse_ks_comment(raw, video_id, video_title, creator_uid, creator_name)
        raw_subs = top.pop("_raw_subs", [])
        if not top["comment_id"]:
            continue
        subs: list[dict[str, Any]] = []
        for sr in raw_subs:
            if not isinstance(sr, dict):
                continue
            sub = _parse_ks_comment(sr, video_id, video_title, creator_uid, creator_name, parent_comment_id=top["comment_id"])
            sub.pop("_raw_subs", None)
            if sub["comment_id"]:
                subs.append(sub)
        if any(s["is_author"] for s in subs):
            top["has_author_reply"] = True
            last_author_idx = max(i for i, s in enumerate(subs) if s["is_author"])
            for i in range(last_author_idx):
                subs[i]["has_author_reply"] = True
        out.append(top)
        out.extend(subs)
    return out


async def _open_ks_video_drawer_and_select(
    page: Page,
    video_id: str,
    video_title: str,
    current_photo: dict[str, Any] | None,
) -> tuple[bool, str, str, list[dict[str, Any]]]:
    """在快手评论管理页切换目标视频，并顺便抓取点击后的 commentList 响应"""
    if current_photo:
        cur_vid = current_photo.get("video_id", "")
        cur_title = current_photo.get("title", "")
        if (video_id and cur_vid == video_id) or (not video_id and not video_title):
            return True, cur_vid, cur_title, []
        if video_title and titles_match(cur_title, video_title):
            return True, cur_vid, cur_title, []

    pick_btn = page.get_by_role("button", name="选择视频").first
    if not await pick_btn.count():
        pick_btn = page.locator("button.comment__header__video-btn").first
    if not await pick_btn.count():
        return False, "", "", []

    await pick_btn.click()
    await page.wait_for_timeout(1800)

    matched = await page.evaluate(
        """({ targetTitle }) => {
            const norm = (s) => (s || '')
                .replace(/#[^\\s#]+/g, '')
                .replace(/[\\s\\u3000.,，。！？!?：:；;、“”"'‘’（）()【】\\[\\]《》<>·—\\-_]+/g, '')
                .toLowerCase();
            const targetNorm = norm(targetTitle);
            // 快手右侧作品列表抽屉项（通常包含日期 YYYY-MM-DD HH:MM:SS）
            const candidates = Array.from(document.querySelectorAll('div, li'))
                .filter(el => {
                    const rect = el.getBoundingClientRect();
                    const txt = (el.innerText || '').trim();
                    return rect.left > 700 && rect.width > 180 && rect.height >= 60 && rect.height <= 200 && /20\\d\\d-\\d\\d-\\d\\d/.test(txt);
                });
            const cards = candidates.filter(el => !candidates.some(other => other !== el && el.contains(other)));
            if (!cards.length) return -1;
            if (!targetNorm) {
                cards[0].setAttribute('data-mmw-ks-video', '1');
                return 0;
            }
            for (let i = 0; i < cards.length; i++) {
                const cNorm = norm(cards[i].innerText);
                const short = cNorm.length <= targetNorm.length ? cNorm : targetNorm;
                const longStr = cNorm.length <= targetNorm.length ? targetNorm : cNorm;
                const prefix = short.slice(0, Math.min(12, short.length));
                if (prefix.length >= 4 && longStr.includes(prefix)) {
                    cards[i].setAttribute('data-mmw-ks-video', '1');
                    return i;
                }
            }
            return -1;
        }""",
        {"targetTitle": video_title},
    )

    if matched < 0:
        try:
            await page.keyboard.press("Escape")
        except Exception:
            pass
        return False, "", "", []

    captured_comments: list[dict[str, Any]] = []
    selected_vid = video_id

    async def on_comment_resp(resp):
        nonlocal selected_vid
        if "/rest/cp/creator/comment/commentList" in resp.url:
            try:
                post_data = resp.request.post_data or ""
                m = re.search(r'"photoId"\s*:\s*"([^"]+)"', post_data)
                if m:
                    selected_vid = m.group(1)
                data = await resp.json()
                lst = (data.get("data") or {}).get("list") or []
                if isinstance(lst, list):
                    captured_comments.extend(lst)
            except Exception:
                pass

    page.on("response", on_comment_resp)
    try:
        await page.locator('[data-mmw-ks-video="1"]').first.click()
        await page.wait_for_timeout(2600)
    finally:
        page.remove_listener("response", on_comment_resp)

    return True, selected_vid, video_title, captured_comments


async def sync_kuaishou_comments(
    cookie_path: str,
    max_videos: int = 20,
    only_video_id: str = "",
) -> dict[str, Any]:
    """同步快手创作者账号下已发布作品列表及最新评论"""
    if not cookie_path or not os.path.exists(cookie_path):
        return make_result(False, "未找到快手账号登录文件，请先在视频发布页扫码登录", auth_required=True, platform_type=4)

    creator_uid = ""
    creator_name = ""
    videos: list[dict[str, Any]] = []
    comments_by_vid: dict[str, list[dict[str, Any]]] = {}
    current_photo: dict[str, Any] | None = None

    async with async_playwright() as p:
        browser = await p.chromium.launch(**build_launch_kwargs(headless=True))
        try:
            context = await create_authenticated_context(browser, cookie_path)
            page = await context.new_page()

            async def on_resp(resp):
                nonlocal creator_uid, creator_name, current_photo
                url = resp.url
                try:
                    if "/rest/cp/works/v2/video/pc/photo/list" in url or "/rest/cp/creator/comment/photoList" in url:
                        data = await resp.json()
                        raw_list = (data.get("data") or {}).get("list") or []
                        for item in raw_list:
                            parsed = _parse_ks_photo(item)
                            if parsed["creator_uid"] and not creator_uid:
                                creator_uid = parsed["creator_uid"]
                            if parsed["creator_name"] and not creator_name:
                                creator_name = parsed["creator_name"]
                            if parsed["video_id"] and not any(v["video_id"] == parsed["video_id"] for v in videos):
                                videos.append(parsed)
                    elif "/rest/cp/creator/comment/home" in url:
                        data = await resp.json()
                        ph = (data.get("data") or {}).get("photo")
                        if isinstance(ph, dict):
                            current_photo = _parse_ks_photo(ph)
                            if current_photo["video_id"] and not any(v["video_id"] == current_photo["video_id"] for v in videos):
                                videos.insert(0, current_photo)
                    elif "/rest/cp/creator/comment/commentList" in url:
                        data = await resp.json()
                        post_data = resp.request.post_data or ""
                        m = re.search(r'"photoId"\s*:\s*"([^"]+)"', post_data)
                        vid = m.group(1) if m else (current_photo["video_id"] if current_photo else "")
                        if vid:
                            comments_by_vid[vid] = (data.get("data") or {}).get("list") or []
                except Exception:
                    pass

            page.on("response", on_resp)

            # 1. 先打开作品管理页拿完整的最近 30 条作品及准确评论数/昵称
            await page.goto(KUAISHOU_MANAGE_URL, wait_until="domcontentloaded", timeout=28000)
            await page.wait_for_timeout(3800)
            if await _is_ks_login_required(page):
                return make_result(False, "快手创作者登录态已失效，请在「视频发布 → 账号管理」重新扫码", auth_required=True, platform_type=4)

            # 2. 进入评论管理页拿到最新作品的评论
            await page.goto(KUAISHOU_COMMENT_URL, wait_until="domcontentloaded", timeout=28000)
            await page.wait_for_timeout(3800)

            sliced_videos = videos[:max_videos]
            all_comments: list[dict[str, Any]] = []

            for v in sliced_videos:
                vid = v["video_id"]
                if only_video_id and vid != only_video_id:
                    continue
                if vid in comments_by_vid:
                    all_comments.extend(
                        _flatten_ks_comments(comments_by_vid[vid], vid, v["title"], creator_uid, creator_name)
                    )
                    continue
                if not only_video_id and v["comment_count"] <= 0:
                    continue
                ok_sel, _, _, raw_list = await _open_ks_video_drawer_and_select(
                    page,
                    video_id=vid,
                    video_title=v["title"],
                    current_photo=current_photo,
                )
                if ok_sel:
                    current_photo = v
                    all_comments.extend(_flatten_ks_comments(raw_list, vid, v["title"], creator_uid, creator_name))

            return make_result(
                True,
                f"快手同步完成：获取 {len(sliced_videos)} 条已发作品，{len(all_comments)} 条评论",
                platform_type=4,
                creator_uid=creator_uid,
                creator_name=creator_name,
                videos=sliced_videos,
                comments=all_comments,
            )
        except Exception as exc:
            return make_result(False, f"快手评论同步异常: {exc}", platform_type=4)
        finally:
            await browser.close()


async def post_kuaishou_creator_comment(
    cookie_path: str,
    video_id: str = "",
    video_title: str = "",
    comment_text: str = "",
    dry_run: bool = False,
) -> dict[str, Any]:
    """用自己的快手创作者账号在自己已发布视频的评论区发表暖场/讨论评论"""
    cleaned_text = str(comment_text or "").strip()
    if not cleaned_text:
        return make_result(False, "评论内容不能为空", platform_type=4)
    if not cookie_path or not os.path.exists(cookie_path):
        return make_result(False, "未找到快手账号登录文件", auth_required=True, platform_type=4)

    current_photo: dict[str, Any] | None = None

    async with async_playwright() as p:
        browser = await p.chromium.launch(**build_launch_kwargs(headless=True))
        try:
            context = await create_authenticated_context(browser, cookie_path)
            page = await context.new_page()

            async def on_resp(resp):
                nonlocal current_photo
                if "/rest/cp/creator/comment/home" in resp.url:
                    try:
                        data = await resp.json()
                        ph = (data.get("data") or {}).get("photo")
                        if isinstance(ph, dict):
                            current_photo = _parse_ks_photo(ph)
                    except Exception:
                        pass

            page.on("response", on_resp)
            await page.goto(KUAISHOU_COMMENT_URL, wait_until="domcontentloaded", timeout=28000)
            await page.wait_for_timeout(4000)

            if await _is_ks_login_required(page):
                return make_result(False, "快手创作者登录态已失效，请重新扫码", auth_required=True, platform_type=4)

            ok_sel, matched_vid, matched_title, _ = await _open_ks_video_drawer_and_select(
                page,
                video_id=video_id,
                video_title=video_title,
                current_photo=current_photo,
            )
            if not ok_sel:
                shot = await save_diag_screenshot(page, "ks_post_select_fail")
                return make_result(
                    False,
                    "未在快手评论管理中找到目标视频（可能仍在审核处理中，稍后将自动重试）",
                    platform_type=4,
                    retryable=True,
                    diag_screenshot=shot,
                )

            composer = page.locator("div.author-comment-input__row__input, [placeholder*='有爱评论']").first
            if not await composer.count() or not await composer.is_visible():
                shot = await save_diag_screenshot(page, "ks_post_no_input")
                return make_result(False, "未找到快手评论输入框", platform_type=4, diag_screenshot=shot)

            send_btn = page.locator("div.author-comment-input__row__btn").first
            if not await send_btn.count():
                send_btn = page.get_by_text("发送", exact=True).first
            if not await send_btn.count() or not await send_btn.is_visible():
                shot = await save_diag_screenshot(page, "ks_post_no_send")
                return make_result(False, "未找到快手发送按钮", platform_type=4, diag_screenshot=shot)

            if dry_run:
                return make_result(
                    True,
                    "快手暖评通道预检通过（dry_run 未真实发送）",
                    platform_type=4,
                    dry_run=True,
                    video_id=matched_vid,
                    video_title=matched_title,
                )

            submit_ack: dict[str, Any] = {}

            async def on_submit_resp(resp):
                if resp.request.method == "POST" and "/rest/cp/creator/comment/" in resp.url and any(
                    k in resp.url.lower() for k in ("add", "publish", "create", "reply", "submit")
                ):
                    try:
                        submit_ack["data"] = await resp.json()
                    except Exception:
                        submit_ack["status"] = resp.status

            page.on("response", on_submit_resp)
            await composer.click()
            await page.wait_for_timeout(300)
            await human_type(page, cleaned_text)
            await page.wait_for_timeout(700)
            await send_btn.click()

            for _ in range(16):
                if submit_ack:
                    break
                await page.wait_for_timeout(500)

            data = submit_ack.get("data")
            if isinstance(data, dict):
                if data.get("result") not in (None, 1):
                    shot = await save_diag_screenshot(page, "ks_post_rejected")
                    return make_result(
                        False,
                        f"快手评论提交被拒: {data.get('message') or data.get('result')}",
                        platform_type=4,
                        diag_screenshot=shot,
                    )
                return make_result(
                    True,
                    "快手暖场评论发送成功",
                    platform_type=4,
                    video_id=matched_vid,
                    video_title=matched_title,
                )

            remaining = (await composer.inner_text()).strip()
            if not remaining:
                return make_result(
                    True,
                    "快手暖场评论已提交",
                    platform_type=4,
                    video_id=matched_vid,
                    video_title=matched_title,
                )

            shot = await save_diag_screenshot(page, "ks_post_uncertain")
            return make_result(False, "快手评论发送超时，未收到平台确认回执", platform_type=4, diag_screenshot=shot)
        except Exception as exc:
            return make_result(False, f"快手发表暖场评论失败: {exc}", platform_type=4)
        finally:
            await browser.close()


async def reply_kuaishou_comment(
    cookie_path: str,
    video_id: str = "",
    video_title: str = "",
    comment_id: str = "",
    comment_text: str = "",
    author_name: str = "",
    reply_text: str = "",
    dry_run: bool = False,
) -> dict[str, Any]:
    """用自己的快手创作者账号回复指定粉丝评论"""
    cleaned_reply = str(reply_text or "").strip()
    if not cleaned_reply:
        return make_result(False, "回复内容不能为空", platform_type=4)
    if not cookie_path or not os.path.exists(cookie_path):
        return make_result(False, "未找到快手账号登录文件", auth_required=True, platform_type=4)

    current_photo: dict[str, Any] | None = None

    async with async_playwright() as p:
        browser = await p.chromium.launch(**build_launch_kwargs(headless=True))
        try:
            context = await create_authenticated_context(browser, cookie_path)
            page = await context.new_page()

            async def on_resp(resp):
                nonlocal current_photo
                if "/rest/cp/creator/comment/home" in resp.url:
                    try:
                        data = await resp.json()
                        ph = (data.get("data") or {}).get("photo")
                        if isinstance(ph, dict):
                            current_photo = _parse_ks_photo(ph)
                    except Exception:
                        pass

            page.on("response", on_resp)
            await page.goto(KUAISHOU_COMMENT_URL, wait_until="domcontentloaded", timeout=28000)
            await page.wait_for_timeout(4000)

            if await _is_ks_login_required(page):
                return make_result(False, "快手创作者登录态已失效，请重新扫码", auth_required=True, platform_type=4)

            ok_sel, matched_vid, matched_title, _ = await _open_ks_video_drawer_and_select(
                page,
                video_id=video_id,
                video_title=video_title,
                current_photo=current_photo,
            )
            if not ok_sel:
                shot = await save_diag_screenshot(page, "ks_reply_select_fail")
                return make_result(False, "未在快手评论管理中找到对应视频", platform_type=4, diag_screenshot=shot)

            clicked = bool(
                await page.evaluate(
                    """({ targetText, targetAuthor }) => {
                        const norm = (s) => (s || '')
                            .replace(/[\\s\\u3000.,，。！？!?：:；;、“”"'‘’（）()【】\\[\\]《》<>·—\\-_]+/g, '')
                            .toLowerCase();
                        const tNorm = norm(targetText);
                        const aNorm = norm(targetAuthor);
                        const btns = Array.from(document.querySelectorAll('span, div, button, a'))
                            .filter(el => el.offsetParent !== null && (el.innerText || '').trim() === '回复');
                        let best = null;
                        let bestScore = -1;
                        for (const btn of btns) {
                            let node = btn.parentElement;
                            for (let step = 0; step < 6 && node; step++) {
                                const txt = norm(node.innerText || '');
                                if (tNorm && txt.includes(tNorm.slice(0, Math.min(14, tNorm.length)))) {
                                    let score = 10 + (aNorm && txt.includes(aNorm) ? 5 : 0) + Math.max(0, 6 - step);
                                    if (score > bestScore) {
                                        bestScore = score;
                                        best = btn;
                                    }
                                    break;
                                }
                                node = node.parentElement;
                            }
                        }
                        if (best) {
                            best.scrollIntoView({ block: 'center' });
                            best.click();
                            return true;
                        }
                        return false;
                    }""",
                    {"targetText": comment_text, "targetAuthor": author_name},
                )
            )

            if not clicked:
                shot = await save_diag_screenshot(page, "ks_reply_not_found")
                return make_result(False, "未在快手评论列表找到该条粉丝评论", platform_type=4, diag_screenshot=shot)

            await page.wait_for_timeout(900)
            reply_input = page.locator('[placeholder*="回复"], textarea').last
            if not await reply_input.count() or not await reply_input.is_visible():
                shot = await save_diag_screenshot(page, "ks_reply_no_input")
                return make_result(False, "点击回复后未出现快手回复输入框", platform_type=4, diag_screenshot=shot)

            inline_send_btn = page.locator("div[class*='comment-input__row__btn'], button:has-text('发送')").last
            if not await inline_send_btn.count():
                inline_send_btn = page.get_by_text("发送", exact=True).last

            if dry_run:
                return make_result(
                    True,
                    "快手粉丝回复通道预检通过（dry_run 未真实发送）",
                    platform_type=4,
                    dry_run=True,
                    video_id=matched_vid,
                    video_title=matched_title,
                    comment_id=comment_id,
                )

            submit_ack: dict[str, Any] = {}

            async def on_submit_resp(resp):
                if resp.request.method == "POST" and "/rest/cp/creator/comment/" in resp.url and any(
                    k in resp.url.lower() for k in ("reply", "add", "create", "submit")
                ):
                    try:
                        submit_ack["data"] = await resp.json()
                    except Exception:
                        submit_ack["status"] = resp.status

            page.on("response", on_submit_resp)
            await reply_input.click()
            await page.wait_for_timeout(250)
            await human_type(page, cleaned_reply)
            await page.wait_for_timeout(700)
            await inline_send_btn.click()

            for _ in range(16):
                if submit_ack:
                    break
                await page.wait_for_timeout(500)

            data = submit_ack.get("data")
            if isinstance(data, dict):
                if data.get("result") not in (None, 1):
                    shot = await save_diag_screenshot(page, "ks_reply_rejected")
                    return make_result(
                        False,
                        f"快手回复提交被拒: {data.get('message') or data.get('result')}",
                        platform_type=4,
                        diag_screenshot=shot,
                    )
                return make_result(
                    True,
                    "快手粉丝评论回复成功",
                    platform_type=4,
                    video_id=matched_vid,
                    video_title=matched_title,
                    comment_id=comment_id,
                )

            return make_result(
                True,
                "快手粉丝评论回复已提交",
                platform_type=4,
                video_id=matched_vid,
                video_title=matched_title,
                comment_id=comment_id,
            )
        except Exception as exc:
            return make_result(False, f"快手回复粉丝评论失败: {exc}", platform_type=4)
        finally:
            await browser.close()
