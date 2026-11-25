import { withHeadlessContext, updateProfileStatus } from '../browser/profileManager.js';
import { parseCountText } from './socialUtils.js';
import type { AvailabilityResult, ExtractedContentItem, FetchResult, LoginCheckResult, PlatformAdapter, SourceRecord } from './types.js';

export const douyinAdapter: PlatformAdapter = {
  platform: 'douyin',
  displayName: '抖音博主',
  profilePlatform: 'douyin',
  defaultCapability: '需要登录',

  async checkLoginStatus(): Promise<LoginCheckResult> {
    try {
      const res = await withHeadlessContext('douyin', 'login-check', async (ctx) => {
        const page = ctx.pages()[0] || (await ctx.newPage());
        await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 25000 });
        await page.waitForTimeout(2500);
        const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 2000) || '');
        const cookies = await ctx.cookies('https://www.douyin.com');
        const hasSessionCookie = cookies.some((c) => ['sessionid', 'sessionid_ss', 'passport_csrf_token'].includes(c.name) && Boolean(c.value));
        const hasLoginBtn = await page.locator('button:has-text("登录"), text=扫码登录').first().isVisible().catch(() => false);
        const hasCaptcha = bodyText.includes('验证码') || bodyText.includes('拖动滑块');
        return { hasSessionCookie, hasLoginBtn, hasCaptcha };
      });

      if (res.hasCaptcha) {
        updateProfileStatus('douyin', { login_status: 'auth_required', capability_status: '需要登录', needs_attention: 1, note: '检测到安全验证/滑块，请打开独立窗口人工处理' });
        return { loggedIn: false, status: 'auth_required', capabilityStatus: '需要登录', message: '检测到抖音安全验证，需要打开独立登录窗口手动处理', needsAttention: true };
      }
      if (res.hasSessionCookie && !res.hasLoginBtn) {
        updateProfileStatus('douyin', { login_status: 'logged_in', capability_status: '已接入并验证', needs_attention: 0, note: '独立浏览器登录状态有效' });
        return { loggedIn: true, status: 'logged_in', capabilityStatus: '已接入并验证', message: '抖音独立浏览器已登录且状态有效', needsAttention: false };
      }
      updateProfileStatus('douyin', { login_status: 'auth_required', capability_status: '需要登录', needs_attention: 1, note: '未检测到有效登录态，请扫码登录' });
      return { loggedIn: false, status: 'auth_required', capabilityStatus: '需要登录', message: '抖音尚未登录或登录已过期，请打开独立浏览器扫码登录', needsAttention: true };
    } catch (err) {
      const msg = (err as Error).message;
      return { loggedIn: false, status: 'error', capabilityStatus: '采集异常', message: `检测抖音登录态出错: ${msg}`, needsAttention: true };
    }
  },

  async checkAvailability(url: string): Promise<AvailabilityResult> {
    if (!/douyin\.com/i.test(url)) {
      return { available: false, message: '链接不属于抖音域名', capabilityStatus: '采集异常' };
    }
    return {
      available: true,
      message: '抖音主页链接格式有效，需通过独立浏览器并配合有效登录状态执行采集',
      capabilityStatus: '需要登录',
    };
  },

  async fetchLatest(source: SourceRecord, options): Promise<FetchResult> {
    const logs: string[] = [];
    const writeLog = (m: string) => {
      logs.push(m);
      options.onLog?.(m);
    };

    writeLog(`启动独立抖音浏览器访问博主主页: ${source.url}`);
    try {
      const result = await withHeadlessContext(
        'douyin',
        `source:${source.id}`,
        async (ctx) => {
          const page = ctx.pages()[0] || (await ctx.newPage());
          await page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.waitForTimeout(3500);

          const state = await page.evaluate(() => {
            const text = document.body?.innerText || '';
            const hasCaptcha = text.includes('拖动滑块') || text.includes('安全验证');
            const hasLoginWall = text.includes('扫码登录') && !document.querySelector('a[href*="/video/"]');
            const authorName =
              document.querySelector('h1')?.textContent?.trim() ||
              document.title.replace(/的主页.*| - 抖音.*/g, '').trim();
            // 尝试提取博主主页粉丝数与简介（提不到则留空，绝不造假）
            const fansMatch = text.match(/粉丝\s*([\d.]+[万亿wW]?)/) || text.match(/([\d.]+[万亿wW]?)\s*粉丝/);
            const fansText = fansMatch ? fansMatch[1] : '';
            const bioEl = document.querySelector('[class*="signature"], [class*="desc"], [data-e2e="user-info-desc"]');
            const bio = (bioEl?.textContent || '').trim().slice(0, 300);

            const cards = Array.from(document.querySelectorAll('a[href*="/video/"]'));
            const seen = new Set<string>();
            const videos: Array<{
              id: string;
              url: string;
              title: string;
              coverUrl: string;
              likesText: string;
            }> = [];

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
              if (videos.length >= 20) break;
            }

            return { hasCaptcha, hasLoginWall, authorName, fansText, bio, videos };
          });

          return state;
        },
        { headless: options.headless }
      );

      if (result.hasCaptcha || result.hasLoginWall) {
        const reason = result.hasCaptcha ? '触发安全滑块验证' : '未登录或登录态失效，页面被登录弹窗阻断';
        writeLog(`检测到平台验证限制: ${reason}，已停止采集并标记需要人工登录`);
        updateProfileStatus('douyin', { login_status: 'auth_required', capability_status: '需要登录', needs_attention: 1, note: reason });
        return {
          ok: false,
          authRequired: true,
          capabilityStatus: '需要登录',
          items: [],
          logs,
          errorMessage: `${reason}，请在“浏览器与登录管理”中打开抖音独立窗口完成登录`,
        };
      }

      const items: ExtractedContentItem[] = result.videos.map((v) => ({
        platformItemId: v.id,
        url: v.url,
        title: v.title,
        author: result.authorName || source.name,
        summary: v.title,
        body: v.title,
        coverUrl: v.coverUrl,
        contentType: 'video',
        metrics: {
          // 抖音网页主页卡片通常仅公开点赞数；播放/评论/收藏/转发若未采集到严格保持 null
          likes: parseCountText(v.likesText),
        },
      }));

      const followerCount = parseCountText(result.fansText);
      writeLog(`采集完成，提取到 ${items.length} 条可访问抖音作品${followerCount != null ? `，粉丝数 ${followerCount}` : ''}`);
      if (items.length > 0) {
        updateProfileStatus('douyin', { login_status: 'logged_in', capability_status: '已接入并验证', needs_attention: 0 });
      }
      return {
        ok: true,
        capabilityStatus: items.length > 0 ? '已接入并验证' : '暂时不可用',
        items,
        authorProfile: {
          name: result.authorName || undefined,
          followerCount,
          bio: result.bio || '',
        },
        logs,
        errorMessage: items.length === 0 ? '页面未返回可解析的作品列表（可能需要登录后查看或主页暂无公开作品）' : undefined,
      };
    } catch (err) {
      const msg = (err as Error).message;
      writeLog(`抖音采集异常: ${msg}`);
      return { ok: false, capabilityStatus: '采集异常', items: [], logs, errorMessage: msg };
    }
  },
};
