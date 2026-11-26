import crypto from 'node:crypto';
import { getDb, upsertContentWithMetrics } from '../db/database.js';
import { fetchText, parseFeedContent } from '../adapters/webUtils.js';
import { fetchGitHubTrendingItems } from './newsBriefService.js';
import { log } from '../utils/logger.js';

export interface HotBoardItemRow {
  id: number;
  platform: string;
  board_name: string;
  rank_no: number;
  item_id: string;
  title: string;
  url: string;
  hot_value: number | null;
  hot_label: string;
  author: string;
  cover_url: string;
  summary: string;
  category: string;
  content_type: string;
  account_relevance_score: number | null;
  account_relevance_reason: string;
  content_id: number | null;
  captured_at: string;
}

export interface BoardSourceConfig {
  id: string;
  name: string;
  platform: string;
  kind: 'bili_rank' | 'bili_popular' | 'douyin_hot' | 'github_trending' | 'rss';
  url?: string;
  rid?: number;
  category: string;
  isVertical: boolean; // 垂直高纯度榜（如科技/知识/开源/AI），默认开启
  enabled: boolean;
  builtin?: boolean;
}

export const DEFAULT_HOT_BOARDS: BoardSourceConfig[] = [
  {
    id: 'bili_tech',
    name: 'B站科技数码榜',
    platform: 'bilibili',
    kind: 'bili_rank',
    rid: 188,
    category: '科技数码',
    isVertical: true,
    enabled: true,
    builtin: true,
  },
  {
    id: 'bili_knowledge',
    name: 'B站知识区热榜',
    platform: 'bilibili',
    kind: 'bili_rank',
    rid: 36,
    category: '知识干货',
    isVertical: true,
    enabled: true,
    builtin: true,
  },
  {
    id: 'github_trending',
    name: 'GitHub 开源热榜',
    platform: 'github',
    kind: 'github_trending',
    url: 'https://github.com/trending?since=daily',
    category: '开源工具',
    isVertical: true,
    enabled: true,
    builtin: true,
  },
  {
    id: 'producthunt',
    name: 'Product Hunt 新工具',
    platform: 'producthunt',
    kind: 'rss',
    url: 'https://www.producthunt.com/feed',
    category: '新产品榜',
    isVertical: true,
    enabled: true,
    builtin: true,
  },
  {
    id: 'douyin',
    name: '抖音实时热榜',
    platform: 'douyin',
    kind: 'douyin_hot',
    category: '抖音热榜',
    isVertical: false,
    enabled: true,
    builtin: true,
  },
  {
    id: 'bilibili',
    name: 'B站全站热门',
    platform: 'bilibili',
    kind: 'bili_popular',
    category: '综合热门',
    isVertical: false,
    enabled: false,
    builtin: true,
  },
];

const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
};

interface RawHotItem {
  platform: string;
  boardName: string;
  rankNo: number;
  itemId: string;
  title: string;
  url: string;
  hotValue: number | null;
  hotLabel: string;
  author: string;
  coverUrl: string;
  summary: string;
  category: string;
  contentType: string;
}

export function getUserHotBoards(): BoardSourceConfig[] {
  const db = getDb();
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'user_hot_boards'").get() as { value: string } | undefined;
  if (!row?.value) return DEFAULT_HOT_BOARDS.map((b) => ({ ...b }));
  try {
    const parsed = JSON.parse(row.value) as BoardSourceConfig[];
    if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_HOT_BOARDS.map((b) => ({ ...b }));
    const byId = new Map(parsed.map((x) => [x.id, x]));
    for (const def of DEFAULT_HOT_BOARDS) {
      if (!byId.has(def.id)) parsed.push({ ...def });
    }
    return parsed;
  } catch {
    return DEFAULT_HOT_BOARDS.map((b) => ({ ...b }));
  }
}

function saveUserHotBoards(list: BoardSourceConfig[]): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES ('user_hot_boards', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(JSON.stringify(list), new Date().toISOString());
}

export function toggleUserHotBoard(id: string, enabled: boolean): BoardSourceConfig[] {
  const list = getUserHotBoards().map((b) => (b.id === id ? { ...b, enabled } : b));
  saveUserHotBoards(list);
  return list;
}

export function addCustomHotBoard(input: { name: string; url: string; category?: string }): {
  board: BoardSourceConfig;
  boards: BoardSourceConfig[];
} {
  const cleanUrl = input.url.trim();
  if (!/^https?:\/\//i.test(cleanUrl)) {
    throw new Error('请填写以 http:// 或 https:// 开头的有效榜单 / RSS 网址');
  }
  const cleanName = input.name.trim() || new URL(cleanUrl).hostname;
  const id = `board_${crypto.createHash('md5').update(cleanUrl).digest('hex').slice(0, 8)}`;
  const board: BoardSourceConfig = {
    id,
    name: cleanName,
    platform: 'custom',
    kind: 'rss',
    url: cleanUrl,
    category: (input.category || '自定义榜单').trim(),
    isVertical: true,
    enabled: true,
    builtin: false,
  };
  const list = getUserHotBoards();
  const idx = list.findIndex((b) => b.id === id);
  if (idx >= 0) list[idx] = board;
  else list.unshift(board);
  saveUserHotBoards(list);
  return { board, boards: list };
}

export function deleteCustomHotBoard(id: string): BoardSourceConfig[] {
  const list = getUserHotBoards();
  const target = list.find((b) => b.id === id);
  const next = list.filter((b) => b.id !== id || b.builtin);
  saveUserHotBoards(next);
  if (target && !target.builtin) {
    getDb().prepare('DELETE FROM hot_board_items WHERE board_name = ?').run(target.name);
  }
  return next;
}

// B 站精准分区排行榜（科技数码 rid=188 / 知识区 rid=36，免登录 100ms 直出高清封面与播放量）
async function fetchBilibiliRanking(rid: number, boardName: string): Promise<{ items: RawHotItem[]; error?: string }> {
  try {
    const res = await fetch(`https://api.bilibili.com/x/web-interface/ranking/v2?rid=${rid}&type=all`, {
      headers: { ...DEFAULT_HEADERS, Referer: 'https://www.bilibili.com/' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { items: [], error: `${boardName} HTTP ${res.status}` };
    const json = (await res.json()) as {
      code?: number;
      data?: {
        list?: Array<{
          bvid?: string;
          title?: string;
          desc?: string;
          pic?: string;
          tname?: string;
          owner?: { name?: string };
          stat?: { view?: number; like?: number; reply?: number };
        }>;
      };
    };
    const list = json.data?.list || [];
    const items: RawHotItem[] = list
      .filter((x) => x.bvid && x.title)
      .slice(0, 24)
      .map((x, idx) => {
        const view = typeof x.stat?.view === 'number' ? x.stat.view : null;
        const like = typeof x.stat?.like === 'number' ? x.stat.like : null;
        return {
          platform: 'bilibili',
          boardName,
          rankNo: idx + 1,
          itemId: x.bvid!,
          title: (x.title || '').trim(),
          url: `https://www.bilibili.com/video/${x.bvid}`,
          hotValue: view,
          hotLabel:
            view != null
              ? `${(view / 10000).toFixed(1)}万播放${like != null ? ` · ${(like / 10000).toFixed(1)}万赞` : ''}`
              : '分区热榜',
          author: x.owner?.name || '',
          coverUrl: x.pic ? (x.pic.startsWith('//') ? `https:${x.pic}` : x.pic) : '',
          summary: (x.desc || '').trim().slice(0, 320),
          category: x.tname || boardName,
          contentType: 'video',
        };
      });
    return { items };
  } catch (err) {
    return { items: [], error: `${boardName} 抓取失败: ${(err as Error).message}` };
  }
}

// B 站全站热门视频榜
async function fetchBilibiliPopular(): Promise<{ items: RawHotItem[]; error?: string }> {
  try {
    const res = await fetch('https://api.bilibili.com/x/web-interface/popular?ps=30&pn=1', {
      headers: { ...DEFAULT_HEADERS, Referer: 'https://www.bilibili.com/' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { items: [], error: `B站热门 HTTP ${res.status}` };
    const json = (await res.json()) as {
      code?: number;
      data?: {
        list?: Array<{
          bvid?: string;
          title?: string;
          desc?: string;
          pic?: string;
          tname?: string;
          owner?: { name?: string };
          stat?: { view?: number; like?: number; reply?: number };
          rcmd_reason?: { content?: string };
        }>;
      };
    };
    const list = json.data?.list || [];
    const items: RawHotItem[] = list
      .filter((x) => x.bvid && x.title)
      .map((x, idx) => {
        const view = typeof x.stat?.view === 'number' ? x.stat.view : null;
        const like = typeof x.stat?.like === 'number' ? x.stat.like : null;
        const reasonTag = x.rcmd_reason?.content ? `[${x.rcmd_reason.content}] ` : '';
        return {
          platform: 'bilibili',
          boardName: 'B站全站热门',
          rankNo: idx + 1,
          itemId: x.bvid!,
          title: (x.title || '').trim(),
          url: `https://www.bilibili.com/video/${x.bvid}`,
          hotValue: view,
          hotLabel:
            view != null
              ? `${(view / 10000).toFixed(1)}万播放${like != null ? ` · ${(like / 10000).toFixed(1)}万赞` : ''}`
              : '热门视频',
          author: x.owner?.name || '',
          coverUrl: x.pic ? (x.pic.startsWith('//') ? `https:${x.pic}` : x.pic) : '',
          summary: `${reasonTag}${(x.desc || '').trim()}`.slice(0, 320),
          category: x.tname || '综合',
          contentType: 'video',
        };
      });
    return { items };
  } catch (err) {
    return { items: [], error: `B站热门抓取失败: ${(err as Error).message}` };
  }
}

// 抖音实时热榜
async function fetchDouyinHotBoard(): Promise<{ items: RawHotItem[]; error?: string }> {
  const endpoints = [
    'https://www.iesdouyin.com/web/api/v2/hotsearch/billboard/word/',
    'https://aweme.snssdk.com/aweme/v1/hot/search/list/',
  ];
  let lastErr = '';
  for (const endpoint of endpoints) {
    try {
      const res = await fetch(endpoint, {
        headers: { ...DEFAULT_HEADERS, Referer: 'https://www.douyin.com/' },
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) {
        lastErr = `HTTP ${res.status}`;
        continue;
      }
      const json = (await res.json()) as {
        word_list?: Array<{
          word?: string;
          hot_value?: number;
          position?: number;
          sentence_id?: string;
          word_cover?: { url_list?: string[] };
        }>;
        data?: {
          word_list?: Array<{
            word?: string;
            hot_value?: number;
            position?: number;
            sentence_id?: string;
            word_cover?: { url_list?: string[] };
          }>;
        };
      };
      const list = json.word_list || json.data?.word_list || [];
      if (list.length === 0) {
        lastErr = '返回热榜列表为空';
        continue;
      }
      const items: RawHotItem[] = list
        .filter((x) => x.word)
        .slice(0, 35)
        .map((x, idx) => {
          const hv = typeof x.hot_value === 'number' ? x.hot_value : null;
          const word = String(x.word).trim();
          return {
            platform: 'douyin',
            boardName: '抖音实时热榜',
            rankNo: x.position || idx + 1,
            itemId: x.sentence_id || word,
            title: word,
            url: `https://www.douyin.com/search/${encodeURIComponent(word)}`,
            hotValue: hv,
            hotLabel: hv != null ? `${(hv / 10000).toFixed(1)}万热度` : '热榜',
            author: '抖音热点',
            coverUrl: x.word_cover?.url_list?.[0] || '',
            summary: `抖音实时热搜话题 #${x.position || idx + 1}：${word}`,
            category: '抖音热榜',
            contentType: 'hot_topic',
          };
        });
      return { items };
    } catch (err) {
      lastErr = (err as Error).message;
    }
  }
  return { items: [], error: `抖音热榜暂不可达 (${lastErr})` };
}

// 通用 RSS / 新产品榜 / 自定义榜单源抓取
async function fetchRssBoard(board: BoardSourceConfig): Promise<{ items: RawHotItem[]; error?: string }> {
  if (!board.url) return { items: [], error: '缺少榜单地址' };
  try {
    const res = await fetchText(board.url, 12000);
    if (!res.ok) return { items: [], error: res.error || '无法连接' };
    const parsed = parseFeedContent(res.text, res.finalUrl);
    const items: RawHotItem[] = parsed.items.slice(0, 20).map((it, idx) => ({
      platform: board.platform,
      boardName: board.name,
      rankNo: idx + 1,
      itemId: crypto.createHash('md5').update(it.url || it.title).digest('hex').slice(0, 12),
      title: (it.title || '').trim(),
      url: it.url,
      hotValue: 100 - idx,
      hotLabel: `#${idx + 1} · ${board.category}`,
      author: it.author || board.name,
      coverUrl: it.coverUrl || '',
      summary: (it.summary || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 260),
      category: board.category,
      contentType: 'article',
    }));
    return { items };
  } catch (err) {
    return { items: [], error: (err as Error).message };
  }
}

async function fetchBoardByConfig(board: BoardSourceConfig): Promise<{ items: RawHotItem[]; error?: string }> {
  if (board.kind === 'bili_rank' && board.rid) {
    return fetchBilibiliRanking(board.rid, board.name);
  }
  if (board.kind === 'bili_popular') {
    return fetchBilibiliPopular();
  }
  if (board.kind === 'douyin_hot') {
    return fetchDouyinHotBoard();
  }
  if (board.kind === 'github_trending') {
    try {
      const repos = await fetchGitHubTrendingItems(18);
      return {
        items: repos.map((r, idx) => ({
          platform: 'github',
          boardName: board.name,
          rankNo: idx + 1,
          itemId: r.title,
          title: r.title,
          url: r.url,
          hotValue: 100 - idx,
          hotLabel: r.heatLabel,
          author: r.language || 'GitHub',
          coverUrl: '',
          summary: r.summary,
          category: r.language || '开源工具',
          contentType: 'article',
        })),
      };
    } catch (err) {
      return { items: [], error: (err as Error).message };
    }
  }
  return fetchRssBoard(board);
}

export async function refreshHotBoards(boardIdsOrPlatforms?: string[]): Promise<{
  ok: boolean;
  totalSaved: number;
  results: Array<{ board: string; count: number; error?: string }>;
}> {
  const allBoards = getUserHotBoards();
  let targets: BoardSourceConfig[];
  if (boardIdsOrPlatforms && boardIdsOrPlatforms.length > 0) {
    const wanted = new Set(boardIdsOrPlatforms);
    targets = allBoards.filter((b) => wanted.has(b.id) || (b.enabled && wanted.has(b.platform)));
    if (targets.length === 0) targets = allBoards.filter((b) => b.enabled);
  } else {
    targets = allBoards.filter((b) => b.enabled);
  }

  const results: Array<{ board: string; count: number; error?: string }> = [];
  const collected: RawHotItem[] = [];

  const settled = await Promise.allSettled(targets.map((b) => fetchBoardByConfig(b)));
  settled.forEach((r, idx) => {
    const b = targets[idx];
    if (r.status === 'fulfilled') {
      collected.push(...r.value.items);
      results.push({ board: b.name, count: r.value.items.length, error: r.value.error });
    } else {
      results.push({ board: b.name, count: 0, error: String(r.reason) });
    }
  });

  const db = getDb();
  const now = new Date().toISOString();
  const upsert = db.prepare(`
    INSERT INTO hot_board_items (
      platform, board_name, rank_no, item_id, title, url, hot_value, hot_label,
      author, cover_url, summary, category, content_type, captured_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(platform, board_name, item_id) DO UPDATE SET
      rank_no = excluded.rank_no,
      title = excluded.title,
      url = excluded.url,
      hot_value = excluded.hot_value,
      hot_label = excluded.hot_label,
      author = excluded.author,
      cover_url = excluded.cover_url,
      summary = excluded.summary,
      category = excluded.category,
      content_type = excluded.content_type,
      captured_at = excluded.captured_at
  `);

  for (const item of collected) {
    upsert.run(
      item.platform,
      item.boardName,
      item.rankNo,
      item.itemId,
      item.title,
      item.url,
      item.hotValue,
      item.hotLabel,
      item.author,
      item.coverUrl,
      item.summary,
      item.category,
      item.contentType,
      now
    );
  }

  // 按本次成功拉取的榜单清理旧快照中落榜条目，彻底避免重复排名
  const refreshedBoards = new Set(collected.map((it) => `${it.platform}:::${it.boardName}`));
  for (const key of refreshedBoards) {
    const [plat, board] = key.split(':::');
    db.prepare('DELETE FROM hot_board_items WHERE platform = ? AND board_name = ? AND captured_at < ?').run(plat, board, now);
  }

  log('INFO', 'hot-board', `Refreshed ${targets.length} hot boards: total=${collected.length}`);
  return { ok: collected.length > 0, totalSaved: collected.length, results };
}

// 将某条热榜一键导入内容库（便于后续 AI 拆解、显卡转写或抓评论）
export function importHotItemToIntel(hotItemId: number): { contentId: number; isNew: boolean } {
  const db = getDb();
  const row = db.prepare('SELECT * FROM hot_board_items WHERE id = ?').get(hotItemId) as HotBoardItemRow | undefined;
  if (!row) throw new Error('热榜条目不存在');

  if (row.content_id) {
    return { contentId: row.content_id, isNew: false };
  }

  const sourceName = `热榜导入 · ${row.board_name}`;
  let source = db.prepare('SELECT id FROM sources WHERE name = ? LIMIT 1').get(sourceName) as { id: number } | undefined;
  if (!source) {
    const now = new Date().toISOString();
    const res = db
      .prepare(`
        INSERT INTO sources (name, platform, url, source_type, priority, interval_minutes, status, capability_status, notes, created_at, updated_at)
        VALUES (?, ?, ?, 'hot_board', 2, 180, 'paused', '已接入并验证', '专属热榜一键导入来源', ?, ?)
      `)
      .run(sourceName, row.platform, row.url, now, now);
    source = { id: Number(res.lastInsertRowid) };
  }

  const saved = upsertContentWithMetrics({
    sourceId: source.id,
    platform: row.platform,
    platformItemId: row.item_id,
    url: row.url,
    title: row.title,
    author: row.author,
    summary: row.summary || row.title,
    body: row.summary || row.title,
    coverUrl: row.cover_url,
    tags: [row.board_name, row.category].filter(Boolean),
    publishedAt: row.captured_at,
    contentType: (row.content_type as 'video' | 'article' | 'short_post' | 'hot_topic') || 'hot_topic',
    metrics:
      row.platform === 'bilibili' && row.hot_value != null
        ? { views: Math.round(row.hot_value) }
        : undefined,
  });

  db.prepare('UPDATE hot_board_items SET content_id = ? WHERE id = ?').run(saved.contentId, hotItemId);
  return { contentId: saved.contentId, isNew: saved.isNew };
}
