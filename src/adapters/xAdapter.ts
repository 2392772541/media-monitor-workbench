import { withHeadlessContext, updateProfileStatus } from '../browser/profileManager.js';
import { parseCountText } from './socialUtils.js';
import type { AvailabilityResult, ExtractedContentItem, FetchResult, LoginCheckResult, PlatformAdapter, SourceRecord } from './types.js';

export const xAdapter: PlatformAdapter = {
  platform: 'x',
  displayName: 'X (Twitter) 账号',
  profilePlatform: 'x',
  defaultCapability: '需要登录',

  async checkLoginStatus(): Promise<LoginCheckResult> {
    try {
      const res = await withHeadlessContext('x', 'login-check', async (ctx) => {
        const page = ctx.pages()[0] || (await ctx.newPage());
        await page.goto('https://x.com/', { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
        await page.waitForTimeout(3000);
        const currentUrl = page.url();
        const cookies = await ctx.cookies('https://x.com');
        const hasAuth = cookies.some((c) => c.name === 'auth_token' && Boolean(c.value));
        const redirectedLogin = currentUrl.includes('/login') || currentUrl.includes('/i/flow/login');
        return { hasAuth, redirectedLogin };
      });

      if (res.hasAuth && !res.redirectedLogin) {
        updateProfileStatus('x', { login_status: 'logged_in', capability_status: '已接入并验证', needs_attention: 0, note: 'X 独立浏览器已登录' });
        return { loggedIn: true, status: 'logged_in', capabilityStatus: '已接入并验证', message: 'X 独立浏览器已登录', needsAttention: false };
      }

      updateProfileStatus('x', { login_status: 'auth_required', capability_status: '需要登录', needs_attention: 1, note: '未检测到有效 X 登录状态' });
      return { loggedIn: false, status: 'auth_required', capabilityStatus: '需要登录', message: 'X 平台尚未登录或会话已过期，请打开独立窗口登录', needsAttention: true };
    } catch (err) {
      return { loggedIn: false, status: 'error', capabilityStatus: '暂时不可用', message: `X 登录检测失败（请确认网络连通性）: ${(err as Error).message}`, needsAttention: true };
    }
  },

  async checkAvailability(url: string): Promise<AvailabilityResult> {
    if (!/(x\.com|twitter\.com)/i.test(url)) {
      return { available: false, message: '链接不属于 X / Twitter 域名', capabilityStatus: '采集异常' };
    }
    return { available: true, message: 'X 主页链接格式有效，需独立浏览器并配合有效登录状态访问', capabilityStatus: '需要登录' };
  },

  async fetchLatest(source: SourceRecord, options): Promise<FetchResult> {
    const logs: string[] = [];
    const writeLog = (m: string) => {
      logs.push(m);
      options.onLog?.(m);
    };

    writeLog(`启动独立 X 浏览器访问账号主页: ${source.url}`);
    try {
      const res = await withHeadlessContext(
        'x',
        `source:${source.id}`,
        async (ctx) => {
          const page = ctx.pages()[0] || (await ctx.newPage());
          await page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.waitForTimeout(4000);
          const currentUrl = page.url();
          const needsLogin = currentUrl.includes('/i/flow/login') || currentUrl.includes('/login');
          if (needsLogin) return { needsLogin: true, tweets: [] };

          const tweets = await page.evaluate(() => {
            const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]')).slice(0, 15);
            return articles
              .map((art) => {
                const linkEl = art.querySelector('a[href*="/status/"]') as HTMLAnchorElement | null;
                const href = linkEl?.href || '';
                const idMatch = href.match(/\/status\/(\d+)/);
                if (!idMatch) return null;
                const textEl = art.querySelector('div[data-testid="tweetText"]');
                const timeEl = art.querySelector('time');
                const imgEl = art.querySelector('div[data-testid="tweetPhoto"] img') as HTMLImageElement | null;
                const userEl = art.querySelector('div[data-testid="User-Name"]');
                const replyBtn = art.querySelector('button[data-testid="reply"]');
                const retweetBtn = art.querySelector('button[data-testid="retweet"]');
                const likeBtn = art.querySelector('button[data-testid="like"]');
                return {
                  id: idMatch[1],
                  url: href,
                  text: (textEl?.textContent || '').trim(),
                  author: (userEl?.textContent || '').split('@')[0].trim(),
                  publishedAt: timeEl?.getAttribute('datetime') || null,
                  coverUrl: imgEl?.src || '',
                  replies: replyBtn?.getAttribute('aria-label') || replyBtn?.textContent || '',
                  shares: retweetBtn?.getAttribute('aria-label') || retweetBtn?.textContent || '',
                  likes: likeBtn?.getAttribute('aria-label') || likeBtn?.textContent || '',
                };
              })
              .filter((x): x is NonNullable<typeof x> => Boolean(x));
          });
          return { needsLogin: false, tweets };
        },
        { headless: options.headless }
      );

      if (res.needsLogin) {
        writeLog('X 页面跳转至登录墙，已停止采集');
        updateProfileStatus('x', { login_status: 'auth_required', capability_status: '需要登录', needs_attention: 1 });
        return { ok: false, authRequired: true, capabilityStatus: '需要登录', items: [], logs, errorMessage: 'X 平台未登录或登录失效' };
      }

      const items: ExtractedContentItem[] = res.tweets.map((t) => ({
        platformItemId: t.id,
        url: t.url,
        title: (t.text || `X 帖子 ${t.id}`).slice(0, 80),
        author: t.author || source.name,
        summary: t.text.slice(0, 260),
        body: t.text,
        coverUrl: t.coverUrl,
        publishedAt: t.publishedAt,
        metrics: {
          comments: parseCountText(t.replies),
          shares: parseCountText(t.shares),
          likes: parseCountText(t.likes),
        },
      }));

      writeLog(`采集完成，提取到 ${items.length} 条推文`);
      return { ok: true, capabilityStatus: items.length > 0 ? '已接入并验证' : '暂时不可用', items, logs };
    } catch (err) {
      const msg = (err as Error).message;
      writeLog(`X 采集失败: ${msg}`);
      return { ok: false, capabilityStatus: '暂时不可用', items: [], logs, errorMessage: msg };
    }
  },
};
