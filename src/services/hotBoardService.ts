import { getDb, upsertContentWithMetrics } from '../db/database.js';
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

// 1. 拉取 B 站全站真实热门视频榜（免登录、字段完整）
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
          hotLabel: view != null ? `${(view / 10000).toFixed(1)}万播放${like != null ? ` · ${(like / 10000).toFixed(1)}万赞` : ''}` : '热门视频',
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

// 2. 拉取抖音实时热榜（免登录公开热词榜接口，严格使用真实接口数据）
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
          label?: number;
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

// 3. 汇总本工作台已采集的 YouTube / 行业网站高价值动态作为“垂直资讯热榜”
function collectLocalIndustryHot(): RawHotItem[] {
  const db = getDb();
  const rows = db
    .prepare(`
      SELECT c.id, c.platform, c.title, c.canonical_url, c.author, c.cover_url, c.summary, c.content_type,
             c.breakout_score, c.breakout_ratio,
             s.name AS source_name,
             (SELECT views FROM content_metrics m WHERE m.content_id = c.id ORDER BY captured_at DESC LIMIT 1) AS latest_views,
             (SELECT likes FROM content_metrics m WHERE m.content_id = c.id ORDER BY captured_at DESC LIMIT 1) AS latest_likes
      FROM contents c
      JOIN sources s ON s.id = c.source_id
      WHERE c.discovered_at >= datetime('now', '-7 days')
      ORDER BY COALESCE(c.breakout_score, 0) DESC, COALESCE(latest_likes, 0) DESC, c.discovered_at DESC
      LIMIT 25
    `)
    .all() as Array<Record<string, unknown>>;

  return rows.map((r, idx) => {
    const views = typeof r.latest_views === 'number' ? r.latest_views : null;
    const likes = typeof r.latest_likes === 'number' ? r.latest_likes : null;
    const ratio = typeof r.breakout_ratio === 'number' ? r.breakout_ratio : null;
    const labelParts: string[] = [];
    if (ratio !== null) labelParts.push(`异常 ${ratio}x`);
    if (views !== null) labelParts.push(`${views >= 10000 ? (views / 10000).toFixed(1) + '万' : views}播放`);
    if (likes !== null) labelParts.push(`${likes >= 10000 ? (likes / 10000).toFixed(1) + '万' : likes}赞`);
    return {
      platform: String(r.platform),
      boardName: '站内监控高热',
      rankNo: idx + 1,
      itemId: `local-${r.id}`,
      title: String(r.title || ''),
      url: String(r.canonical_url || ''),
      hotValue: typeof r.breakout_score === 'number' ? r.breakout_score : likes ?? views ?? null,
      hotLabel: labelParts.join(' · ') || '站内精选',
      author: String(r.author || r.source_name || ''),
      coverUrl: String(r.cover_url || ''),
      summary: String(r.summary || '').slice(0, 260),
      category: String(r.source_name || '行业动态'),
      contentType: String(r.content_type || 'article'),
    };
  });
}

export async function refreshHotBoards(platforms?: string[]): Promise<{
  ok: boolean;
  totalSaved: number;
  results: Array<{ board: string; count: number; error?: string }>;
}> {
  const targets = new Set(platforms && platforms.length > 0 ? platforms : ['bilibili', 'douyin', 'industry']);
  const results: Array<{ board: string; count: number; error?: string }> = [];
  const collected: RawHotItem[] = [];

  if (targets.has('bilibili')) {
    const b = await fetchBilibiliPopular();
    collected.push(...b.items);
    results.push({ board: 'B站全站热门', count: b.items.length, error: b.error });
  }
  if (targets.has('douyin')) {
    const d = await fetchDouyinHotBoard();
    collected.push(...d.items);
    results.push({ board: '抖音实时热榜', count: d.items.length, error: d.error });
  }
  if (targets.has('industry')) {
    const ind = collectLocalIndustryHot();
    collected.push(...ind);
    results.push({ board: '站内监控高热', count: ind.length });
  }

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

  log('INFO', 'hot-board', `Refreshed hot boards: total=${collected.length}`);
  return { ok: collected.length > 0, totalSaved: collected.length, results };
}

// 将某条热榜一键导入「内容情报库」（便于后续 AI 分析、听悟转写或抓评论）
export function importHotItemToIntel(hotItemId: number): { contentId: number; isNew: boolean } {
  const db = getDb();
  const row = db.prepare('SELECT * FROM hot_board_items WHERE id = ?').get(hotItemId) as HotBoardItemRow | undefined;
  if (!row) throw new Error('热榜条目不存在');

  if (row.content_id) {
    return { contentId: row.content_id, isNew: false };
  }

  // 确保存在对应的内置热榜虚拟来源
  const sourceName = `热榜导入 · ${row.board_name}`;
  let source = db.prepare('SELECT id FROM sources WHERE name = ? LIMIT 1').get(sourceName) as { id: number } | undefined;
  if (!source) {
    const now = new Date().toISOString();
    const res = db
      .prepare(`
        INSERT INTO sources (name, platform, url, source_type, priority, interval_minutes, status, capability_status, notes, created_at, updated_at)
        VALUES (?, ?, ?, 'hot_board', 2, 180, 'paused', '已接入并验证', '行业热榜一键导入来源', ?, ?)
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
