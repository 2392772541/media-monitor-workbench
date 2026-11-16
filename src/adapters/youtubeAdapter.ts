import { withHeadlessContext, updateProfileStatus } from '../browser/profileManager.js';
import type { AvailabilityResult, ExtractedContentItem, FetchResult, LoginCheckResult, PlatformAdapter, SourceRecord } from './types.js';
import { fetchText, parseFeedContent } from './webUtils.js';

async function resolveChannelFeedUrl(rawUrl: string): Promise<{ feedUrl?: string; title?: string; error?: string }> {
  try {
    const u = new URL(rawUrl);
    if (u.pathname.includes('/feeds/videos.xml')) {
      return { feedUrl: u.toString() };
    }
    const channelMatch = u.pathname.match(/\/channel\/(UC[a-zA-Z0-9_-]+)/);
    if (channelMatch) {
      return { feedUrl: `https://www.youtube.com/feeds/videos.xml?channel_id=${channelMatch[1]}` };
    }
  } catch {
    return { error: 'URL 格式无效' };
  }

  const res = await fetchText(rawUrl, 12000);
  if (!res.ok) {
    return { error: res.error || '无法访问 YouTube 页面（请检查本机网络环境）' };
  }
  const rssMatch = res.text.match(/https:\/\/www\.youtube\.com\/feeds\/videos\.xml\?channel_id=([a-zA-Z0-9_-]+)/);
  if (rssMatch) {
    const titleMatch = res.text.match(/<title>([^<]+)<\/title>/i);
    return {
      feedUrl: rssMatch[0],
      title: titleMatch ? titleMatch[1].replace(/\s*-\s*YouTube$/i, '').trim() : undefined,
    };
  }
  const idMatch = res.text.match(/"channelId":"(UC[a-zA-Z0-9_-]+)"/) || res.text.match(/"externalId":"(UC[a-zA-Z0-9_-]+)"/);
  if (idMatch) {
    return { feedUrl: `https://www.youtube.com/feeds/videos.xml?channel_id=${idMatch[1]}` };
  }
  return { error: '未能从该页面识别出 YouTube 频道 ID（请确认输入的是频道主页或频道 RSS）' };
}

export const youtubeAdapter: PlatformAdapter = {
  platform: 'youtube',
  displayName: 'YouTube 创作者',
  profilePlatform: 'youtube',
  defaultCapability: '已接入并验证',

  async checkLoginStatus(): Promise<LoginCheckResult> {
    try {
      const loggedIn = await withHeadlessContext('youtube', 'login-check', async (ctx) => {
        const page = ctx.pages()[0] || (await ctx.newPage());
        await page.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
        const cookies = await ctx.cookies('https://www.youtube.com');
        return cookies.some((c) => ['SID', 'SAPISID', '__Secure-3PAPISID'].includes(c.name));
      });
      updateProfileStatus('youtube', {
        login_status: loggedIn ? 'logged_in' : 'optional',
        capability_status: '已接入并验证',
        needs_attention: 0,
      });
      return {
        loggedIn: true,
        status: loggedIn ? 'logged_in' : 'optional',
        capabilityStatus: '已接入并验证',
        message: loggedIn ? 'YouTube 独立浏览器已登录（公开频道免登录也可通过官方 RSS 采集）' : '公开频道无需登录即可通过官方 RSS 采集',
        needsAttention: false,
      };
    } catch (err) {
      const msg = (err as Error).message;
      return {
        loggedIn: false,
        status: 'error',
        capabilityStatus: '暂时不可用',
        message: `YouTube 连接检测失败: ${msg}`,
        needsAttention: false,
      };
    }
  },

  async checkAvailability(url: string): Promise<AvailabilityResult> {
    const resolved = await resolveChannelFeedUrl(url);
    if (!resolved.feedUrl) {
      return {
        available: false,
        message: resolved.error || '无法解析 YouTube 频道地址',
        capabilityStatus: '暂时不可用',
      };
    }
    const feedRes = await fetchText(resolved.feedUrl, 12000);
    if (!feedRes.ok) {
      return {
        available: false,
        message: `YouTube 频道订阅访问失败: ${feedRes.error}`,
        capabilityStatus: '暂时不可用',
      };
    }
    const parsed = parseFeedContent(feedRes.text, resolved.feedUrl);
    return {
      available: true,
      detectedTitle: parsed.feedTitle || resolved.title || 'YouTube 频道',
      detectedFeedUrl: resolved.feedUrl,
      message: `YouTube 频道检测正常，发现 ${parsed.items.length} 条公开视频`,
      capabilityStatus: '已接入并验证',
    };
  },

  async fetchLatest(source: SourceRecord, options): Promise<FetchResult> {
    const logs: string[] = [];
    const writeLog = (m: string) => {
      logs.push(m);
      options.onLog?.(m);
    };

    writeLog(`开始检查 YouTube 频道: ${source.url}`);
    const resolved = await resolveChannelFeedUrl(source.url);
    if (resolved.feedUrl) {
      writeLog(`解析到官方频道订阅: ${resolved.feedUrl}`);
      const feedRes = await fetchText(resolved.feedUrl, 15000, options.signal);
      if (feedRes.ok) {
        const parsed = parseFeedContent(feedRes.text, resolved.feedUrl);
        const items: ExtractedContentItem[] = parsed.items.map((it) => ({
          ...it,
          platformItemId: it.platformItemId?.replace(/^yt:video:/, '') || it.platformItemId,
        }));
        writeLog(`成功获取 ${items.length} 条 YouTube 视频`);
        return { ok: true, capabilityStatus: '已接入并验证', items, logs };
      }
      writeLog(`官方频道订阅拉取失败 (${feedRes.error})，尝试独立浏览器读取`);
    } else {
      writeLog(`RSS 识别失败 (${resolved.error})，尝试独立浏览器读取`);
    }

    try {
      const items = await withHeadlessContext(
        'youtube',
        `source:${source.id}`,
        async (ctx) => {
          const page = ctx.pages()[0] || (await ctx.newPage());
          await page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
          await page.waitForTimeout(2500);
          return await page.evaluate(() => {
            const cards = Array.from(document.querySelectorAll('ytd-rich-item-renderer, ytd-grid-video-renderer')).slice(0, 15);
            const author = document.querySelector('#channel-name yt-formatted-string, ytd-channel-name yt-formatted-string')?.textContent?.trim() || '';
            return cards
              .map((el) => {
                const a = el.querySelector('a#video-title-link, a#video-title') as HTMLAnchorElement | null;
                if (!a || !a.href) return null;
                const img = el.querySelector('img') as HTMLImageElement | null;
                const urlObj = new URL(a.href, location.origin);
                const vid = urlObj.searchParams.get('v');
                return {
                  platformItemId: vid,
                  url: a.href,
                  title: (a.textContent || a.getAttribute('title') || '').trim(),
                  author,
                  summary: '',
                  body: '',
                  coverUrl: img?.src || '',
                };
              })
              .filter((x): x is NonNullable<typeof x> => Boolean(x && x.title));
          });
        },
        { headless: options.headless }
      );
      writeLog(`独立浏览器提取到 ${items.length} 条视频`);
      return { ok: true, capabilityStatus: '已接入并验证', items, logs };
    } catch (err) {
      const msg = (err as Error).message;
      writeLog(`YouTube 采集失败: ${msg}`);
      return { ok: false, capabilityStatus: '暂时不可用', items: [], logs, errorMessage: msg };
    }
  },
};
