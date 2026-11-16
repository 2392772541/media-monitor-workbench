import { withHeadlessContext, updateProfileStatus } from '../browser/profileManager.js';
import { parseCountText } from './socialUtils.js';
import type { AvailabilityResult, ExtractedContentItem, FetchResult, LoginCheckResult, PlatformAdapter, SourceRecord } from './types.js';

export const kuaishouAdapter: PlatformAdapter = {
  platform: 'kuaishou',
  displayName: '快手博主',
  profilePlatform: 'kuaishou',
  defaultCapability: '需要登录',

  async checkLoginStatus(): Promise<LoginCheckResult> {
    try {
      const res = await withHeadlessContext('kuaishou', 'login-check', async (ctx) => {
        const page = ctx.pages()[0] || (await ctx.newPage());
        await page.goto('https://www.kuaishou.com/', { waitUntil: 'domcontentloaded', timeout: 25000 });
        await page.waitForTimeout(2500);
        const cookies = await ctx.cookies('https://www.kuaishou.com');
        const hasSession = cookies.some((c) => ['userId', 'kuaishou.server.web_st', 'passToken'].includes(c.name) && Boolean(c.value));
        const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 1500) || '');
        const hasCaptcha = bodyText.includes('安全验证') || bodyText.includes('滑块');
        return { hasSession, hasCaptcha };
      });

      if (res.hasCaptcha) {
        updateProfileStatus('kuaishou', { login_status: 'auth_required', capability_status: '需要登录', needs_attention: 1, note: '需要通过安全验证' });
        return { loggedIn: false, status: 'auth_required', capabilityStatus: '需要登录', message: '快手检测到安全验证，请打开独立窗口人工处理', needsAttention: true };
      }
      if (res.hasSession) {
        updateProfileStatus('kuaishou', { login_status: 'logged_in', capability_status: '已接入并验证', needs_attention: 0, note: '独立浏览器登录状态有效' });
        return { loggedIn: true, status: 'logged_in', capabilityStatus: '已接入并验证', message: '快手独立浏览器已登录', needsAttention: false };
      }
      updateProfileStatus('kuaishou', { login_status: 'auth_required', capability_status: '需要登录', needs_attention: 1, note: '未检测到有效登录态，请扫码登录' });
      return { loggedIn: false, status: 'auth_required', capabilityStatus: '需要登录', message: '快手未登录或已过期，请打开独立窗口扫码登录', needsAttention: true };
    } catch (err) {
      return { loggedIn: false, status: 'error', capabilityStatus: '采集异常', message: `快手登录检测异常: ${(err as Error).message}`, needsAttention: true };
    }
  },

  async checkAvailability(url: string): Promise<AvailabilityResult> {
    if (!/kuaishou\.com/i.test(url)) {
      return { available: false, message: '链接不属于快手域名', capabilityStatus: '采集异常' };
    }
    return { available: true, message: '快手链接格式有效，需独立浏览器配合有效登录态执行', capabilityStatus: '需要登录' };
  },

  async fetchLatest(source: SourceRecord, options): Promise<FetchResult> {
    const logs: string[] = [];
    const writeLog = (m: string) => {
      logs.push(m);
      options.onLog?.(m);
    };

    writeLog(`启动独立快手浏览器访问主页: ${source.url}`);
    try {
      const res = await withHeadlessContext(
        'kuaishou',
        `source:${source.id}`,
        async (ctx) => {
          const page = ctx.pages()[0] || (await ctx.newPage());
          await page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.waitForTimeout(3500);
          return await page.evaluate(() => {
            const text = document.body?.innerText || '';
            const hasCaptcha = text.includes('安全验证') || text.includes('拖动滑块');
            const links = Array.from(document.querySelectorAll('a[href*="/short-video/"], a[href*="/photo/"]'));
            const hasLoginWall = links.length === 0 && (text.includes('立即登录') || text.includes('扫码登录'));
            const authorName = document.querySelector('.user-name, h1')?.textContent?.trim() || '';

            const seen = new Set<string>();
            const videos: Array<{ id: string; url: string; title: string; coverUrl: string; likesText: string }> = [];
            for (const a of links) {
              const href = (a as HTMLAnchorElement).href || '';
              const m = href.match(/\/(?:short-video|photo)\/([a-zA-Z0-9_-]+)/);
              if (!m) continue;
              const id = m[1];
              if (seen.has(id)) continue;
              seen.add(id);
              const card = a.closest('li, div[class*="video-card"]') || a;
              const img = card.querySelector('img') as HTMLImageElement | null;
              const title = (img?.alt || card.textContent || `快手作品 ${id}`).replace(/\s+/g, ' ').trim();
              const likeEl = card.querySelector('[class*="like"]');
              videos.push({
                id,
                url: href,
                title: title.slice(0, 200),
                coverUrl: img?.src || '',
                likesText: likeEl?.textContent?.trim() || '',
              });
              if (videos.length >= 20) break;
            }
            return { hasCaptcha, hasLoginWall, authorName, videos };
          });
        },
        { headless: options.headless }
      );

      if (res.hasCaptcha || res.hasLoginWall) {
        const reason = res.hasCaptcha ? '触发安全验证' : '未登录或登录态失效，被登录提示拦截';
        writeLog(`检测到限制: ${reason}`);
        updateProfileStatus('kuaishou', { login_status: 'auth_required', capability_status: '需要登录', needs_attention: 1, note: reason });
        return { ok: false, authRequired: true, capabilityStatus: '需要登录', items: [], logs, errorMessage: reason };
      }

      const items: ExtractedContentItem[] = res.videos.map((v) => ({
        platformItemId: v.id,
        url: v.url,
        title: v.title,
        author: res.authorName || source.name,
        summary: v.title,
        body: v.title,
        coverUrl: v.coverUrl,
        metrics: { likes: parseCountText(v.likesText) },
      }));

      writeLog(`采集完成，提取到 ${items.length} 条快手作品`);
      return {
        ok: true,
        capabilityStatus: items.length > 0 ? '已接入并验证' : '暂时不可用',
        items,
        logs,
      };
    } catch (err) {
      const msg = (err as Error).message;
      writeLog(`快手采集异常: ${msg}`);
      return { ok: false, capabilityStatus: '采集异常', items: [], logs, errorMessage: msg };
    }
  },
};
