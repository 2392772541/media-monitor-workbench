import { XMLParser } from 'fast-xml-parser';
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import type { ExtractedContentItem } from './types.js';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

export async function fetchText(
  url: string,
  timeoutMs = 15000,
  signal?: AbortSignal
): Promise<{ ok: boolean; status: number; finalUrl: string; contentType: string; text: string; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Request timeout')), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason || new Error('Aborted'));
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer);
      return { ok: false, status: 0, finalUrl: url, contentType: '', text: '', error: '任务已取消' };
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': DEFAULT_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml,application/rss+xml,application/atom+xml,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
    const text = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      finalUrl: res.url || url,
      contentType: res.headers.get('content-type') || '',
      text,
      error: res.ok ? undefined : `HTTP ${res.status} ${res.statusText}`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      finalUrl: url,
      contentType: '',
      text: '',
      error: (err as Error).message || '网络请求失败',
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export function stripHtml(html: string): string {
  if (!html) return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function textVal(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v).trim();
  if (Array.isArray(v)) return textVal(v[0]);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('#text' in o) return textVal(o['#text']);
    if ('@_href' in o) return textVal(o['@_href']);
    if ('_text' in o) return textVal(o['_text']);
  }
  return '';
}

function safeDateIso(raw?: string): string | null {
  if (!raw) return null;
  const d = new Date(raw.trim());
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function resolveAbsUrl(href: string, baseUrl: string): string {
  if (!href) return '';
  try {
    return new URL(href.trim(), baseUrl).toString();
  } catch {
    return href.trim();
  }
}

export function parseFeedContent(rawText: string, feedUrl: string): { feedTitle: string; items: ExtractedContentItem[] } {
  const trimmed = rawText.trim();
  if (trimmed.startsWith('{')) {
    const jf = JSON.parse(trimmed) as {
      title?: string;
      items?: Array<{
        id?: string;
        url?: string;
        title?: string;
        content_text?: string;
        content_html?: string;
        summary?: string;
        image?: string;
        date_published?: string;
        date_modified?: string;
        tags?: string[];
        authors?: Array<{ name?: string }>;
      }>;
    };
    const items: ExtractedContentItem[] = (jf.items || [])
      .filter((it) => it.url || it.id)
      .slice(0, 30)
      .map((it) => {
        const body = it.content_text || stripHtml(it.content_html || it.summary || '');
        return {
          platformItemId: it.id || null,
          url: resolveAbsUrl(it.url || feedUrl, feedUrl),
          title: it.title || '(无标题)',
          author: it.authors?.[0]?.name || jf.title || '',
          summary: (it.summary || body).slice(0, 260),
          body,
          coverUrl: it.image ? resolveAbsUrl(it.image, feedUrl) : '',
          tags: it.tags || [],
          publishedAt: safeDateIso(it.date_published),
          pageUpdatedAt: safeDateIso(it.date_modified),
        };
      });
    return { feedTitle: jf.title || '', items };
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    trimValues: true,
  });
  const parsed = parser.parse(trimmed) as Record<string, unknown>;

  const rssChannel = (parsed.rss as Record<string, unknown> | undefined)?.channel as Record<string, unknown> | undefined;
  if (rssChannel) {
    const feedTitle = textVal(rssChannel.title);
    const rawItems = Array.isArray(rssChannel.item) ? rssChannel.item : rssChannel.item ? [rssChannel.item] : [];
    const items: ExtractedContentItem[] = rawItems.slice(0, 30).map((raw: Record<string, unknown>) => {
      const link = resolveAbsUrl(textVal(raw.link) || textVal(raw.guid), feedUrl);
      const htmlBody = textVal(raw['content:encoded']) || textVal(raw.description) || '';
      const plainBody = stripHtml(htmlBody);
      const firstImgMatch = htmlBody.match(/<img[^>]+src=["']([^"']+)["']/i);
      const enc = raw.enclosure as Record<string, unknown> | undefined;
      const mediaThumb = raw['media:thumbnail'] as Record<string, unknown> | undefined;
      const cover =
        (enc && String(enc['@_type'] || '').startsWith('image') ? String(enc['@_url'] || '') : '') ||
        (mediaThumb ? String(mediaThumb['@_url'] || '') : '') ||
        (firstImgMatch ? firstImgMatch[1] : '');
      const rawCats = Array.isArray(raw.category) ? raw.category : raw.category ? [raw.category] : [];
      const tags = rawCats.map((c) => textVal(c)).filter(Boolean);

      return {
        platformItemId: textVal(raw.guid) || null,
        url: link,
        title: stripHtml(textVal(raw.title)) || '(无标题)',
        author: textVal(raw['dc:creator']) || textVal(raw.author) || feedTitle,
        summary: plainBody.slice(0, 260),
        body: plainBody,
        coverUrl: cover ? resolveAbsUrl(cover, link || feedUrl) : '',
        tags,
        publishedAt: safeDateIso(textVal(raw.pubDate) || textVal(raw['dc:date'])),
      };
    });
    return { feedTitle, items: items.filter((i) => i.url) };
  }

  const atomFeed = parsed.feed as Record<string, unknown> | undefined;
  if (atomFeed) {
    const feedTitle = textVal(atomFeed.title);
    const rawEntries = Array.isArray(atomFeed.entry) ? atomFeed.entry : atomFeed.entry ? [atomFeed.entry] : [];
    const items: ExtractedContentItem[] = rawEntries.slice(0, 30).map((entry: Record<string, unknown>) => {
      const links = Array.isArray(entry.link) ? entry.link : entry.link ? [entry.link] : [];
      const altLink =
        links.find((l: Record<string, unknown>) => l['@_rel'] === 'alternate' || !l['@_rel']) || links[0] || {};
      const href = resolveAbsUrl(textVal((altLink as Record<string, unknown>)['@_href'] || altLink), feedUrl);
      const htmlBody = textVal(entry.content) || textVal(entry.summary) || '';
      const plainBody = stripHtml(htmlBody);
      const mediaGroup = entry['media:group'] as Record<string, unknown> | undefined;
      const mediaDesc = stripHtml(textVal(mediaGroup?.['media:description']));
      const mediaThumb = (mediaGroup?.['media:thumbnail'] || entry['media:thumbnail']) as
        | Record<string, unknown>
        | undefined;
      const firstImgMatch = htmlBody.match(/<img[^>]+src=["']([^"']+)["']/i);
      const cover = (mediaThumb ? String(mediaThumb['@_url'] || '') : '') || (firstImgMatch ? firstImgMatch[1] : '');
      const authorObj = entry.author as Record<string, unknown> | undefined;

      return {
        platformItemId: textVal(entry.id) || null,
        url: href,
        title: stripHtml(textVal(entry.title)) || '(无标题)',
        author: textVal(authorObj?.name) || feedTitle,
        summary: stripHtml(textVal(entry.summary) || plainBody || mediaDesc).slice(0, 260),
        body: plainBody || mediaDesc,
        coverUrl: cover ? resolveAbsUrl(cover, href || feedUrl) : '',
        tags: [],
        publishedAt: safeDateIso(textVal(entry.published) || textVal(entry.updated)),
        pageUpdatedAt: safeDateIso(textVal(entry.updated)),
      };
    });
    return { feedTitle, items: items.filter((i) => i.url) };
  }

  return { feedTitle: '', items: [] };
}

export function discoverRssLinks(html: string, baseUrl: string): string[] {
  const { document } = parseHTML(html);
  const links: string[] = [];
  const els = document.querySelectorAll('link[rel~="alternate"]');
  for (const el of els) {
    const type = (el.getAttribute('type') || '').toLowerCase();
    const href = el.getAttribute('href');
    if (
      href &&
      (type.includes('rss') || type.includes('atom') || type.includes('xml') || type.includes('feed+json'))
    ) {
      links.push(resolveAbsUrl(href, baseUrl));
    }
  }
  return Array.from(new Set(links));
}

export function extractArticleFromHtml(html: string, url: string): ExtractedContentItem {
  const { document } = parseHTML(html);

  const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content');
  const ogImage = document.querySelector('meta[property="og:image"]')?.getAttribute('content');
  const metaAuthor = document.querySelector('meta[name="author"]')?.getAttribute('content');
  const metaDesc =
    document.querySelector('meta[name="description"]')?.getAttribute('content') ||
    document.querySelector('meta[property="og:description"]')?.getAttribute('content') ||
    '';
  const pubTime =
    document.querySelector('meta[property="article:published_time"]')?.getAttribute('content') ||
    document.querySelector('meta[name="publishdate"]')?.getAttribute('content') ||
    document.querySelector('time[datetime]')?.getAttribute('datetime') ||
    '';
  const siteName =
    document.querySelector('meta[property="og:site_name"]')?.getAttribute('content') || new URL(url).hostname;

  let title = (ogTitle || document.title || '').trim();
  let body = '';
  let author = (metaAuthor || '').trim();
  let excerpt = metaDesc.trim();

  try {
    const reader = new Readability(document as unknown as Document);
    const parsed = reader.parse();
    if (parsed) {
      if (parsed.title && parsed.title.trim()) title = parsed.title.trim();
      if (parsed.textContent) body = parsed.textContent.replace(/\s+\n/g, '\n').trim();
      if (parsed.byline && !author) author = parsed.byline.trim();
      if (parsed.excerpt && !excerpt) excerpt = parsed.excerpt.trim();
    }
  } catch {
    // fallback below
  }

  if (!body) {
    const mainEl = document.querySelector('article, main, .post-content, .article-content, body');
    body = (mainEl?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  return {
    url,
    title: title || '(无标题)',
    author: author || siteName,
    summary: (excerpt || body).slice(0, 260),
    body,
    coverUrl: ogImage ? resolveAbsUrl(ogImage, url) : '',
    publishedAt: safeDateIso(pubTime),
  };
}

export function extractCandidateLinksFromIndexPage(html: string, baseUrl: string): Array<{ url: string; title: string }> {
  const { document } = parseHTML(html);
  const base = new URL(baseUrl);
  const seen = new Set<string>();
  const results: Array<{ url: string; title: string }> = [];

  const anchors = document.querySelectorAll('article a[href], main a[href], h1 a[href], h2 a[href], h3 a[href], .post a[href], a[href]');
  for (const a of anchors) {
    const rawHref = a.getAttribute('href') || '';
    if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('javascript:') || rawHref.startsWith('mailto:')) {
      continue;
    }
    let abs: URL;
    try {
      abs = new URL(rawHref, baseUrl);
    } catch {
      continue;
    }
    if (abs.hostname !== base.hostname) continue;
    if (abs.pathname === base.pathname || abs.pathname === '/' || abs.pathname.length < 3) continue;
    const lowerPath = abs.pathname.toLowerCase();
    if (
      /\.(png|jpg|jpeg|gif|svg|css|js|pdf|zip|ico)$/i.test(lowerPath) ||
      /\/(login|signup|register|tag|tags|category|categories|about|contact|privacy|terms|search)\/?$/i.test(lowerPath)
    ) {
      continue;
    }
    const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
    if (text.length < 6 || text.length > 180) continue;

    abs.hash = '';
    const finalStr = abs.toString();
    if (seen.has(finalStr)) continue;
    seen.add(finalStr);
    results.push({ url: finalStr, title: text });
    if (results.length >= 15) break;
  }
  return results;
}
