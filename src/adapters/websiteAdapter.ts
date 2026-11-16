import { XMLParser } from 'fast-xml-parser';
import { parseHTML } from 'linkedom';
import { getDb, canonicalizeUrl } from '../db/database.js';
import { withHeadlessContext } from '../browser/profileManager.js';
import type {
  AvailabilityResult,
  ExtractedContentItem,
  FetchResult,
  LoginCheckResult,
  PlatformAdapter,
  SourceRecord,
} from './types.js';
import {
  discoverRssLinks,
  extractArticleFromHtml,
  extractCandidateLinksFromIndexPage,
  fetchText,
  parseFeedContent,
} from './webUtils.js';

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function isAlreadyStored(platform: string, url: string): boolean {
  const db = getDb();
  const canonical = canonicalizeUrl(url);
  const row = db
    .prepare('SELECT id FROM contents WHERE platform = ? AND canonical_url = ? LIMIT 1')
    .get(platform, canonical);
  return Boolean(row);
}

async function fetchViaBrowser(url: string, headless: boolean): Promise<{ html: string; title: string }> {
  return withHeadlessContext(
    'other',
    `website:${new URL(url).hostname}`,
    async (ctx) => {
      const page = ctx.pages()[0] || (await ctx.newPage());
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await page.waitForTimeout(1500);
      const title = await page.title();
      const html = await page.content();
      return { html, title };
    },
    { headless }
  );
}

export const websiteAdapter: PlatformAdapter = {
  platform: 'website',
  displayName: '普通网站 / 博客 / 栏目',
  profilePlatform: 'other',
  defaultCapability: '已接入并验证',

  async checkLoginStatus(): Promise<LoginCheckResult> {
    return {
      loggedIn: true,
      status: 'optional',
      capabilityStatus: '已接入并验证',
      message: '公开网站无需登录（仅动态网页降级时使用独立浏览器）',
      needsAttention: false,
    };
  },

  async checkAvailability(url: string): Promise<AvailabilityResult> {
    const res = await fetchText(url, 15000);
    if (!res.ok) {
      return {
        available: false,
        message: `网页访问失败: ${res.error}`,
        capabilityStatus: '采集异常',
      };
    }

    if (res.contentType.includes('xml') || res.text.trim().startsWith('<?xml') || res.text.includes('<rss')) {
      const feed = parseFeedContent(res.text, res.finalUrl);
      return {
        available: feed.items.length > 0,
        detectedTitle: feed.feedTitle || new URL(url).hostname,
        detectedFeedUrl: res.finalUrl,
        message: `检测到订阅源，共 ${feed.items.length} 条内容`,
        capabilityStatus: '已接入并验证',
      };
    }

    const { document } = parseHTML(res.text);
    const title = (document.title || new URL(url).hostname).trim();
    const rssLinks = discoverRssLinks(res.text, res.finalUrl);
    const candidates = extractCandidateLinksFromIndexPage(res.text, res.finalUrl);

    return {
      available: true,
      detectedTitle: title,
      detectedFeedUrl: rssLinks[0],
      message: rssLinks.length > 0
        ? `网页可访问，自动发现 RSS 订阅 (${rssLinks[0]})`
        : `网页可访问，初步识别 ${candidates.length} 个候选链接`,
      capabilityStatus: '已接入并验证',
    };
  },

  async fetchLatest(source: SourceRecord, options): Promise<FetchResult> {
    const logs: string[] = [];
    const writeLog = (m: string) => {
      logs.push(m);
      options.onLog?.(m);
    };

    writeLog(`开始检查网站: ${source.url}`);
    let res = await fetchText(source.url, 15000, options.signal);
    let html = res.text;
    let finalUrl = res.finalUrl;

    if (res.ok && (res.contentType.includes('xml') || html.trim().startsWith('<?xml') || html.includes('<rss'))) {
      const parsed = parseFeedContent(html, finalUrl);
      if (parsed.items.length > 0) {
        writeLog(`直接解析 XML 订阅，获取 ${parsed.items.length} 条`);
        return { ok: true, capabilityStatus: '已接入并验证', items: parsed.items, logs };
      }
    }

    if (res.ok && html) {
      const rssLinks = discoverRssLinks(html, finalUrl);
      if (rssLinks.length > 0) {
        writeLog(`自动发现 RSS 地址: ${rssLinks[0]}，优先采用 RSS 轻量采集`);
        const feedRes = await fetchText(rssLinks[0], 15000, options.signal);
        if (feedRes.ok) {
          try {
            const parsed = parseFeedContent(feedRes.text, feedRes.finalUrl);
            if (parsed.items.length > 0) {
              writeLog(`RSS 解析成功，共 ${parsed.items.length} 条内容`);
              return { ok: true, capabilityStatus: '已接入并验证', items: parsed.items, logs };
            }
          } catch (err) {
            writeLog(`RSS 解析失败，回退网页正文模式: ${(err as Error).message}`);
          }
        }
      }
    }

    let candidates = res.ok ? extractCandidateLinksFromIndexPage(html, finalUrl) : [];
    if (res.ok && candidates.length === 0) {
      try {
        const origin = new URL(finalUrl).origin;
        const smRes = await fetchText(`${origin}/sitemap.xml`, 8000, options.signal);
        if (smRes.ok && smRes.text.includes('<urlset')) {
          const parser = new XMLParser({ ignoreAttributes: true });
          const sm = parser.parse(smRes.text) as { urlset?: { url?: Array<{ loc?: string }> | { loc?: string } } };
          const rawUrls = Array.isArray(sm.urlset?.url) ? sm.urlset.url : sm.urlset?.url ? [sm.urlset.url] : [];
          candidates = rawUrls
            .map((u) => String(u.loc || '').trim())
            .filter((u) => u && u !== finalUrl)
            .slice(0, 8)
            .map((u) => ({ url: u, title: '' }));
          if (candidates.length > 0) {
            writeLog(`从 sitemap.xml 发现 ${candidates.length} 个页面链接`);
          }
        }
      } catch {
        // ignore sitemap errors
      }
    }

    if (!res.ok || (candidates.length === 0 && html.length < 2500)) {
      writeLog(`HTTP 静态读取未获取到足够内容 (${res.error || '可能为动态渲染站点'})，尝试独立无界面浏览器加载...`);
      try {
        const rendered = await fetchViaBrowser(source.url, options.headless);
        html = rendered.html;
        finalUrl = source.url;
        candidates = extractCandidateLinksFromIndexPage(html, finalUrl);
        writeLog(`浏览器渲染完成，识别到 ${candidates.length} 个候选链接`);
      } catch (err) {
        const errMsg = (err as Error).message;
        writeLog(`独立浏览器加载失败: ${errMsg}`);
        return {
          ok: false,
          capabilityStatus: '采集异常',
          items: [],
          logs,
          errorMessage: res.error || errMsg,
        };
      }
    }

    const items: ExtractedContentItem[] = [];

    if (candidates.length === 0) {
      const single = extractArticleFromHtml(html, finalUrl);
      if (single.body || single.title) {
        items.push(single);
        writeLog(`提取当前单页内容: ${single.title}`);
      }
    } else {
      writeLog(`发现 ${candidates.length} 个候选文章链接，开始增量抓取详情（已入库链接将自动跳过）`);
      let fetchedCount = 0;
      for (const cand of candidates) {
        if (options.signal?.aborted) break;
        if (isAlreadyStored(source.platform, cand.url)) {
          continue;
        }
        if (fetchedCount >= 8) break;
        fetchedCount++;
        const detailRes = await fetchText(cand.url, 12000, options.signal);
        if (detailRes.ok && detailRes.text) {
          const article = extractArticleFromHtml(detailRes.text, detailRes.finalUrl);
          if (!article.title || article.title === '(无标题)') {
            article.title = cand.title || article.title;
          }
          items.push(article);
          writeLog(`提取文章: ${article.title}`);
        }
        await sleep(250);
      }
      if (items.length === 0 && fetchedCount === 0) {
        writeLog(`所有 ${candidates.length} 个候选链接均已在库中，无新增文章`);
      }
    }

    return {
      ok: true,
      capabilityStatus: '已接入并验证',
      items,
      logs,
    };
  },
};
