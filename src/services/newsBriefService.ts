import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseHTML } from 'linkedom';
import { PATHS } from '../config.js';
import { getDb } from '../db/database.js';
import { fetchText, parseFeedContent } from '../adapters/webUtils.js';
import { callAiJsonWithCache } from './aiRadarService.js';
import { log } from '../utils/logger.js';

export interface NewsSourceConfig {
  id: string;
  name: string;
  region: 'domestic' | 'global';
  kind: 'rss' | 'hn_api' | 'github_trending';
  url: string;
  category: string;
  enabled: boolean;
  builtin?: boolean;
}

export interface NewsBriefItem {
  id: string;
  sourceId: string;
  sourceName: string;
  region: 'domestic' | 'global';
  category: string;
  title: string;
  titleZh?: string;
  summary: string;
  summaryZh?: string;
  url: string;
  publishedAt: string | null;
  heatLabel?: string;
  matchedKeywords: string[];
}

export interface DailyAiDigest {
  headline: string;
  topStories: Array<{
    titleZh: string;
    region: 'domestic' | 'global';
    sourceName: string;
    whyItMatters: string;
    videoAngle: string;
    url: string;
  }>;
  generatedAt: string;
}

interface NewsBriefCache {
  updatedAt: string | null;
  items: NewsBriefItem[];
  sourceStats: Array<{ id: string; name: string; region: 'domestic' | 'global'; count: number; error?: string }>;
  digest: DailyAiDigest | null;
}

export const DEFAULT_FOCUS_KEYWORDS = [
  'AI',
  '大模型',
  '智能体',
  'Agent',
  '工作流',
  'Claude',
  'GPT',
  'Gemini',
  'DeepSeek',
  '开源',
  '效率',
  '工具',
  '视频',
  '自媒体',
];

export const DEFAULT_BLOCK_KEYWORDS = ['NBA', '曼联', '欧冠', '国足', '热火', '76人', '恋情', '绯闻', '结婚', '离婚'];

export const DEFAULT_NEWS_SOURCES: NewsSourceConfig[] = [
  {
    id: 'qbitai',
    name: '量子位',
    region: 'domestic',
    kind: 'rss',
    url: 'https://www.qbitai.com/feed',
    category: '国内 AI 前沿',
    enabled: true,
    builtin: true,
  },
  {
    id: 'jiqizhixin',
    name: '机器之心',
    region: 'domestic',
    kind: 'rss',
    url: 'https://www.jiqizhixin.com/rss',
    category: '国内 AI 前沿',
    enabled: true,
    builtin: true,
  },
  {
    id: '36kr',
    name: '36氪科技',
    region: 'domestic',
    kind: 'rss',
    url: 'https://36kr.com/feed',
    category: '创投科技',
    enabled: true,
    builtin: true,
  },
  {
    id: 'sspai',
    name: '少数派',
    region: 'domestic',
    kind: 'rss',
    url: 'https://sspai.com/feed',
    category: '效率工具',
    enabled: true,
    builtin: true,
  },
  {
    id: 'ithome',
    name: 'IT之家',
    region: 'domestic',
    kind: 'rss',
    url: 'https://www.ithome.com/rss/',
    category: '数码快讯',
    enabled: false,
    builtin: true,
  },
  {
    id: 'hn_ai',
    name: 'Hacker News AI',
    region: 'global',
    kind: 'hn_api',
    url: 'https://hn.algolia.com/api/v1/search_by_date?tags=story&query=AI&numericFilters=points>30&hitsPerPage=15',
    category: '海外热议',
    enabled: true,
    builtin: true,
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    region: 'global',
    kind: 'rss',
    url: 'https://huggingface.co/blog/feed.xml',
    category: '开源模型',
    enabled: true,
    builtin: true,
  },
  {
    id: 'techcrunch_ai',
    name: 'TechCrunch AI',
    region: 'global',
    kind: 'rss',
    url: 'https://techcrunch.com/category/artificial-intelligence/feed/',
    category: '海外 AI 快讯',
    enabled: true,
    builtin: true,
  },
  {
    id: 'openai',
    name: 'OpenAI 官方',
    region: 'global',
    kind: 'rss',
    url: 'https://openai.com/news/rss.xml',
    category: '大厂官方',
    enabled: true,
    builtin: true,
  },
  {
    id: 'producthunt',
    name: 'Product Hunt',
    region: 'global',
    kind: 'rss',
    url: 'https://www.producthunt.com/feed',
    category: '海外新工具',
    enabled: true,
    builtin: true,
  },
  {
    id: 'github_trending',
    name: 'GitHub 今日热榜',
    region: 'global',
    kind: 'github_trending',
    url: 'https://github.com/trending?since=daily',
    category: '开源飙升',
    enabled: true,
    builtin: true,
  },
  {
    id: 'verge_ai',
    name: 'The Verge AI',
    region: 'global',
    kind: 'rss',
    url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml',
    category: '海外科技',
    enabled: false,
    builtin: true,
  },
];

const CACHE_FILE = path.join(PATHS.dataDir, 'news_brief_cache.json');

function getSettingJson<T>(key: string, fallback: T): T {
  const db = getDb();
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
  if (!row?.value) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

function setSettingJson(key: string, val: unknown): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, JSON.stringify(val), new Date().toISOString());
}

export function getUserMonitorPrefs(): {
  focusKeywords: string[];
  blockKeywords: string[];
  newsSources: NewsSourceConfig[];
} {
  const focusKeywords = getSettingJson<string[]>('user_focus_keywords', DEFAULT_FOCUS_KEYWORDS);
  const blockKeywords = getSettingJson<string[]>('user_block_keywords', DEFAULT_BLOCK_KEYWORDS);
  const savedSources = getSettingJson<NewsSourceConfig[] | null>('user_news_sources', null);

  let newsSources: NewsSourceConfig[];
  if (!savedSources || !Array.isArray(savedSources) || savedSources.length === 0) {
    newsSources = DEFAULT_NEWS_SOURCES.map((s) => ({ ...s }));
  } else {
    // 合并新增内置源，同时尊重用户的开关和自定义源
    const byId = new Map(savedSources.map((s) => [s.id, s]));
    for (const def of DEFAULT_NEWS_SOURCES) {
      if (!byId.has(def.id)) {
        savedSources.push({ ...def });
      }
    }
    newsSources = savedSources;
  }

  return { focusKeywords, blockKeywords, newsSources };
}

export function saveUserKeywords(params: { focusKeywords?: string[]; blockKeywords?: string[] }): {
  focusKeywords: string[];
  blockKeywords: string[];
} {
  const cur = getUserMonitorPrefs();
  const clean = (arr: string[]) =>
    Array.from(new Set(arr.map((x) => String(x || '').trim()).filter((x) => x.length >= 1))).slice(0, 60);
  const focus = params.focusKeywords !== undefined ? clean(params.focusKeywords) : cur.focusKeywords;
  const block = params.blockKeywords !== undefined ? clean(params.blockKeywords) : cur.blockKeywords;
  if (params.focusKeywords !== undefined) setSettingJson('user_focus_keywords', focus);
  if (params.blockKeywords !== undefined) setSettingJson('user_block_keywords', block);
  return { focusKeywords: focus, blockKeywords: block };
}

export function upsertUserNewsSource(input: {
  id?: string;
  name: string;
  url: string;
  region?: 'domestic' | 'global';
  category?: string;
  enabled?: boolean;
}): NewsSourceConfig[] {
  const prefs = getUserMonitorPrefs();
  const list = [...prefs.newsSources];
  const cleanUrl = input.url.trim();
  if (!/^https?:\/\//i.test(cleanUrl)) {
    throw new Error('请填写以 http:// 或 https:// 开头的有效新闻/RSS 网址');
  }
  const cleanName = input.name.trim() || new URL(cleanUrl).hostname;
  const id = input.id || `custom_${crypto.createHash('md5').update(cleanUrl).digest('hex').slice(0, 8)}`;
  const idx = list.findIndex((s) => s.id === id);
  const item: NewsSourceConfig = {
    id,
    name: cleanName,
    region: input.region === 'global' ? 'global' : 'domestic',
    kind: 'rss',
    url: cleanUrl,
    category: (input.category || '自定义订阅').trim(),
    enabled: input.enabled !== false,
    builtin: false,
  };
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...item, builtin: list[idx].builtin };
  } else {
    list.unshift(item);
  }
  setSettingJson('user_news_sources', list);
  return list;
}

export function toggleUserNewsSource(id: string, enabled: boolean): NewsSourceConfig[] {
  const prefs = getUserMonitorPrefs();
  const list = prefs.newsSources.map((s) => (s.id === id ? { ...s, enabled } : s));
  setSettingJson('user_news_sources', list);
  return list;
}

export function deleteUserNewsSource(id: string): NewsSourceConfig[] {
  const prefs = getUserMonitorPrefs();
  const list = prefs.newsSources.filter((s) => s.id !== id || s.builtin);
  setSettingJson('user_news_sources', list);
  return list;
}

export function matchKeywordsInText(text: string, keywords: string[]): string[] {
  const lower = (text || '').toLowerCase();
  if (!lower || keywords.length === 0) return [];
  const hits: string[] = [];
  for (const kw of keywords) {
    const k = kw.trim();
    if (!k) continue;
    if (lower.includes(k.toLowerCase())) hits.push(k);
  }
  return hits;
}

function readCache(): NewsBriefCache {
  try {
    if (!fs.existsSync(CACHE_FILE)) {
      return { updatedAt: null, items: [], sourceStats: [], digest: null };
    }
    const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) as NewsBriefCache;
    return {
      updatedAt: parsed.updatedAt || null,
      items: Array.isArray(parsed.items) ? parsed.items : [],
      sourceStats: Array.isArray(parsed.sourceStats) ? parsed.sourceStats : [],
      digest: parsed.digest || null,
    };
  } catch {
    return { updatedAt: null, items: [], sourceStats: [], digest: null };
  }
}

function saveCache(cache: NewsBriefCache): void {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
}

function makeItemId(url: string, title: string): string {
  return crypto.createHash('md5').update(`${url}|${title}`).digest('hex').slice(0, 12);
}

// 抓取 GitHub Trending 今日开源飙升项目（复用于早报和专属热榜）
export async function fetchGitHubTrendingItems(limit = 15): Promise<
  Array<{ title: string; url: string; summary: string; heatLabel: string; language: string }>
> {
  const res = await fetchText('https://github.com/trending?since=daily', 12000);
  if (!res.ok) throw new Error(res.error || 'GitHub Trending 请求失败');
  const { document } = parseHTML(res.text);
  const rows = Array.from(document.querySelectorAll('article.Box-row'));
  const out: Array<{ title: string; url: string; summary: string; heatLabel: string; language: string }> = [];
  for (const row of rows.slice(0, limit)) {
    const linkEl = row.querySelector('h2 a');
    const href = linkEl?.getAttribute('href')?.trim() || '';
    const repoName = (linkEl?.textContent || '').replace(/\s+/g, ' ').replace(/\s*\/\s*/g, '/').trim();
    if (!repoName || !href) continue;
    const desc = (row.querySelector('p')?.textContent || '').replace(/\s+/g, ' ').trim();
    const lang = (row.querySelector('[itemprop="programmingLanguage"]')?.textContent || '').trim();
    const starsToday = (row.querySelector('.float-sm-right')?.textContent || '').replace(/\s+/g, ' ').trim();
    out.push({
      title: repoName,
      url: `https://github.com${href}`,
      summary: desc || `${repoName} GitHub 今日趋势项目`,
      heatLabel: starsToday || '今日热门开源',
      language: lang || '开源项目',
    });
  }
  return out;
}

// 抓取单条新闻源（支持 RSS/Atom、Hacker News Algolia API、GitHub Trending）
async function fetchSingleNewsSource(
  src: NewsSourceConfig,
  focusKeywords: string[]
): Promise<{ items: NewsBriefItem[]; error?: string }> {
  try {
    if (src.kind === 'hn_api') {
      const res = await fetch(src.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 Chrome/134.0.0.0 Safari/537.36', Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return { items: [], error: `HTTP ${res.status}` };
      const json = (await res.json()) as {
        hits?: Array<{
          objectID?: string;
          title?: string;
          url?: string;
          points?: number;
          num_comments?: number;
          created_at?: string;
        }>;
      };
      const items: NewsBriefItem[] = (json.hits || [])
        .filter((h) => h.title)
        .slice(0, 12)
        .map((h) => {
          const title = String(h.title || '').trim();
          const url = h.url || `https://news.ycombinator.com/item?id=${h.objectID}`;
          const summary = `Hacker News 热议 · ${h.points ?? 0} 赞 · ${h.num_comments ?? 0} 评论`;
          return {
            id: makeItemId(url, title),
            sourceId: src.id,
            sourceName: src.name,
            region: src.region,
            category: src.category,
            title,
            summary,
            url,
            publishedAt: h.created_at || null,
            heatLabel: `${h.points ?? 0} 赞 · ${h.num_comments ?? 0} 评`,
            matchedKeywords: matchKeywordsInText(`${title} ${summary}`, focusKeywords),
          };
        });
      return { items };
    }

    if (src.kind === 'github_trending') {
      const repos = await fetchGitHubTrendingItems(12);
      const items: NewsBriefItem[] = repos.map((r) => ({
        id: makeItemId(r.url, r.title),
        sourceId: src.id,
        sourceName: src.name,
        region: src.region,
        category: r.language || src.category,
        title: r.title,
        summary: r.summary,
        url: r.url,
        publishedAt: new Date().toISOString(),
        heatLabel: r.heatLabel,
        matchedKeywords: matchKeywordsInText(`${r.title} ${r.summary} ${r.language}`, focusKeywords),
      }));
      return { items };
    }

    // 默认 RSS / Atom 订阅源
    const res = await fetchText(src.url, 10000);
    if (!res.ok) return { items: [], error: res.error || '无法连接' };
    const parsed = parseFeedContent(res.text, res.finalUrl);
    const items: NewsBriefItem[] = parsed.items.slice(0, 12).map((it) => {
      const title = (it.title || '').trim();
      const summary = (it.summary || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
      return {
        id: makeItemId(it.url, title),
        sourceId: src.id,
        sourceName: src.name,
        region: src.region,
        category: src.category,
        title,
        summary,
        url: it.url,
        publishedAt: it.publishedAt || null,
        matchedKeywords: matchKeywordsInText(`${title} ${summary}`, focusKeywords),
      };
    });
    return { items };
  } catch (err) {
    return { items: [], error: (err as Error).message };
  }
}

export async function refreshNewsBrief(): Promise<NewsBriefCache> {
  const { focusKeywords, newsSources } = getUserMonitorPrefs();
  const prev = readCache();
  // 保留已翻译好的中文标题/简介缓存，避免每次刷新海外新闻重复消耗大模型
  const prevTrans = new Map<string, { titleZh?: string; summaryZh?: string }>();
  for (const it of prev.items) {
    if (it.titleZh || it.summaryZh) {
      prevTrans.set(it.id, { titleZh: it.titleZh, summaryZh: it.summaryZh });
    }
  }

  const enabled = newsSources.filter((s) => s.enabled);
  const settled = await Promise.allSettled(enabled.map((src) => fetchSingleNewsSource(src, focusKeywords)));

  const items: NewsBriefItem[] = [];
  const seenUrl = new Set<string>();
  const sourceStats: NewsBriefCache['sourceStats'] = [];

  settled.forEach((res, idx) => {
    const src = enabled[idx];
    if (res.status === 'fulfilled') {
      sourceStats.push({
        id: src.id,
        name: src.name,
        region: src.region,
        count: res.value.items.length,
        error: res.value.error,
      });
      for (const it of res.value.items) {
        if (!it.title || seenUrl.has(it.url)) continue;
        seenUrl.add(it.url);
        const cachedZh = prevTrans.get(it.id);
        if (cachedZh) {
          it.titleZh = cachedZh.titleZh;
          it.summaryZh = cachedZh.summaryZh;
        }
        items.push(it);
      }
    } else {
      sourceStats.push({
        id: src.id,
        name: src.name,
        region: src.region,
        count: 0,
        error: res.reason instanceof Error ? res.reason.message : String(res.reason),
      });
    }
  });

  // 按发布时间倒序（时间相近的优先把命中关注词的排前面）
  items.sort((a, b) => {
    const ta = a.publishedAt ? Date.parse(a.publishedAt) || 0 : 0;
    const tb = b.publishedAt ? Date.parse(b.publishedAt) || 0 : 0;
    if (Math.abs(tb - ta) > 12 * 3600 * 1000) return tb - ta;
    if (b.matchedKeywords.length !== a.matchedKeywords.length) {
      return b.matchedKeywords.length - a.matchedKeywords.length;
    }
    return tb - ta;
  });

  const next: NewsBriefCache = {
    updatedAt: new Date().toISOString(),
    items: items.slice(0, 120),
    sourceStats,
    digest: prev.digest,
  };
  saveCache(next);
  log('INFO', 'news-brief', `Refreshed ${next.items.length} domestic & global AI news items from ${enabled.length} sources`);
  return next;
}

export function getNewsBriefSnapshot(): NewsBriefCache & {
  focusKeywords: string[];
  blockKeywords: string[];
  newsSources: NewsSourceConfig[];
} {
  const prefs = getUserMonitorPrefs();
  const cache = readCache();
  // 动态重算关键词匹配，保证用户改完关注词立即生效
  const items = cache.items.map((it) => ({
    ...it,
    matchedKeywords: matchKeywordsInText(
      `${it.title} ${it.titleZh || ''} ${it.summary} ${it.summaryZh || ''}`,
      prefs.focusKeywords
    ),
  }));
  return {
    ...cache,
    items,
    ...prefs,
  };
}

// 一键生成「今日 1 分钟国内外 AI 早报」并自动翻译海外英文新闻标题与一句话摘要
export async function generateDailyAiDigest(forceRefresh = false): Promise<{
  digest: DailyAiDigest;
  translatedCount: number;
  cached: boolean;
}> {
  let cache = readCache();
  if (cache.items.length === 0) {
    cache = await refreshNewsBrief();
  }
  const { focusKeywords, blockKeywords } = getUserMonitorPrefs();
  const cleanItems = cache.items.filter(
    (it) => matchKeywordsInText(`${it.title} ${it.summary}`, blockKeywords).length === 0
  );

  const domesticPool = cleanItems.filter((x) => x.region === 'domestic').slice(0, 16);
  const globalPool = cleanItems.filter((x) => x.region === 'global').slice(0, 18);
  const combined = [...domesticPool, ...globalPool];
  if (combined.length === 0) {
    throw new Error('当前还没有抓取到新闻，请先点一次「刷新国内外热点」');
  }

  const lines = combined
    .map(
      (it) =>
        `[${it.id}] (${it.region === 'domestic' ? '国内' : '海外'}·${it.sourceName}) 标题: ${it.title} | 摘要: ${(it.summary || '').slice(0, 110)}`
    )
    .join('\n');

  const { data, cached } = await callAiJsonWithCache<{
    headline?: string;
    topStories?: Array<{
      id?: string;
      titleZh?: string;
      region?: string;
      sourceName?: string;
      whyItMatters?: string;
      videoAngle?: string;
    }>;
    globalTranslations?: Array<{
      id?: string;
      titleZh?: string;
      summaryZh?: string;
    }>;
  }>({
    purpose: 'daily_ai_news_digest',
    system: `你是顶级 AI 与科技自媒体主编，负责把每天杂乱的国内外资讯浓缩成创作者 1 分钟就能看完、立刻知道拍什么的「今日早报」。
严格要求：
1. 优先挑选跟用户关注方向高度相关、真正有信息增量的国内外大事/新工具/新模型（国内和海外都要有，不要娱乐水文）。
2. 所有文案说大白话中文，直接讲「发生了啥」「跟你有什么关系」「可以怎么拍成爆款视频」。
3. 同时把输入列表里的海外英文新闻（标注为海外的条目）全部翻成通顺简短的中文标题（titleZh）和一句话中文说明（summaryZh）。
4. 只返回严格 JSON，不要多余解释。`,
    user: `用户自定义关注词：${focusKeywords.join('、') || 'AI、科技、效率工具'}

今日采集到的国内外最新资讯列表：
${lines}

请返回 JSON：
{
  "headline": "今日一句话大趋势总结（25字以内）",
  "topStories": [
    {
      "id": "对应列表中的条目id",
      "titleZh": "通俗中文标题（22字以内）",
      "region": "domestic 或 global",
      "sourceName": "来源名",
      "whyItMatters": "一句话大白话讲清发生了什么、为什么值得关注（40字以内）",
      "videoAngle": "创作者可以直接拿来拍的切入角度或标题思路（35字以内）"
    }
  ],
  "globalTranslations": [
    {
      "id": "海外条目id",
      "titleZh": "流畅中文标题",
      "summaryZh": "一句大白话中文简介（35字以内）"
    }
  ]
}
注意：topStories 精选 5 条（尽量国内 2~3 条 + 海外 2~3 条）；globalTranslations 尽量覆盖列表里所有海外英文条目。`,
    temperature: 0.35,
    maxTokens: 2200,
    forceRefresh,
  });

  const itemById = new Map(cache.items.map((it) => [it.id, it]));
  let translatedCount = 0;
  for (const tr of data.globalTranslations || []) {
    if (!tr?.id) continue;
    const hit = itemById.get(tr.id);
    if (hit) {
      if (tr.titleZh) hit.titleZh = String(tr.titleZh).trim();
      if (tr.summaryZh) hit.summaryZh = String(tr.summaryZh).trim();
      translatedCount++;
    }
  }

  const topStories = (data.topStories || [])
    .slice(0, 6)
    .map((s) => {
      const origin = s.id ? itemById.get(s.id) : undefined;
      return {
        titleZh: String(s.titleZh || origin?.titleZh || origin?.title || '').trim(),
        region: (s.region === 'global' || origin?.region === 'global' ? 'global' : 'domestic') as 'domestic' | 'global',
        sourceName: String(s.sourceName || origin?.sourceName || '热点快讯').trim(),
        whyItMatters: String(s.whyItMatters || '').trim(),
        videoAngle: String(s.videoAngle || '').trim(),
        url: origin?.url || '',
      };
    })
    .filter((s) => s.titleZh);

  const digest: DailyAiDigest = {
    headline: String(data.headline || '今日国内外 AI 与科技一手精选已更新').trim(),
    topStories,
    generatedAt: new Date().toISOString(),
  };

  cache.digest = digest;
  saveCache(cache);
  return { digest, translatedCount, cached };
}
