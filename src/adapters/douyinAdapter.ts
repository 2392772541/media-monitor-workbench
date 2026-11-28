import { getDb } from '../db/database.js';
import { withHeadlessContext, updateProfileStatus } from '../browser/profileManager.js';
import { parseCountText } from './socialUtils.js';
import { resolveShortSourceUrl } from './urlRecognizer.js';
import type { AvailabilityResult, ExtractedContentItem, FetchResult, LoginCheckResult, PlatformAdapter, SourceRecord } from './types.js';

interface DouyinApiProfile {
  nickname?: string;
  followerCount?: number | null;
  bio?: string;
  avatarUrl?: string;
}

interface DouyinApiPost {
  aweme_id?: string;
  desc?: string;
  create_time?: number;
  video?: {
    cover?: { url_list?: string[] };
    origin_cover?: { url_list?: string[] };
    dynamic_cover?: { url_list?: string[] };
  };
  statistics?: {
    digg_count?: number;
    comment_count?: number;
    collect_count?: number;
    share_count?: number;
    play_count?: number;
  };
  author?: {
    nickname?: string;
  };
}

// 内部通用抓取实现：常规追更保持首屏 24 条上限，历史深抓支持向下滚动加载更多页
async function fetchDouyinPages(
  source: SourceRecord,
  options: { headless: boolean; signal?: AbortSignal; onLog?: (msg: string) => void; maxPages?: number }
): Promise<FetchResult> {
  const maxPages = Math.min(Math.max(Math.round(options.maxPages || 1), 1), 5);
  const maxItems = maxPages === 1 ? 24 : maxPages * 25;

  const logs: string[] = [];
  const writeLog = (m: string) => {
    logs.push(m);
    options.onLog?.(m);
  };

  // 先解析 v.douyin.com / iesdouyin.com 短链为标准桌面主页，彻底避免跳到推荐页抓错视频
  const { resolvedUrl, changed } = await resolveShortSourceUrl(source.url);
  const targetUrl = resolvedUrl || source.url;
  if (changed && targetUrl !== source.url) {
    writeLog(`已将抖音短链规范化为桌面主页: ${targetUrl}`);
    try {
      getDb().prepare('UPDATE sources SET url = ?, updated_at = ? WHERE id = ?').run(targetUrl, new Date().toISOString(), source.id);
    } catch {
      // ignore
    }
  }

  writeLog(`启动独立抖音浏览器访问博主主页: ${targetUrl}（最多 ${maxPages} 页 / ${maxItems} 条）`);
  try {
    const result = await withHeadlessContext(
      'douyin',
      `source:${source.id}`,
      async (ctx) => {
        const page = ctx.pages()[0] || (await ctx.newPage());

        let apiProfile: DouyinApiProfile | null = null;
        const apiPosts = new Map<string, DouyinApiPost>();

        // 优先监听抖音网页端真实接口响应（只拿当前博主本人作品，带真封面与赞/评/藏/转）
        page.on('response', async (resp) => {
          const u = resp.url();
          if (!u.includes('/aweme/v1/web/user/profile/other') && !u.includes('/aweme/v1/web/aweme/post')) {
            return;
          }
          try {
            const txt = await resp.text();
            if (!txt || !txt.startsWith('{')) return;
            const json = JSON.parse(txt) as {
              user?: {
                nickname?: string;
                follower_count?: number;
                signature?: string;
                avatar_larger?: { url_list?: string[] };
                avatar_medium?: { url_list?: string[] };
              };
              aweme_list?: DouyinApiPost[];
            };
            if (u.includes('/user/profile/other') && json.user) {
              apiProfile = {
                nickname: (json.user.nickname || '').trim() || undefined,
                followerCount: typeof json.user.follower_count === 'number' ? json.user.follower_count : null,
                bio: (json.user.signature || '').trim().slice(0, 300),
                avatarUrl:
                  json.user.avatar_larger?.url_list?.[0] || json.user.avatar_medium?.url_list?.[0] || '',
              };
            }
            if (u.includes('/aweme/post') && Array.isArray(json.aweme_list)) {
              for (const p of json.aweme_list) {
                if (p.aweme_id && !apiPosts.has(p.aweme_id)) {
                  apiPosts.set(p.aweme_id, p);
                }
              }
            }
          } catch {
            // 忽略非 JSON 响应
          }
        });

        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // 最长等待 7 秒，拿到首屏作品接口数据后立即结束等待
        for (let i = 0; i < 14; i++) {
          await page.waitForTimeout(500);
          if (apiPosts.size >= 10 && apiProfile) break;
        }

        // 历史模式：向下滚动触发更多 /aweme/post 分页加载
        if (maxPages > 1) {
          let stagnantRounds = 0;
          const maxScrolls = maxPages * 4;
          for (let s = 0; s < maxScrolls; s++) {
            if (options.signal?.aborted || apiPosts.size >= maxItems) break;
            const before = apiPosts.size;
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await page.waitForTimeout(1100);
            if (apiPosts.size === before) {
              stagnantRounds++;
              if (stagnantRounds >= 2) break;
            } else {
              stagnantRounds = 0;
            }
          }
        }

        // 读取页面状态与严格限定在 [data-e2e="user-post-list"] 内的兜底 DOM
        const domState = await page.evaluate((domLimit) => {
          const text = document.body?.innerText || '';
          const hasCaptcha = text.includes('拖动滑块') || text.includes('安全验证') || text.includes('验证码中间页');
          const postRoot = document.querySelector('[data-e2e="user-post-list"]');
          const hasLoginWall = !postRoot && text.includes('扫码登录');
          const authorName =
            document.querySelector('[data-e2e="user-info"] h1')?.textContent?.trim() ||
            document.title.replace(/的抖音.*|的主页.*| - 抖音.*/g, '').trim();
          const fansMatch = text.match(/粉丝\s*([\d.]+[万亿wW]?)/) || text.match(/([\d.]+[万亿wW]?)\s*粉丝/);
          const fansText = fansMatch ? fansMatch[1] : '';
          const bioEl = document.querySelector('[data-e2e="user-info-desc"], [class*="signature"]');
          const bio = (bioEl?.textContent || '').trim().slice(0, 300);

          const videos: Array<{
            id: string;
            url: string;
            title: string;
            coverUrl: string;
            likesText: string;
          }> = [];

          // 严格仅从博主作品容器提取，绝不误抓首页/侧栏推荐视频
          if (postRoot) {
            const cards = Array.from(postRoot.querySelectorAll('a[href*="/video/"]'));
            const seen = new Set<string>();
            for (const a of cards) {
              const href = (a as HTMLAnchorElement).href || '';
              const m = href.match(/\/video\/(\d+)/);
              if (!m) continue;
              const vid = m[1];
              if (seen.has(vid)) continue;
              seen.add(vid);
              const container = a.closest('li') || a;
              const img = container.querySelector('img') as HTMLImageElement | null;
              const rawText = (container.textContent || '').replace(/\s+/g, ' ').trim();
              const title = (img?.alt || a.getAttribute('title') || rawText || `抖音作品 ${vid}`).trim();
              const likeEl = container.querySelector('[class*="like"], [class*="count"]');
              videos.push({
                id: vid,
                url: `https://www.douyin.com/video/${vid}`,
                title: title.slice(0, 200),
                coverUrl: img?.src || '',
                likesText: likeEl?.textContent?.trim() || '',
              });
              if (videos.length >= domLimit) break;
            }
          }

          return { hasCaptcha, hasLoginWall, authorName, fansText, bio, videos };
        }, maxItems);

        return {
          apiProfile: apiProfile as DouyinApiProfile | null,
          apiPosts: Array.from(apiPosts.values()).slice(0, maxItems),
          domState,
        };
      },
      { headless: options.headless }
    );

    const { apiProfile, apiPosts, domState } = result;
    const resolvedAuthorName =
      apiProfile?.nickname ||
      apiPosts[0]?.author?.nickname ||
      (domState.authorName && domState.authorName !== '抖音' ? domState.authorName : '') ||
      source.name;

    // 优先使用接口拿到的精准作品列表；仅在接口为空时才回退到受限 DOM 容器
    let items: ExtractedContentItem[] = [];
    if (apiPosts.length > 0) {
      items = apiPosts.map((p) => {
        const id = String(p.aweme_id || '');
        const title = (p.desc || '').replace(/\s+/g, ' ').trim() || `抖音作品 ${id}`;
        const cover =
          p.video?.cover?.url_list?.[0] ||
          p.video?.origin_cover?.url_list?.[0] ||
          p.video?.dynamic_cover?.url_list?.[0] ||
          '';
        const st = p.statistics || {};
        // 抖音网页端对 play_count 经常返回 0（代表未公开），严禁把 0 当成真实播放量
        const realViews = typeof st.play_count === 'number' && st.play_count > 0 ? st.play_count : null;
        return {
          platformItemId: id,
          url: `https://www.douyin.com/video/${id}`,
          title: title.slice(0, 220),
          author: resolvedAuthorName,
          summary: title.slice(0, 320),
          body: title,
          coverUrl: cover,
          publishedAt: typeof p.create_time === 'number' && p.create_time > 0 ? new Date(p.create_time * 1000).toISOString() : null,
          contentType: 'video',
          metrics: {
            views: realViews,
            likes: typeof st.digg_count === 'number' ? st.digg_count : null,
            comments: typeof st.comment_count === 'number' ? st.comment_count : null,
            favorites: typeof st.collect_count === 'number' ? st.collect_count : null,
            shares: typeof st.share_count === 'number' ? st.share_count : null,
          },
        };
      });
    } else if (domState.videos.length > 0) {
      items = domState.videos.map((v) => ({
        platformItemId: v.id,
        url: v.url,
        title: v.title,
        author: resolvedAuthorName,
        summary: v.title,
        body: v.title,
        coverUrl: v.coverUrl,
        contentType: 'video',
        metrics: {
          likes: parseCountText(v.likesText),
        },
      }));
    }

    if (items.length === 0 && (domState.hasCaptcha || domState.hasLoginWall)) {
      const reason = domState.hasCaptcha ? '触发安全滑块验证' : '未登录或登录态失效，页面被登录弹窗阻断';
      writeLog(`检测到平台验证限制: ${reason}，已停止采集并标记需要人工登录`);
      updateProfileStatus('douyin', {
        login_status: 'auth_required',
        capability_status: '需要登录',
        needs_attention: 1,
        note: reason,
      });
      return {
        ok: false,
        authRequired: true,
        capabilityStatus: '需要登录',
        items: [],
        logs,
        errorMessage: `${reason}，请在「浏览器与登录」中打开抖音独立窗口完成登录`,
      };
    }

    const followerCount =
      apiProfile?.followerCount !== undefined ? apiProfile.followerCount : parseCountText(domState.fansText);
    const bio = apiProfile?.bio || domState.bio || '';

    writeLog(
      `采集完成，博主「${resolvedAuthorName}」提取到 ${items.length} 条真实抖音作品${followerCount != null ? `，粉丝数 ${followerCount}` : ''}`
    );
    if (items.length > 0) {
      updateProfileStatus('douyin', {
        capability_status: '已接入并验证',
        needs_attention: 0,
      });
    }

    return {
      ok: items.length > 0,
      capabilityStatus: items.length > 0 ? '已接入并验证' : '暂时不可用',
      items,
      authorProfile: {
        name: resolvedAuthorName !== source.name ? resolvedAuthorName : apiProfile?.nickname || undefined,
        followerCount,
        bio,
        avatarUrl: apiProfile?.avatarUrl || undefined,
      },
      logs,
      errorMessage:
        items.length === 0
          ? '未读取到该博主的作品列表（可去「浏览器与登录」扫码登录抖音后重试，或确认粘贴的是博主主页链接而非单个视频链接）'
          : undefined,
    };
  } catch (err) {
    const msg = (err as Error).message;
    writeLog(`抖音采集异常: ${msg}`);
    return { ok: false, capabilityStatus: '采集异常', items: [], logs, errorMessage: msg };
  }
}

// 导出抖音历史深抓函数（供 R3 历史视频翻页抓取调用）
export async function fetchDouyinHistory(
  source: SourceRecord,
  options: { headless?: boolean; maxPages?: number; signal?: AbortSignal; onLog?: (msg: string) => void } = {}
): Promise<FetchResult> {
  return fetchDouyinPages(source, {
    headless: options.headless ?? true,
    maxPages: options.maxPages ?? 3,
    signal: options.signal,
    onLog: options.onLog,
  });
}

export const douyinAdapter: PlatformAdapter = {
  platform: 'douyin',
  displayName: '抖音博主',
  profilePlatform: 'douyin',
  defaultCapability: '已接入并验证',

  async checkLoginStatus(): Promise<LoginCheckResult> {
    try {
      const res = await withHeadlessContext('douyin', 'login-check', async (ctx) => {
        const page = ctx.pages()[0] || (await ctx.newPage());
        await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 25000 });
        await page.waitForTimeout(2500);
        const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 2000) || '');
        const cookies = await ctx.cookies('https://www.douyin.com');
        // 严格检测真实已登录会话 Cookie（不再把游客 passport_csrf_token 误判为已登录）
        const hasSessionCookie = cookies.some(
          (c) => ['sessionid', 'sessionid_ss', 'sid_guard', 'uid_tt'].includes(c.name) && Boolean(c.value)
        );
        const hasLoginBtn = await page.locator('button:has-text("登录"), text=扫码登录').first().isVisible().catch(() => false);
        const hasCaptcha = bodyText.includes('验证码') || bodyText.includes('拖动滑块');
        return { hasSessionCookie, hasLoginBtn, hasCaptcha };
      });

      if (res.hasCaptcha) {
        updateProfileStatus('douyin', {
          login_status: 'auth_required',
          capability_status: '需要登录',
          needs_attention: 1,
          note: '检测到安全验证/滑块，请打开独立窗口人工处理',
        });
        return {
          loggedIn: false,
          status: 'auth_required',
          capabilityStatus: '需要登录',
          message: '检测到抖音安全验证，需要打开独立登录窗口手动处理',
          needsAttention: true,
        };
      }
      if (res.hasSessionCookie && !res.hasLoginBtn) {
        updateProfileStatus('douyin', {
          login_status: 'logged_in',
          capability_status: '已接入并验证',
          needs_attention: 0,
          note: '独立浏览器登录状态有效',
        });
        return {
          loggedIn: true,
          status: 'logged_in',
          capabilityStatus: '已接入并验证',
          message: '抖音独立浏览器已登录且状态有效',
          needsAttention: false,
        };
      }
      updateProfileStatus('douyin', {
        login_status: 'auth_required',
        capability_status: '需要登录',
        needs_attention: 1,
        note: '当前为游客状态（可采集大部分公开主页，遇到风控时请扫码登录）',
      });
      return {
        loggedIn: false,
        status: 'auth_required',
        capabilityStatus: '需要登录',
        message: '抖音独立浏览器尚未登录（大部分公开博主主页可直接抓取，若遇限制可扫码登录）',
        needsAttention: true,
      };
    } catch (err) {
      const msg = (err as Error).message;
      return {
        loggedIn: false,
        status: 'error',
        capabilityStatus: '采集异常',
        message: `检测抖音登录态出错: ${msg}`,
        needsAttention: true,
      };
    }
  },

  async checkAvailability(url: string): Promise<AvailabilityResult> {
    if (!/(?:douyin|iesdouyin)\.com/i.test(url)) {
      return { available: false, message: '链接不属于抖音域名', capabilityStatus: '采集异常' };
    }
    return {
      available: true,
      message: '抖音博主链接有效，将自动转为桌面主页并抓取真实作品与封面',
      capabilityStatus: '已接入并验证',
    };
  },

  async fetchLatest(source: SourceRecord, options): Promise<FetchResult> {
    return fetchDouyinPages(source, { ...options, maxPages: 1 });
  },
};
