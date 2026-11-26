import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/database.js';
import { recomputeAllBreakouts, recomputeSourceBreakout } from '../services/breakoutService.js';
import { importHotItemToIntel, refreshHotBoards } from '../services/hotBoardService.js';
import { fetchCommentsWithMediaCrawler, getMediaCrawlerStatus } from '../services/mediaCrawlerBridge.js';
import {
  getTingwuStatus,
  launchTingwuLogin,
  startTingwuTranscription,
  syncCompletedTingwuJobs,
} from '../services/tingwuBridge.js';
import {
  analyzeContentDeep,
  clusterRecentContents,
  generateRecommendationForContent,
  getActiveAccount,
  getAiHealthSummary,
  getAiRuntimeConfig,
  recalculateAccountScores,
  runBatchRecommendations,
  scoreHotBoardForAccount,
} from '../services/aiRadarService.js';
import { getTopicTrendSeries, scanTrackedTopic } from '../services/topicRadarService.js';
import { findDuplicateTopics, TOPIC_BOARD_STATUSES } from '../services/topicBoardService.js';

function safeParseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function registerRadarRoutes(app: FastifyInstance): void {
  // ===== 1. 选题驾驶舱总览 =====
  app.get<{ Querystring: { accountId?: string } }>('/api/radar/cockpit', async (req) => {
    const db = getDb();
    const accountId = req.query.accountId ? Number(req.query.accountId) : undefined;
    const activeAccount = getActiveAccount(accountId);
    const accounts = db.prepare('SELECT * FROM creator_accounts ORDER BY is_active DESC, id ASC').all();

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayIso = todayStart.toISOString();

    const totalSources = (
      db.prepare("SELECT COUNT(*) AS c FROM sources WHERE source_type != 'hot_board'").get() as { c: number }
    ).c;
    const totalContents = (db.prepare('SELECT COUNT(*) AS c FROM contents').get() as { c: number }).c;
    const todayNew = (db.prepare('SELECT COUNT(*) AS c FROM contents WHERE discovered_at >= ?').get(todayIso) as { c: number }).c;
    const breakoutCount = (
      db
        .prepare(`
          SELECT COUNT(*) AS c FROM contents c
          JOIN sources s ON s.id = c.source_id
          WHERE s.source_type != 'hot_board' AND (c.breakout_ratio >= 1.6 OR c.breakout_score >= 68)
        `)
        .get() as { c: number }
    ).c;
    const boardActiveCount = (
      db
        .prepare("SELECT COUNT(*) AS c FROM topic_board WHERE status IN ('to_research', 'to_create', 'creating', 'to_publish')")
        .get() as { c: number }
    ).c;
    const savedCount = (db.prepare('SELECT COUNT(*) AS c FROM topic_board').get() as { c: number }).c;
    const hotBoardCount = (
      db
        .prepare(`
          SELECT COUNT(*) AS c
          FROM hot_board_items h
          WHERE h.board_name != '站内监控高热'
            AND h.captured_at = (
              SELECT MAX(h2.captured_at) FROM hot_board_items h2
              WHERE h2.platform = h.platform AND h2.board_name = h.board_name
            )
        `)
        .get() as { c: number }
    ).c;

    // 14 日采集量与潜力爆款趋势数据（同时截取最近 7 天兼容旧字段）
    const trendRaw = db
      .prepare(`
        SELECT substr(discovered_at, 1, 10) AS day,
               COUNT(*) AS total,
               SUM(CASE WHEN breakout_ratio >= 1.6 OR breakout_score >= 68 THEN 1 ELSE 0 END) AS breakouts
        FROM contents
        WHERE discovered_at >= datetime('now', '-14 days')
        GROUP BY day
        ORDER BY day ASC
      `)
      .all() as Array<{ day: string; total: number; breakouts: number }>;
    const trendMap = new Map(trendRaw.map((r) => [r.day, r]));
    const trend14d: Array<{ day: string; total: number; breakouts: number }> = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const key = d.toISOString().slice(0, 10);
      const hit = trendMap.get(key);
      trend14d.push({
        day: key.slice(5),
        total: hit ? Number(hit.total) : 0,
        breakouts: hit ? Number(hit.breakouts) : 0,
      });
    }
    const trend7d = trend14d.slice(-7);

    // 当前账号 TOP 推荐选题（排除不感兴趣与已讲过）
    const recommendations = db
      .prepare(`
        SELECT r.*, c.platform, c.canonical_url, c.title AS origin_title, c.author, c.published_at,
               c.discovered_at, c.breakout_ratio, c.breakout_score, c.transcript_status,
               s.name AS source_name,
               (SELECT views FROM content_metrics m WHERE m.content_id = c.id ORDER BY captured_at DESC LIMIT 1) AS latest_views,
               (SELECT likes FROM content_metrics m WHERE m.content_id = c.id ORDER BY captured_at DESC LIMIT 1) AS latest_likes,
               (SELECT comments FROM content_metrics m WHERE m.content_id = c.id ORDER BY captured_at DESC LIMIT 1) AS latest_comments,
               (SELECT COUNT(*) FROM topic_board tb WHERE tb.source_content_id = c.id) AS in_board_count
        FROM topic_recommendations r
        JOIN contents c ON c.id = r.content_id
        JOIN sources s ON s.id = c.source_id
        WHERE r.account_id = ? AND r.feedback_status NOT IN ('not_interested', 'covered')
        ORDER BY r.score_total DESC, r.updated_at DESC
        LIMIT 8
      `)
      .all(activeAccount.id);

    // 对标博主真爆款 TOP 8（严格筛选 >= 1.6x 或高爆款分，附带封面图与收藏状态）
    const breakouts = db
      .prepare(`
        SELECT c.id, c.title, c.platform, c.author, c.canonical_url, c.cover_url, c.published_at, c.discovered_at,
               c.breakout_score, c.breakout_ratio, c.growth_rate_per_hour, c.breakout_reason,
               c.transcript_status,
               s.name AS source_name, s.follower_count,
               COALESCE(a.summary_zh, '') AS brief,
               (SELECT views FROM content_metrics m WHERE m.content_id = c.id ORDER BY captured_at DESC LIMIT 1) AS latest_views,
               (SELECT likes FROM content_metrics m WHERE m.content_id = c.id ORDER BY captured_at DESC LIMIT 1) AS latest_likes,
               (SELECT comments FROM content_metrics m WHERE m.content_id = c.id ORDER BY captured_at DESC LIMIT 1) AS latest_comments,
               (SELECT COUNT(*) FROM content_comments cm WHERE cm.content_id = c.id) AS comment_rows,
               (SELECT id FROM topic_board tb WHERE tb.source_content_id = c.id LIMIT 1) AS saved_board_id
        FROM contents c
        JOIN sources s ON s.id = c.source_id
        LEFT JOIN content_analyses a ON a.content_id = c.id
        WHERE s.source_type != 'hot_board'
          AND (c.breakout_ratio >= 1.6 OR c.breakout_score >= 68)
        ORDER BY COALESCE(c.breakout_ratio, 0) DESC, COALESCE(c.breakout_score, 0) DESC, c.discovered_at DESC
        LIMIT 8
      `)
      .all();

    // 今日平台热榜速递（严格只取各榜单最新一期，彻底杜绝重复 #1）
    const latestHotSql = `
      SELECT h.*,
             (SELECT a.summary_zh FROM content_analyses a WHERE a.content_id = h.content_id LIMIT 1) AS ai_summary,
             (SELECT tb.id FROM topic_board tb
              WHERE (h.content_id IS NOT NULL AND tb.source_content_id = h.content_id)
                 OR (h.url != '' AND tb.source_url = h.url)
              LIMIT 1) AS saved_board_id
      FROM hot_board_items h
      WHERE h.board_name != '站内监控高热'
        AND h.captured_at = (
          SELECT MAX(h2.captured_at) FROM hot_board_items h2
          WHERE h2.platform = h.platform AND h2.board_name = h.board_name
        )
    `;
    const douyinHot = db.prepare(`${latestHotSql} AND h.platform = 'douyin' ORDER BY h.rank_no ASC LIMIT 12`).all();
    const bilibiliHot = db.prepare(`${latestHotSql} AND h.platform = 'bilibili' ORDER BY h.rank_no ASC LIMIT 12`).all();
    const hotTop = [...douyinHot, ...bilibiliHot];

    // 最新一期热榜分类分布（用于今日速览底部分区环图）
    const hotCategoryDistribution = db
      .prepare(`
        SELECT COALESCE(NULLIF(TRIM(h.category), ''), '综合') AS name, COUNT(*) AS count
        FROM hot_board_items h
        WHERE h.board_name = 'B站全站热门'
          AND h.captured_at = (
            SELECT MAX(h2.captured_at) FROM hot_board_items h2
            WHERE h2.platform = h.platform AND h2.board_name = h.board_name
          )
        GROUP BY name
        ORDER BY count DESC
        LIMIT 8
      `)
      .all() as Array<{ name: string; count: number }>;

    // 平台真实监控内容分布（仅统计最新热榜+博主内容）
    const platformDistribution = db
      .prepare(`
        SELECT platform, COUNT(*) AS count
        FROM (
          SELECT c.platform AS platform FROM contents c JOIN sources s ON s.id = c.source_id WHERE s.source_type != 'hot_board'
          UNION ALL
          SELECT h.platform AS platform FROM hot_board_items h
          WHERE h.board_name != '站内监控高热'
            AND h.captured_at = (
              SELECT MAX(h2.captured_at) FROM hot_board_items h2
              WHERE h2.platform = h.platform AND h2.board_name = h.board_name
            )
        )
        GROUP BY platform
        ORDER BY count DESC
      `)
      .all() as Array<{ platform: string; count: number }>;

    // 热点事件聚簇 TOP 6
    const clusters = db
      .prepare('SELECT * FROM topic_clusters ORDER BY heat_score DESC, latest_at DESC LIMIT 6')
      .all();

    // 话题雷达预警（近 7 天命中数 >= 阈值）
    const topicAlerts = db
      .prepare(`
        SELECT t.id, t.name, t.domain, t.alert_threshold,
               COUNT(m.id) AS recent_hits
        FROM tracked_topics t
        LEFT JOIN topic_matches m ON m.topic_id = t.id AND m.matched_at >= datetime('now', '-7 days')
        WHERE t.status = 'active'
        GROUP BY t.id
        ORDER BY recent_hits DESC
        LIMIT 6
      `)
      .all();

    // 最新动态 8 条
    const recentItems = db
      .prepare(`
        SELECT c.id, c.title, c.platform, c.author, c.canonical_url, c.published_at, c.discovered_at,
               c.content_type, c.breakout_ratio, s.name AS source_name,
               COALESCE(a.category, '') AS ai_category,
               COALESCE(a.summary_zh, c.summary, '') AS brief
        FROM contents c
        JOIN sources s ON s.id = c.source_id
        LEFT JOIN content_analyses a ON a.content_id = c.id
        ORDER BY c.discovered_at DESC
        LIMIT 8
      `)
      .all();

    return {
      activeAccount,
      accounts,
      stats: {
        totalSources,
        totalContents,
        todayNew,
        breakoutCount,
        boardActiveCount,
        savedCount,
        hotBoardCount,
      },
      trend7d,
      trend14d,
      platformDistribution,
      hotCategoryDistribution,
      hotTop,
      douyinHot,
      bilibiliHot,
      recommendations,
      breakouts,
      clusters,
      topicAlerts,
      recentItems,
      aiHealth: getAiHealthSummary(),
    };
  });

  // ===== 2. 多账号定位与 6 维自定义权重 =====
  app.get('/api/radar/accounts', async () => {
    const db = getDb();
    return db.prepare('SELECT * FROM creator_accounts ORDER BY is_active DESC, id ASC').all();
  });

  app.post<{
    Body: {
      name: string;
      platform_focus?: string;
      niche?: string;
      target_audience?: string;
      content_direction?: string;
      personal_expertise?: string;
      style_preferences?: string;
      weight_match?: number;
      weight_heat?: number;
      weight_diff?: number;
      weight_experience?: number;
      weight_timeliness?: number;
      weight_feasibility?: number;
      is_active?: boolean;
    };
  }>('/api/radar/accounts', async (req, reply) => {
    const b = req.body || {};
    const name = (b.name || '').trim();
    if (!name) return reply.code(400).send({ error: '账号名称不能为空' });
    const db = getDb();
    const now = new Date().toISOString();
    if (b.is_active) {
      db.exec('UPDATE creator_accounts SET is_active = 0');
    }
    const res = db
      .prepare(`
        INSERT INTO creator_accounts (
          name, platform_focus, niche, target_audience, content_direction, personal_expertise, style_preferences,
          is_active, weight_match, weight_heat, weight_diff, weight_experience, weight_timeliness, weight_feasibility,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        name,
        (b.platform_focus || '抖音 / B站 / YouTube').trim(),
        (b.niche || '').trim(),
        (b.target_audience || '').trim(),
        (b.content_direction || '').trim(),
        (b.personal_expertise || '').trim(),
        (b.style_preferences || '').trim(),
        b.is_active ? 1 : 0,
        Number(b.weight_match ?? 25),
        Number(b.weight_heat ?? 25),
        Number(b.weight_diff ?? 20),
        Number(b.weight_experience ?? 15),
        Number(b.weight_timeliness ?? 10),
        Number(b.weight_feasibility ?? 5),
        now,
        now
      );
    const created = db.prepare('SELECT * FROM creator_accounts WHERE id = ?').get(Number(res.lastInsertRowid));
    return { ok: true, account: created };
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/radar/accounts/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const db = getDb();
    const existing = db.prepare('SELECT * FROM creator_accounts WHERE id = ?').get(id);
    if (!existing) return reply.code(404).send({ error: '账号不存在' });

    const b = req.body || {};
    const fields = [
      'name',
      'platform_focus',
      'niche',
      'target_audience',
      'content_direction',
      'personal_expertise',
      'style_preferences',
      'weight_match',
      'weight_heat',
      'weight_diff',
      'weight_experience',
      'weight_timeliness',
      'weight_feasibility',
    ];
    const sets: string[] = [];
    const params: unknown[] = [];
    let weightChanged = false;
    for (const f of fields) {
      if (b[f] !== undefined) {
        sets.push(`${f} = ?`);
        params.push(f.startsWith('weight_') ? Number(b[f]) : String(b[f]).trim());
        if (f.startsWith('weight_')) weightChanged = true;
      }
    }
    if (sets.length > 0) {
      sets.push('updated_at = ?');
      params.push(new Date().toISOString(), id);
      db.prepare(`UPDATE creator_accounts SET ${sets.join(', ')} WHERE id = ?`).run(...(params as string[]));
    }
    const recalculated = weightChanged ? recalculateAccountScores(id) : 0;
    const updated = db.prepare('SELECT * FROM creator_accounts WHERE id = ?').get(id);
    return { ok: true, account: updated, recalculated };
  });

  app.post<{ Params: { id: string } }>('/api/radar/accounts/:id/activate', async (req, reply) => {
    const id = Number(req.params.id);
    const db = getDb();
    const existing = db.prepare('SELECT id FROM creator_accounts WHERE id = ?').get(id);
    if (!existing) return reply.code(404).send({ error: '账号不存在' });
    db.exec('UPDATE creator_accounts SET is_active = 0');
    db.prepare('UPDATE creator_accounts SET is_active = 1, updated_at = ? WHERE id = ?').run(new Date().toISOString(), id);
    return { ok: true, activeId: id };
  });

  app.delete<{ Params: { id: string } }>('/api/radar/accounts/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const db = getDb();
    const count = (db.prepare('SELECT COUNT(*) AS c FROM creator_accounts').get() as { c: number }).c;
    if (count <= 1) return reply.code(400).send({ error: '至少需要保留一个自媒体账号定位配置' });
    db.prepare('DELETE FROM creator_accounts WHERE id = ?').run(id);
    const active = db.prepare('SELECT id FROM creator_accounts WHERE is_active = 1 LIMIT 1').get();
    if (!active) {
      db.exec('UPDATE creator_accounts SET is_active = 1 WHERE id = (SELECT id FROM creator_accounts ORDER BY id ASC LIMIT 1)');
    }
    return { ok: true };
  });

  // ===== 3. 博主监控与表现分析 =====
  app.get<{ Querystring: { platform?: string; categoryId?: string; q?: string } }>('/api/radar/creators', async (req) => {
    const db = getDb();
    const where: string[] = ["s.source_type != 'hot_board'"];
    const params: (string | number)[] = [];
    if (req.query.platform) {
      where.push('s.platform = ?');
      params.push(req.query.platform);
    }
    if (req.query.categoryId) {
      where.push('s.category_id = ?');
      params.push(Number(req.query.categoryId));
    }
    if (req.query.q) {
      where.push('(s.name LIKE ? OR s.url LIKE ? OR s.notes LIKE ?)');
      const like = `%${req.query.q.trim()}%`;
      params.push(like, like, like);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = db
      .prepare(`
        SELECT s.*, cat.name AS category_name,
               (SELECT COUNT(*) FROM contents c WHERE c.source_id = s.id) AS content_count,
               (SELECT COUNT(*) FROM contents c WHERE c.source_id = s.id AND (c.breakout_ratio >= 1.6 OR c.breakout_score >= 68)) AS breakout_count,
               (SELECT MAX(c.breakout_ratio) FROM contents c WHERE c.source_id = s.id) AS max_breakout_ratio
        FROM sources s
        LEFT JOIN categories cat ON cat.id = s.category_id
        ${whereSql}
        ORDER BY s.priority ASC, s.id DESC
      `)
      .all(...params);
    return rows;
  });

  app.get<{ Params: { id: string } }>('/api/radar/creators/:id/analytics', async (req, reply) => {
    const id = Number(req.params.id);
    const db = getDb();
    const creator = db
      .prepare(`
        SELECT s.*, cat.name AS category_name
        FROM sources s LEFT JOIN categories cat ON cat.id = s.category_id
        WHERE s.id = ?
      `)
      .get(id);
    if (!creator) return reply.code(404).send({ error: '博主/监控对象不存在' });

    recomputeSourceBreakout(id);

    const updatedCreator = db
      .prepare(`
        SELECT s.*, cat.name AS category_name
        FROM sources s LEFT JOIN categories cat ON cat.id = s.category_id
        WHERE s.id = ?
      `)
      .get(id);

    const works = db
      .prepare(`
        SELECT c.id, c.title, c.canonical_url, c.cover_url, c.platform, c.content_type, c.published_at, c.discovered_at,
               c.tags_json, c.transcript_status, c.breakout_score, c.breakout_ratio, c.growth_rate_per_hour, c.breakout_reason,
               COALESCE(a.category, '') AS ai_category,
               COALESCE(a.summary_zh, '') AS brief,
               (SELECT views FROM content_metrics m WHERE m.content_id = c.id ORDER BY captured_at DESC LIMIT 1) AS latest_views,
               (SELECT likes FROM content_metrics m WHERE m.content_id = c.id ORDER BY captured_at DESC LIMIT 1) AS latest_likes,
               (SELECT comments FROM content_metrics m WHERE m.content_id = c.id ORDER BY captured_at DESC LIMIT 1) AS latest_comments,
               (SELECT favorites FROM content_metrics m WHERE m.content_id = c.id ORDER BY captured_at DESC LIMIT 1) AS latest_favorites,
               (SELECT shares FROM content_metrics m WHERE m.content_id = c.id ORDER BY captured_at DESC LIMIT 1) AS latest_shares,
               (SELECT COUNT(*) FROM content_comments cm WHERE cm.content_id = c.id) AS comment_rows,
               (SELECT id FROM topic_board tb WHERE tb.source_content_id = c.id LIMIT 1) AS saved_board_id
        FROM contents c
        LEFT JOIN content_analyses a ON a.content_id = c.id
        WHERE c.source_id = ?
        ORDER BY COALESCE(c.published_at, c.discovered_at) DESC
        LIMIT 30
      `)
      .all(id) as Array<Record<string, unknown>>;

    // 统计常见选题方向/标签分布
    const tagCounts = new Map<string, number>();
    for (const w of works) {
      const cat = String(w.ai_category || '').trim();
      if (cat) tagCounts.set(cat, (tagCounts.get(cat) || 0) + 1);
      for (const t of safeParseJson<string[]>(w.tags_json, [])) {
        tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
      }
    }
    const topDirections = Array.from(tagCounts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // 作品表现柱图（按时间正序最多 16 条）
    const chartData = [...works]
      .slice(0, 16)
      .reverse()
      .map((w) => ({
        id: w.id,
        title: String(w.title || ''),
        label: String(w.title || '').slice(0, 12),
        date: String(w.published_at || w.discovered_at || '').slice(5, 10),
        views: typeof w.latest_views === 'number' ? w.latest_views : 0,
        likes: typeof w.latest_likes === 'number' ? w.latest_likes : 0,
        ratio: typeof w.breakout_ratio === 'number' ? w.breakout_ratio : 0,
        isBreakout: (typeof w.breakout_ratio === 'number' && w.breakout_ratio >= 1.6) || (typeof w.breakout_score === 'number' && w.breakout_score >= 68),
      }));

    return { creator: updatedCreator, works, topDirections, chartData };
  });

  app.post('/api/radar/creators/recompute-breakout', async () => {
    return { ok: true, ...recomputeAllBreakouts() };
  });

  // ===== 4. 平台热榜（默认仅返回各榜单最新一期快照，绝不出现重复 #1） =====
  app.get<{ Querystring: { platform?: string; category?: string; contentType?: string; minRelevance?: string; q?: string; includeLocal?: string } }>(
    '/api/radar/hot-board',
    async (req) => {
      const db = getDb();
      const baseWhere: string[] = [
        `h.captured_at = (
          SELECT MAX(h2.captured_at) FROM hot_board_items h2
          WHERE h2.platform = h.platform AND h2.board_name = h.board_name
        )`,
      ];
      const baseParams: (string | number)[] = [];
      if (req.query.includeLocal !== 'true') {
        baseWhere.push("h.board_name != '站内监控高热'");
      }
      if (req.query.platform) {
        baseWhere.push('h.platform = ?');
        baseParams.push(req.query.platform);
      }
      if (req.query.contentType) {
        baseWhere.push('h.content_type = ?');
        baseParams.push(req.query.contentType);
      }
      if (req.query.minRelevance) {
        baseWhere.push('COALESCE(h.account_relevance_score, 0) >= ?');
        baseParams.push(Number(req.query.minRelevance));
      }
      if (req.query.q) {
        baseWhere.push('(h.title LIKE ? OR h.summary LIKE ? OR h.category LIKE ? OR h.author LIKE ?)');
        const like = `%${req.query.q.trim()}%`;
        baseParams.push(like, like, like, like);
      }

      // 先基于平台条件统计真实分类标签列表
      const catWhereSql = baseWhere.length ? `WHERE ${baseWhere.join(' AND ')}` : '';
      const categories = db
        .prepare(`
          SELECT COALESCE(NULLIF(TRIM(h.category), ''), '综合') AS name, COUNT(*) AS count
          FROM hot_board_items h
          ${catWhereSql}
          GROUP BY name
          ORDER BY count DESC
          LIMIT 20
        `)
        .all(...baseParams) as Array<{ name: string; count: number }>;

      const where = [...baseWhere];
      const params = [...baseParams];
      if (req.query.category) {
        where.push("COALESCE(NULLIF(TRIM(h.category), ''), '综合') = ?");
        params.push(req.query.category);
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const items = db
        .prepare(`
          SELECT h.*,
                 (SELECT a.summary_zh FROM content_analyses a WHERE a.content_id = h.content_id LIMIT 1) AS ai_summary,
                 (SELECT tb.id FROM topic_board tb
                  WHERE (h.content_id IS NOT NULL AND tb.source_content_id = h.content_id)
                     OR (h.url != '' AND tb.source_url = h.url)
                  LIMIT 1) AS saved_board_id
          FROM hot_board_items h
          ${whereSql}
          ORDER BY h.rank_no ASC, COALESCE(h.hot_value, 0) DESC, h.captured_at DESC
          LIMIT 120
        `)
        .all(...params);
      return { items, categories };
    }
  );

  app.post<{ Body: { platforms?: string[]; scoreWithAi?: boolean; accountId?: number } }>(
    '/api/radar/hot-board/refresh',
    async (req) => {
      const res = await refreshHotBoards(req.body?.platforms);
      let aiScored = 0;
      if (req.body?.scoreWithAi && res.totalSaved > 0) {
        try {
          const sr = await scoreHotBoardForAccount(req.body.accountId);
          aiScored = sr.scored;
        } catch {
          // 忽略 AI 异常，确保热榜抓取结果照常返回
        }
      }
      return { ...res, aiScored };
    }
  );

  app.post<{ Body: { accountId?: number } }>('/api/radar/hot-board/score', async (req, reply) => {
    try {
      const res = await scoreHotBoardForAccount(req.body?.accountId);
      return { ok: true, ...res };
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  app.post<{ Params: { id: string } }>('/api/radar/hot-board/:id/import', async (req, reply) => {
    try {
      const res = importHotItemToIntel(Number(req.params.id));
      return { ok: true, ...res };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // ===== 5. 自定义话题雷达 =====
  app.get('/api/radar/topics', async () => {
    const db = getDb();
    const rows = db
      .prepare(`
        SELECT t.*,
               (SELECT COUNT(*) FROM topic_matches m WHERE m.topic_id = t.id) AS total_matches,
               (SELECT COUNT(*) FROM topic_matches m WHERE m.topic_id = t.id AND m.matched_at >= datetime('now', '-7 days')) AS recent_7d_matches,
               (SELECT ROUND(AVG(m.relevance_score), 1) FROM topic_matches m WHERE m.topic_id = t.id) AS avg_relevance
        FROM tracked_topics t
        ORDER BY t.status ASC, recent_7d_matches DESC, t.id DESC
      `)
      .all();
    return rows;
  });

  app.post<{
    Body: {
      name: string;
      domain?: string;
      keywords?: string[];
      related_terms?: string[];
      exclude_terms?: string[];
      description?: string;
      interval_minutes?: number;
      alert_threshold?: number;
    };
  }>('/api/radar/topics', async (req, reply) => {
    const b = req.body || {};
    const name = (b.name || '').trim();
    if (!name) return reply.code(400).send({ error: '话题名称不能为空' });
    const db = getDb();
    const now = new Date().toISOString();
    const res = db
      .prepare(`
        INSERT INTO tracked_topics (name, domain, keywords_json, related_terms_json, exclude_terms_json, description, interval_minutes, alert_threshold, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
      `)
      .run(
        name,
        (b.domain || '').trim(),
        JSON.stringify(Array.isArray(b.keywords) ? b.keywords.filter(Boolean) : [name]),
        JSON.stringify(Array.isArray(b.related_terms) ? b.related_terms.filter(Boolean) : []),
        JSON.stringify(Array.isArray(b.exclude_terms) ? b.exclude_terms.filter(Boolean) : []),
        (b.description || '').trim(),
        Number(b.interval_minutes || 120),
        Number(b.alert_threshold || 3),
        now,
        now
      );
    const topicId = Number(res.lastInsertRowid);
    // 创建后先做一次快速规则扫描，立即出首屏关联内容
    await scanTrackedTopic(topicId, false).catch(() => {});
    const topic = db.prepare('SELECT * FROM tracked_topics WHERE id = ?').get(topicId);
    return { ok: true, topic };
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/radar/topics/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const db = getDb();
    if (!db.prepare('SELECT id FROM tracked_topics WHERE id = ?').get(id)) {
      return reply.code(404).send({ error: '话题不存在' });
    }
    const b = req.body || {};
    const sets: string[] = [];
    const params: unknown[] = [];
    if (b.name !== undefined) { sets.push('name = ?'); params.push(String(b.name).trim()); }
    if (b.domain !== undefined) { sets.push('domain = ?'); params.push(String(b.domain).trim()); }
    if (b.keywords !== undefined) { sets.push('keywords_json = ?'); params.push(JSON.stringify(b.keywords)); }
    if (b.related_terms !== undefined) { sets.push('related_terms_json = ?'); params.push(JSON.stringify(b.related_terms)); }
    if (b.exclude_terms !== undefined) { sets.push('exclude_terms_json = ?'); params.push(JSON.stringify(b.exclude_terms)); }
    if (b.description !== undefined) { sets.push('description = ?'); params.push(String(b.description).trim()); }
    if (b.interval_minutes !== undefined) { sets.push('interval_minutes = ?'); params.push(Number(b.interval_minutes)); }
    if (b.alert_threshold !== undefined) { sets.push('alert_threshold = ?'); params.push(Number(b.alert_threshold)); }
    if (b.status !== undefined) { sets.push('status = ?'); params.push(String(b.status)); }
    if (sets.length > 0) {
      sets.push('updated_at = ?');
      params.push(new Date().toISOString(), id);
      db.prepare(`UPDATE tracked_topics SET ${sets.join(', ')} WHERE id = ?`).run(...(params as string[]));
    }
    return { ok: true, topic: db.prepare('SELECT * FROM tracked_topics WHERE id = ?').get(id) };
  });

  app.delete<{ Params: { id: string } }>('/api/radar/topics/:id', async (req) => {
    const db = getDb();
    db.prepare('DELETE FROM tracked_topics WHERE id = ?').run(Number(req.params.id));
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/api/radar/topics/:id/detail', async (req, reply) => {
    const id = Number(req.params.id);
    const db = getDb();
    const topic = db.prepare('SELECT * FROM tracked_topics WHERE id = ?').get(id);
    if (!topic) return reply.code(404).send({ error: '话题不存在' });
    const trend = getTopicTrendSeries(id, 14);
    const matches = db
      .prepare(`
        SELECT m.*, c.title, c.platform, c.canonical_url, c.author, c.published_at, c.discovered_at,
               c.breakout_ratio, c.breakout_score, s.name AS source_name,
               COALESCE(a.summary_zh, c.summary, '') AS brief,
               (SELECT views FROM content_metrics cm WHERE cm.content_id = c.id ORDER BY captured_at DESC LIMIT 1) AS latest_views,
               (SELECT likes FROM content_metrics cm WHERE cm.content_id = c.id ORDER BY captured_at DESC LIMIT 1) AS latest_likes
        FROM topic_matches m
        JOIN contents c ON c.id = m.content_id
        JOIN sources s ON s.id = c.source_id
        LEFT JOIN content_analyses a ON a.content_id = c.id
        WHERE m.topic_id = ?
        ORDER BY m.relevance_score DESC, c.discovered_at DESC
        LIMIT 60
      `)
      .all(id);
    return { topic, trend, matches };
  });

  app.post<{ Params: { id: string }; Body: { useSemanticAi?: boolean } }>('/api/radar/topics/:id/scan', async (req, reply) => {
    try {
      const res = await scanTrackedTopic(Number(req.params.id), req.body?.useSemanticAi !== false);
      return { ok: true, ...res };
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  // ===== 6. 内容情报库、聚簇、AI分析、评论深采与通义听悟转写 =====
  app.get<{
    Querystring: {
      platform?: string;
      sourceId?: string;
      contentType?: string;
      onlyBreakout?: string;
      hasTranscript?: string;
      accountId?: string;
      q?: string;
      limit?: string;
    };
  }>('/api/radar/intel', async (req) => {
    const db = getDb();
    const account = getActiveAccount(req.query.accountId ? Number(req.query.accountId) : undefined);
    const where: string[] = [];
    const params: (string | number)[] = [];

    if (req.query.platform) { where.push('c.platform = ?'); params.push(req.query.platform); }
    if (req.query.sourceId) { where.push('c.source_id = ?'); params.push(Number(req.query.sourceId)); }
    if (req.query.contentType) { where.push('c.content_type = ?'); params.push(req.query.contentType); }
    if (req.query.onlyBreakout === 'true') { where.push('(c.breakout_ratio >= 1.6 OR c.breakout_score >= 68)'); }
    if (req.query.hasTranscript === 'true') { where.push("c.transcript_status = 'done'"); }
    if (req.query.q && req.query.q.trim()) {
      const like = `%${req.query.q.trim()}%`;
      where.push('(c.title LIKE ? OR c.summary LIKE ? OR c.body LIKE ? OR c.transcript LIKE ? OR a.summary_zh LIKE ?)');
      params.push(like, like, like, like, like);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(Math.max(Number(req.query.limit || 60), 10), 200);

    const items = db
      .prepare(`
        SELECT c.id, c.source_id, c.platform, c.platform_item_id, c.canonical_url, c.title, c.author,
               c.summary, c.cover_url, c.tags_json, c.published_at, c.discovered_at, c.content_type,
               c.transcript_status, c.transcript_source, length(c.transcript) AS transcript_chars,
               c.cluster_id, c.breakout_score, c.breakout_ratio, c.growth_rate_per_hour, c.breakout_reason,
               s.name AS source_name, s.follower_count,
               a.category AS ai_category, a.summary_zh, a.trend_judgement, a.content_form_advice, a.analyzed_at,
               cl.title AS cluster_title, cl.source_count AS cluster_source_count,
               r.id AS recommendation_id, r.score_total AS rec_score, r.recommended_title AS rec_title, r.feedback_status,
               (SELECT views FROM content_metrics m WHERE m.content_id = c.id ORDER BY captured_at DESC LIMIT 1) AS latest_views,
               (SELECT likes FROM content_metrics m WHERE m.content_id = c.id ORDER BY captured_at DESC LIMIT 1) AS latest_likes,
               (SELECT comments FROM content_metrics m WHERE m.content_id = c.id ORDER BY captured_at DESC LIMIT 1) AS latest_comments,
               (SELECT favorites FROM content_metrics m WHERE m.content_id = c.id ORDER BY captured_at DESC LIMIT 1) AS latest_favorites,
               (SELECT shares FROM content_metrics m WHERE m.content_id = c.id ORDER BY captured_at DESC LIMIT 1) AS latest_shares,
               (SELECT COUNT(*) FROM content_comments cm WHERE cm.content_id = c.id) AS comment_rows,
               (SELECT COUNT(*) FROM topic_board tb WHERE tb.source_content_id = c.id) AS in_board_count
        FROM contents c
        JOIN sources s ON s.id = c.source_id
        LEFT JOIN content_analyses a ON a.content_id = c.id
        LEFT JOIN topic_clusters cl ON cl.id = c.cluster_id
        LEFT JOIN topic_recommendations r ON r.content_id = c.id AND r.account_id = ?
        ${whereSql}
        ORDER BY COALESCE(r.score_total, c.breakout_score, 0) DESC, c.discovered_at DESC
        LIMIT ?
      `)
      .all(account.id, ...params, limit);

    return { items, activeAccountId: account.id };
  });

  app.get('/api/radar/clusters', async () => {
    const db = getDb();
    const clusters = db.prepare('SELECT * FROM topic_clusters ORDER BY heat_score DESC, latest_at DESC LIMIT 30').all() as Array<
      Record<string, unknown>
    >;
    const stmtMembers = db.prepare(`
      SELECT c.id, c.title, c.platform, c.canonical_url, c.author, c.published_at, c.discovered_at,
             c.breakout_ratio, s.name AS source_name,
             (SELECT views FROM content_metrics m WHERE m.content_id = c.id ORDER BY captured_at DESC LIMIT 1) AS latest_views,
             (SELECT likes FROM content_metrics m WHERE m.content_id = c.id ORDER BY captured_at DESC LIMIT 1) AS latest_likes
      FROM contents c
      JOIN sources s ON s.id = c.source_id
      WHERE c.cluster_id = ?
      ORDER BY COALESCE(c.breakout_score, 0) DESC, c.discovered_at DESC
    `);
    return clusters.map((cl) => ({ ...cl, members: stmtMembers.all(Number(cl.id)) }));
  });

  app.get<{ Params: { id: string }; Querystring: { accountId?: string } }>('/api/radar/intel/:id/detail', async (req, reply) => {
    const id = Number(req.params.id);
    const db = getDb();
    const account = getActiveAccount(req.query.accountId ? Number(req.query.accountId) : undefined);

    const content = db
      .prepare(`
        SELECT c.*, s.name AS source_name, s.follower_count, s.baseline_views, s.baseline_likes, s.baseline_sample_size
        FROM contents c JOIN sources s ON s.id = c.source_id
        WHERE c.id = ?
      `)
      .get(id) as Record<string, unknown> | undefined;
    if (!content) return reply.code(404).send({ error: '内容不存在' });

    const metrics = db
      .prepare('SELECT * FROM content_metrics WHERE content_id = ? ORDER BY captured_at ASC LIMIT 40')
      .all(id);
    const comments = db
      .prepare('SELECT * FROM content_comments WHERE content_id = ? ORDER BY COALESCE(likes, 0) DESC LIMIT 40')
      .all(id);
    const analysis = db.prepare('SELECT * FROM content_analyses WHERE content_id = ?').get(id) || null;
    const recommendation =
      db.prepare('SELECT * FROM topic_recommendations WHERE content_id = ? AND account_id = ?').get(id, account.id) || null;
    const tingwuJobs = db
      .prepare('SELECT * FROM tingwu_jobs WHERE content_id = ? ORDER BY created_at DESC LIMIT 5')
      .all(id);
    const clusterSiblings = content.cluster_id
      ? db
          .prepare(`
            SELECT c.id, c.title, c.platform, c.canonical_url, s.name AS source_name
            FROM contents c JOIN sources s ON s.id = c.source_id
            WHERE c.cluster_id = ? AND c.id != ? LIMIT 8
          `)
          .all(Number(content.cluster_id), id)
      : [];
    const duplicates = findDuplicateTopics(String(content.title || ''));

    return { content, metrics, comments, analysis, recommendation, tingwuJobs, clusterSiblings, duplicates };
  });

  app.post<{ Params: { id: string }; Body: { force?: boolean } }>('/api/radar/intel/:id/analyze', async (req, reply) => {
    try {
      const res = await analyzeContentDeep(Number(req.params.id), Boolean(req.body?.force));
      return { ok: true, ...res };
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  app.post<{ Params: { id: string }; Body: { accountId?: number; force?: boolean } }>(
    '/api/radar/intel/:id/recommend',
    async (req, reply) => {
      try {
        const res = await generateRecommendationForContent(
          Number(req.params.id),
          req.body?.accountId,
          Boolean(req.body?.force)
        );
        return { ok: true, ...res };
      } catch (err) {
        return reply.code(500).send({ error: (err as Error).message });
      }
    }
  );

  app.post<{ Params: { id: string } }>('/api/radar/intel/:id/comments', async (req, reply) => {
    const res = await fetchCommentsWithMediaCrawler(Number(req.params.id));
    if (!res.ok) return reply.code(400).send(res);
    return res;
  });

  app.post<{ Params: { id: string } }>('/api/radar/intel/:id/transcribe', async (req, reply) => {
    const res = startTingwuTranscription(Number(req.params.id));
    if (!res.started) return reply.code(400).send(res);
    return res;
  });

  app.post<{ Body: { accountId?: number; limit?: number; forceRefresh?: boolean } }>(
    '/api/radar/recommendations/batch',
    async (req, reply) => {
      try {
        const res = await runBatchRecommendations({
          accountId: req.body?.accountId,
          limit: req.body?.limit || 8,
          forceRefresh: Boolean(req.body?.forceRefresh),
        });
        return { ok: true, ...res };
      } catch (err) {
        return reply.code(500).send({ error: (err as Error).message });
      }
    }
  );

  app.post('/api/radar/clusters/rebuild', async (_, reply) => {
    try {
      const res = await clusterRecentContents();
      return { ok: true, ...res };
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  app.post<{ Params: { id: string }; Body: { status: string; note?: string } }>(
    '/api/radar/recommendations/:id/feedback',
    async (req, reply) => {
      const id = Number(req.params.id);
      const allowed = new Set(['none', 'interested', 'not_interested', 'covered', 'watch_long', 'not_suitable']);
      const status = String(req.body?.status || '').trim();
      if (!allowed.has(status)) return reply.code(400).send({ error: '无效的反馈类型' });
      const db = getDb();
      const now = new Date().toISOString();
      db.prepare('UPDATE topic_recommendations SET feedback_status = ?, feedback_note = ?, feedback_at = ?, updated_at = ? WHERE id = ?').run(
        status,
        String(req.body?.note || '').trim().slice(0, 300),
        now,
        now,
        id
      );
      return { ok: true, id, feedback_status: status };
    }
  );

  // ===== 7. 个人选题库（6状态流转 + 历史查重 + 复盘） =====
  app.get<{ Querystring: { status?: string; priority?: string; q?: string } }>('/api/radar/board', async (req) => {
    const db = getDb();
    const where: string[] = [];
    const params: string[] = [];
    if (req.query.status) { where.push('b.status = ?'); params.push(req.query.status); }
    if (req.query.priority) { where.push('b.priority = ?'); params.push(req.query.priority); }
    if (req.query.q && req.query.q.trim()) {
      const like = `%${req.query.q.trim()}%`;
      where.push('(b.title LIKE ? OR b.core_angle LIKE ? OR b.notes LIKE ? OR b.tags_json LIKE ?)');
      params.push(like, like, like, like);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const items = db
      .prepare(`
        SELECT b.*,
               a.name AS account_name,
               c.platform AS content_platform,
               c.author AS content_author,
               c.breakout_ratio,
               c.transcript_status,
               (SELECT an.summary_zh FROM content_analyses an WHERE an.content_id = b.source_content_id LIMIT 1) AS ai_summary,
               (SELECT COUNT(*) FROM content_comments cm WHERE cm.content_id = b.source_content_id) AS comment_rows,
               CASE
                 WHEN b.source_content_id IS NOT NULL AND EXISTS(SELECT 1 FROM hot_board_items h WHERE h.content_id = b.source_content_id) THEN 'hotboard'
                 WHEN b.source_url LIKE '%/search/%' THEN 'hotboard'
                 WHEN b.source_content_id IS NOT NULL THEN 'creator'
                 ELSE 'manual'
               END AS source_origin
        FROM topic_board b
        LEFT JOIN creator_accounts a ON a.id = b.account_id
        LEFT JOIN contents c ON c.id = b.source_content_id
        ${whereSql}
        ORDER BY CASE WHEN b.status IN ('published', 'reviewed') THEN 1 ELSE 0 END ASC, b.updated_at DESC
        LIMIT 200
      `)
      .all(...params);
    return { items, statuses: TOPIC_BOARD_STATUSES };
  });

  app.post<{ Body: { title: string; excludeId?: number } }>('/api/radar/board/check-duplicate', async (req) => {
    const matches = findDuplicateTopics(String(req.body?.title || ''), req.body?.excludeId);
    return { hasDuplicate: matches.length > 0, matches };
  });

  app.post<{
    Body: {
      title: string;
      account_id?: number | null;
      source_content_id?: number | null;
      recommendation_id?: number | null;
      cluster_id?: number | null;
      core_angle?: string;
      tags?: string[];
      notes?: string;
      priority?: string;
      status?: string;
      source_url?: string;
      references?: unknown[];
    };
  }>('/api/radar/board', async (req, reply) => {
    const b = req.body || {};
    const title = (b.title || '').trim();
    if (!title) return reply.code(400).send({ error: '选题标题不能为空' });

    const duplicates = findDuplicateTopics(title);
    const db = getDb();
    const now = new Date().toISOString();
    const status = TOPIC_BOARD_STATUSES.includes(b.status as (typeof TOPIC_BOARD_STATUSES)[number])
      ? b.status!
      : 'to_research';
    const priority = ['high', 'medium', 'low'].includes(String(b.priority)) ? String(b.priority) : 'medium';

    const res = db
      .prepare(`
        INSERT INTO topic_board (
          account_id, source_content_id, recommendation_id, cluster_id, title, core_angle,
          tags_json, notes, priority, status, source_url, reference_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        b.account_id ?? getActiveAccount().id,
        b.source_content_id ?? null,
        b.recommendation_id ?? null,
        b.cluster_id ?? null,
        title.slice(0, 160),
        String(b.core_angle || '').trim().slice(0, 600),
        JSON.stringify(Array.isArray(b.tags) ? b.tags.filter(Boolean) : []),
        String(b.notes || '').trim(),
        priority,
        status,
        String(b.source_url || '').trim(),
        JSON.stringify(Array.isArray(b.references) ? b.references : []),
        now,
        now
      );
    const created = db.prepare('SELECT * FROM topic_board WHERE id = ?').get(Number(res.lastInsertRowid));
    return { ok: true, item: created, duplicates };
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/radar/board/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const db = getDb();
    if (!db.prepare('SELECT id FROM topic_board WHERE id = ?').get(id)) {
      return reply.code(404).send({ error: '选题不存在' });
    }
    const b = req.body || {};
    const sets: string[] = [];
    const params: unknown[] = [];
    const strFields = ['title', 'core_angle', 'notes', 'priority', 'status', 'source_url', 'published_url', 'review_notes'];
    for (const f of strFields) {
      if (b[f] !== undefined) {
        sets.push(`${f} = ?`);
        params.push(String(b[f]).trim());
      }
    }
    if (b.tags !== undefined) {
      sets.push('tags_json = ?');
      params.push(JSON.stringify(Array.isArray(b.tags) ? b.tags : []));
    }
    const numFields = ['review_views', 'review_likes', 'review_favorites', 'review_comments'];
    for (const f of numFields) {
      if (b[f] !== undefined) {
        sets.push(`${f} = ?`);
        params.push(b[f] === null || b[f] === '' ? null : Number(b[f]));
      }
    }
    if (sets.length > 0) {
      sets.push('updated_at = ?');
      params.push(new Date().toISOString(), id);
      db.prepare(`UPDATE topic_board SET ${sets.join(', ')} WHERE id = ?`).run(...(params as string[]));
    }
    return { ok: true, item: db.prepare('SELECT * FROM topic_board WHERE id = ?').get(id) };
  });

  app.delete<{ Params: { id: string } }>('/api/radar/board/:id', async (req) => {
    const db = getDb();
    db.prepare('DELETE FROM topic_board WHERE id = ?').run(Number(req.params.id));
    return { ok: true };
  });

  // ===== 8. AI / MediaCrawler / 通义听悟集成与状态 =====
  app.get('/api/radar/integrations', async () => {
    return {
      ai: getAiHealthSummary(),
      mediaCrawler: getMediaCrawlerStatus(),
      tingwu: getTingwuStatus(),
    };
  });

  app.get('/api/radar/ai/models', async () => {
    const cfg = getAiRuntimeConfig();
    if (!cfg.apiKey) return { models: [], error: '未配置 API Key' };
    try {
      const res = await fetch(`${cfg.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return { models: [], error: `HTTP ${res.status}` };
      const json = (await res.json()) as { data?: Array<{ id?: string }> };
      const models = (json.data || []).map((x) => x.id || '').filter(Boolean).sort();
      return { models };
    } catch (err) {
      return { models: [], error: (err as Error).message };
    }
  });

  app.post('/api/radar/tingwu/login', async () => {
    return launchTingwuLogin();
  });

  app.post('/api/radar/tingwu/sync', async () => {
    return await syncCompletedTingwuJobs();
  });
}
