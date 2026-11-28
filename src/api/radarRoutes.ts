import type { FastifyInstance } from 'fastify';
import { getDb, updateSourceAuthorProfile, upsertContentWithMetrics } from '../db/database.js';
import { getAdapter } from '../adapters/index.js';
import { fetchBilibiliHistory } from '../adapters/bilibiliAdapter.js';
import { fetchDouyinHistory } from '../adapters/douyinAdapter.js';
import type { SourceRecord } from '../adapters/types.js';
import { enqueueAllActiveCreators, getRunningSourceIds } from '../scheduler/taskRunner.js';
import { recomputeAllBreakouts, recomputeSourceBreakout } from '../services/breakoutService.js';
import {
  analyzeContentForR2,
  compareContentRemixSuitability,
  computeContentHeatScore,
  extractCommentTopicsAndIdeas,
  getContentCommentTopics,
  getShanghaiDayWindow,
  mapR2RowToPayload,
  saveCommentTopicToBoard,
} from '../services/creatorR2Service.js';
import {
  addCustomHotBoard,
  deleteCustomHotBoard,
  getUserHotBoards,
  importHotItemToIntel,
  refreshHotBoards,
  toggleUserHotBoard,
} from '../services/hotBoardService.js';
import {
  deleteUserNewsSource,
  generateDailyAiDigest,
  getNewsBriefSnapshot,
  getUserMonitorPrefs,
  matchKeywordsInText,
  refreshNewsBrief,
  saveUserKeywords,
  toggleUserNewsSource,
  upsertUserNewsSource,
} from '../services/newsBriefService.js';
import {
  generateRemixScript,
  generateViralBreakdown,
  getContentRemixRecord,
  getCreatorLeaderboard,
} from '../services/remixService.js';
import {
  generateCreatorCopyDigest,
  getCreatorCopyDigestMap,
  hasValidVideoTranscript,
} from '../services/creatorDigestService.js';
import {
  analyzeCommentCrawlJob,
  deleteCommentCrawlJob,
  fetchCommentsWithMediaCrawler,
  getCommentCrawlJob,
  getMediaCrawlerStatus,
  listCommentCrawlJobs,
  startStandaloneCommentCrawl,
} from '../services/mediaCrawlerBridge.js';
import {
  enqueueTranscriptAndDigest,
  getContentAsrPipelineState,
  getTingwuStatus,
  isAsrPipelineBusy,
  launchTingwuLogin,
  startTingwuTranscription,
  syncCompletedTingwuJobs,
} from '../services/tingwuBridge.js';
import {
  analyzeContentDeep,
  callAiJsonWithCache,
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

// 防止同一博主与后台定时任务或重复点击同时占用 Playwright 浏览器目录
const historyFetchLocks = new Set<number>();

// 对标博主信息流与榜单共用的查询字段（包含 R2 分析、完整互动快照与评论统计）
const CREATOR_FEED_SELECT = `
  SELECT c.id, c.source_id, c.platform, c.canonical_url, c.title, c.author, c.cover_url,
         c.summary, c.body, c.transcript, c.transcript_status,
         length(COALESCE(c.transcript, '')) AS transcript_chars,
         c.published_at, c.discovered_at, c.is_read,
         c.breakout_score, c.breakout_ratio, c.breakout_reason,
         s.name AS source_name, s.source_type AS source_type, s.follower_count AS creator_follower_count,
         (SELECT views FROM content_metrics m WHERE m.content_id = c.id ORDER BY captured_at DESC LIMIT 1) AS latest_views,
         (SELECT likes FROM content_metrics m WHERE m.content_id = c.id ORDER BY captured_at DESC LIMIT 1) AS latest_likes,
         (SELECT comments FROM content_metrics m WHERE m.content_id = c.id ORDER BY captured_at DESC LIMIT 1) AS latest_comments,
         (SELECT favorites FROM content_metrics m WHERE m.content_id = c.id ORDER BY captured_at DESC LIMIT 1) AS latest_favorites,
         (SELECT shares FROM content_metrics m WHERE m.content_id = c.id ORDER BY captured_at DESC LIMIT 1) AS latest_shares,
         (SELECT id FROM topic_board tb WHERE tb.source_content_id = c.id LIMIT 1) AS saved_board_id,
         (SELECT status FROM tingwu_jobs tj WHERE tj.content_id = c.id ORDER BY tj.created_at DESC LIMIT 1) AS asr_job_status,
         (SELECT error_message FROM tingwu_jobs tj WHERE tj.content_id = c.id ORDER BY tj.created_at DESC LIMIT 1) AS asr_error,
         (SELECT COUNT(*) FROM content_comments cm WHERE cm.content_id = c.id) AS comment_count,
         (SELECT COUNT(*) FROM comment_topic_ideas cti WHERE cti.content_id = c.id) AS comment_topics_count,
         r2.what_it_says AS r2_what_it_says,
         r2.heat_verdict AS r2_heat_verdict,
         r2.heat_level AS r2_heat_level,
         r2.remix_suitability AS r2_remix_suitability,
         r2.remix_score AS r2_remix_score,
         r2.remix_angle AS r2_remix_angle,
         r2.basis_source AS r2_basis_source,
         r2.updated_at AS r2_updated_at
  FROM contents c
  JOIN sources s ON s.id = c.source_id
  LEFT JOIN content_r2_analyses r2 ON r2.content_id = c.id
`;

function enrichCreatorFeedRow(row: Record<string, unknown>, digestMap: Record<string, unknown>): Record<string, unknown> {
  const {
    r2_what_it_says,
    r2_heat_verdict,
    r2_heat_level,
    r2_remix_suitability,
    r2_remix_score,
    r2_remix_angle,
    r2_basis_source,
    r2_updated_at,
    ...rest
  } = row;
  const transcriptText = String(row.transcript || '').trim();
  const transcriptPreview =
    row.transcript_status === 'done' || transcriptText.length > 0 ? transcriptText.slice(0, 180) : '';
  const r2Analysis = r2_updated_at
    ? mapR2RowToPayload({
        content_id: row.id,
        what_it_says: r2_what_it_says,
        heat_verdict: r2_heat_verdict,
        heat_level: r2_heat_level,
        remix_suitability: r2_remix_suitability,
        remix_score: r2_remix_score,
        remix_angle: r2_remix_angle,
        basis_source: r2_basis_source,
        updated_at: r2_updated_at,
      })
    : null;

  const asrPipe = getContentAsrPipelineState(Number(row.id));

  return {
    ...rest,
    transcript_chars: Number(row.transcript_chars || 0),
    transcript_preview: transcriptPreview,
    comment_count: Number(row.comment_count || 0),
    comment_topics_count: Number(row.comment_topics_count || 0),
    pipeline_stage: asrPipe.stage,
    queue_position: asrPipe.queuePosition,
    r2_analysis: r2Analysis,
    copy_digest: digestMap[String(row.id)] || null,
  };
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

    // 对标博主真爆款：按「每博主轮询雨露均沾」排位，防止单个博主霸占全部首屏席位
    const rawBreakouts = db
      .prepare(`
        SELECT c.id, c.source_id, c.title, c.platform, c.author, c.canonical_url, c.cover_url, c.published_at, c.discovered_at,
               c.breakout_score, c.breakout_ratio, c.growth_rate_per_hour, c.breakout_reason,
               c.transcript_status,
               s.name AS source_name, s.follower_count,
               COALESCE(a.summary_zh, '') AS brief,
               (SELECT views FROM content_metrics m WHERE m.content_id = c.id ORDER BY captured_at DESC LIMIT 1) AS latest_views,
               (SELECT likes FROM content_metrics m WHERE m.content_id = c.id ORDER BY captured_at DESC LIMIT 1) AS latest_likes,
               (SELECT comments FROM content_metrics m WHERE m.content_id = c.id ORDER BY captured_at DESC LIMIT 1) AS latest_comments,
               (SELECT favorites FROM content_metrics m WHERE m.content_id = c.id ORDER BY captured_at DESC LIMIT 1) AS latest_favorites,
               (SELECT COUNT(*) FROM content_comments cm WHERE cm.content_id = c.id) AS comment_rows,
               (SELECT id FROM topic_board tb WHERE tb.source_content_id = c.id LIMIT 1) AS saved_board_id
        FROM contents c
        JOIN sources s ON s.id = c.source_id
        LEFT JOIN content_analyses a ON a.content_id = c.id
        WHERE s.source_type != 'hot_board'
          AND (c.breakout_ratio >= 1.6 OR c.breakout_score >= 68)
        ORDER BY COALESCE(c.breakout_ratio, 0) DESC, COALESCE(c.breakout_score, 0) DESC, c.discovered_at DESC
        LIMIT 36
      `)
      .all() as Array<Record<string, unknown>>;

    // 按博主分组后轮询抽取（第 1 轮各取每个博主头号爆款，第 2 轮各取次爆，依次类推）
    const bySource = new Map<number, Array<Record<string, unknown>>>();
    for (const row of rawBreakouts) {
      const sid = Number(row.source_id || 0);
      const bucket = bySource.get(sid);
      if (bucket) bucket.push(row);
      else bySource.set(sid, [row]);
    }
    const buckets = Array.from(bySource.values());
    const breakouts: Array<Record<string, unknown>> = [];
    let round = 0;
    while (breakouts.length < 16) {
      let added = false;
      for (const bucket of buckets) {
        if (round < bucket.length) {
          breakouts.push(bucket[round]);
          added = true;
          if (breakouts.length >= 16) break;
        }
      }
      if (!added) break;
      round++;
    }

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

  // ===== 4. 专属平台热榜（支持自定义关注词/屏蔽词降噪 + 自由增删精准榜单） =====
  app.get<{ Querystring: { platform?: string; boardName?: string; category?: string; q?: string; focusOnly?: string } }>(
    '/api/radar/hot-board',
    async (req) => {
      const db = getDb();
      const prefs = getUserMonitorPrefs();
      const boards = getUserHotBoards();
      const enabledBoardNames = new Set(boards.filter((b) => b.enabled).map((b) => b.name));
      const verticalBoardNames = new Set(boards.filter((b) => b.isVertical).map((b) => b.name));

      const baseWhere: string[] = [
        `h.captured_at = (
          SELECT MAX(h2.captured_at) FROM hot_board_items h2
          WHERE h2.platform = h.platform AND h2.board_name = h.board_name
        )`,
        "h.board_name != '站内监控高热'",
      ];
      const baseParams: (string | number)[] = [];
      if (req.query.platform) {
        baseWhere.push('h.platform = ?');
        baseParams.push(req.query.platform);
      }
      if (req.query.boardName) {
        baseWhere.push('h.board_name = ?');
        baseParams.push(req.query.boardName);
      }
      if (req.query.q) {
        baseWhere.push('(h.title LIKE ? OR h.summary LIKE ? OR h.category LIKE ? OR h.author LIKE ?)');
        const like = `%${req.query.q.trim()}%`;
        baseParams.push(like, like, like, like);
      }

      const rawRows = db
        .prepare(`
          SELECT h.*,
                 (SELECT a.summary_zh FROM content_analyses a WHERE a.content_id = h.content_id LIMIT 1) AS ai_summary,
                 (SELECT tb.id FROM topic_board tb
                  WHERE (h.content_id IS NOT NULL AND tb.source_content_id = h.content_id)
                     OR (h.url != '' AND tb.source_url = h.url)
                  LIMIT 1) AS saved_board_id
          FROM hot_board_items h
          WHERE ${baseWhere.join(' AND ')}
          ORDER BY h.rank_no ASC, COALESCE(h.hot_value, 0) DESC, h.captured_at DESC
          LIMIT 260
        `)
        .all(...baseParams) as Array<Record<string, unknown>>;

      // 只展示当前已启用的榜单条目，并附加关注词/屏蔽词命中结果
      const activeRows = rawRows
        .filter((r) => enabledBoardNames.has(String(r.board_name || '')))
        .map((r) => {
          const hay = `${r.title || ''} ${r.summary || ''} ${r.category || ''} ${r.author || ''}`;
          const matchedKeywords = matchKeywordsInText(hay, prefs.focusKeywords);
          const blockedKeywords = matchKeywordsInText(hay, prefs.blockKeywords);
          const isVerticalBoard = verticalBoardNames.has(String(r.board_name || ''));
          return {
            ...r,
            board_name: String(r.board_name || ''),
            matched_keywords: matchedKeywords,
            is_blocked: blockedKeywords.length > 0,
            is_vertical: isVerticalBoard,
          };
        });

      const nonBlocked = activeRows.filter((r) => !r.is_blocked);
      const focusOnly = req.query.focusOnly === 'true';
      const items = focusOnly
        ? nonBlocked.filter((r) => r.matched_keywords.length > 0 || (prefs.focusKeywords.length === 0 && r.is_vertical))
        : nonBlocked;

      const catMap = new Map<string, number>();
      for (const it of items) {
        const name = String(it.board_name || '综合');
        catMap.set(name, (catMap.get(name) || 0) + 1);
      }
      const categories = Array.from(catMap.entries()).map(([name, count]) => ({ name, count }));

      return {
        items,
        categories,
        boards,
        focusKeywords: prefs.focusKeywords,
        blockKeywords: prefs.blockKeywords,
        totalCount: nonBlocked.length,
        matchedCount: nonBlocked.filter((r) => r.matched_keywords.length > 0).length,
      };
    }
  );

  app.post<{ Body: { id: string; enabled: boolean } }>('/api/radar/hot-board/boards/toggle', async (req) => {
    const boards = toggleUserHotBoard(String(req.body?.id || ''), Boolean(req.body?.enabled));
    return { ok: true, boards };
  });

  app.post<{ Body: { name: string; url: string; category?: string } }>('/api/radar/hot-board/boards', async (req, reply) => {
    try {
      const res = addCustomHotBoard({
        name: String(req.body?.name || ''),
        url: String(req.body?.url || ''),
        category: req.body?.category ? String(req.body.category) : undefined,
      });
      await refreshHotBoards([res.board.id]).catch(() => {});
      return { ok: true, ...res };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.delete<{ Params: { id: string } }>('/api/radar/hot-board/boards/:id', async (req) => {
    return { ok: true, boards: deleteCustomHotBoard(req.params.id) };
  });

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
    const r2Row = db.prepare('SELECT * FROM content_r2_analyses WHERE content_id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    const r2Analysis = r2Row ? mapR2RowToPayload(r2Row) : null;
    const commentTopics = getContentCommentTopics(id);
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

    return { content, metrics, comments, analysis, r2Analysis, commentTopics, recommendation, tingwuJobs, clusterSiblings, duplicates };
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

  // ===== 9. 视频发布 AI 按平台定制标题、正文与标签 =====
  app.get('/api/publish/script-sources', async () => {
    const db = getDb();
    const transcripts = db
      .prepare(`
        SELECT id, title, platform, author, transcript, discovered_at
        FROM contents
        WHERE transcript IS NOT NULL AND length(transcript) >= 30
        ORDER BY discovered_at DESC
        LIMIT 20
      `)
      .all();
    const saved = db
      .prepare(`
        SELECT id, title, core_angle, notes, source_content_id, updated_at
        FROM topic_board
        ORDER BY updated_at DESC
        LIMIT 20
      `)
      .all();
    return { transcripts, saved };
  });

  app.post<{
    Body: {
      script: string;
      platforms?: number[];
      styleHint?: string;
      forceRefresh?: boolean;
    };
  }>('/api/publish/ai-generate', async (req, reply) => {
    const script = String(req.body?.script || '').trim();
    if (script.length < 8) {
      return reply.code(400).send({ error: '请先粘贴一段口播稿、文案或核心思路（至少 8 个字）' });
    }
    const styleHint = String(req.body?.styleHint || '').trim();

    try {
      const { data, cached, model } = await callAiJsonWithCache<{
        douyin?: { title?: string; description?: string; tags?: string[]; tip?: string };
        xiaohongshu?: { title?: string; description?: string; tags?: string[]; tip?: string };
        channels?: { title?: string; description?: string; tags?: string[]; tip?: string };
        kuaishou?: { title?: string; description?: string; tags?: string[]; tip?: string };
      }>({
        purpose: 'publish_platform_copy',
        system: `你是精通抖音、小红书、微信视频号、快手四大短视频平台算法的爆款标题与标签策划总监。
请根据用户提供的视频文案/口播稿，为 4 个平台分别量身定制最容易起量的标题、简短正文和话题标签。
严格要求：
1. 抖音（douyin）：抓眼球强钩子/反常识短标题（15~28字，不要堆emoji），简短引导互动正文（30~60字），4~5个精准搜索+热门标签。
2. 小红书（xiaohongshu）：种草感/痛点直击标题（12~20字，自然带1~2个emoji），分段干货正文+收藏引导（60~120字），5~6个高搜索标签。
3. 微信视频号（channels）：克制、有信息量、适合转发朋友圈/微信群的稳重干货标题（15~28字），简洁要点正文（40~80字），3~5个标签。
4. 快手（kuaishou）：大白话、接地气、直接给结果的老铁风格标题（15~28字），简短正文（30~60字），4~5个标签。
5. 所有 tags 数组元素只写纯词（不要带 # 号和空格）。只输出严格 JSON，不要额外解释。`,
        user: `${styleHint ? `额外风格要求：${styleHint}\n\n` : ''}视频文案 / 口播稿内容：
${script.slice(0, 4500)}

请返回 JSON：
{
  "douyin": { "title": "", "description": "", "tags": [""], "tip": "一句起量原因" },
  "xiaohongshu": { "title": "", "description": "", "tags": [""], "tip": "一句起量原因" },
  "channels": { "title": "", "description": "", "tags": [""], "tip": "一句起量原因" },
  "kuaishou": { "title": "", "description": "", "tags": [""], "tip": "一句起量原因" }
}`,
        temperature: 0.45,
        maxTokens: 1600,
        forceRefresh: Boolean(req.body?.forceRefresh),
      });

      const norm = (obj?: { title?: string; description?: string; tags?: string[]; tip?: string }) => ({
        title: String(obj?.title || '').trim(),
        description: String(obj?.description || '').trim(),
        tags: Array.isArray(obj?.tags)
          ? obj!.tags.map((t) => String(t).replace(/^#+/, '').trim()).filter(Boolean).slice(0, 8)
          : [],
        tip: String(obj?.tip || '').trim(),
      });

      return {
        ok: true,
        cached,
        model,
        byPlatform: {
          3: norm(data.douyin), // 抖音
          1: norm(data.xiaohongshu), // 小红书
          2: norm(data.channels), // 微信视频号
          4: norm(data.kuaishou), // 快手
        },
      };
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  // ===== 10. 独立清爽「评论采集」工作台接口（单端口 18910 内完成） =====
  app.get('/api/comments/jobs', async () => {
    return {
      status: getMediaCrawlerStatus(),
      jobs: listCommentCrawlJobs(),
    };
  });

  app.get<{ Params: { id: string } }>('/api/comments/jobs/:id', async (req, reply) => {
    const job = getCommentCrawlJob(req.params.id);
    if (!job) return reply.code(404).send({ error: '采集记录不存在' });
    return { job };
  });

  app.post<{
    Body: {
      platform: 'douyin' | 'bilibili' | 'xiaohongshu' | 'kuaishou';
      mode: 'detail' | 'search' | 'creator';
      input: string;
      maxComments?: number;
      showBrowser?: boolean;
    };
  }>('/api/comments/crawl', async (req, reply) => {
    const b = req.body || ({} as Record<string, unknown>);
    const res = startStandaloneCommentCrawl({
      platform: b.platform || 'douyin',
      mode: b.mode || 'detail',
      input: String(b.input || ''),
      maxComments: b.maxComments ? Number(b.maxComments) : 30,
      showBrowser: Boolean(b.showBrowser),
    });
    if (!res.started) return reply.code(400).send(res);
    return res;
  });

  app.post<{ Params: { id: string } }>('/api/comments/jobs/:id/analyze', async (req, reply) => {
    try {
      const summary = await analyzeCommentCrawlJob(req.params.id);
      return { ok: true, summary };
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  app.delete<{ Params: { id: string } }>('/api/comments/jobs/:id', async (req) => {
    return { ok: deleteCommentCrawlJob(req.params.id) };
  });

  // ===== 11. 国内外 AI 热点早报 + 用户自定义关注词与新闻源 =====
  app.get('/api/radar/news-brief', async () => {
    return getNewsBriefSnapshot();
  });

  app.post('/api/radar/news-brief/refresh', async () => {
    const cache = await refreshNewsBrief();
    return { ok: true, ...cache, ...getUserMonitorPrefs() };
  });

  app.post<{ Body: { forceRefresh?: boolean } }>('/api/radar/news-brief/digest', async (req, reply) => {
    try {
      const res = await generateDailyAiDigest(Boolean(req.body?.forceRefresh));
      return { ok: true, ...res };
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  app.put<{ Body: { focusKeywords?: string[]; blockKeywords?: string[] } }>('/api/radar/preferences/keywords', async (req) => {
    const saved = saveUserKeywords({
      focusKeywords: Array.isArray(req.body?.focusKeywords) ? req.body.focusKeywords : undefined,
      blockKeywords: Array.isArray(req.body?.blockKeywords) ? req.body.blockKeywords : undefined,
    });
    return { ok: true, ...saved };
  });

  app.post<{ Body: { name: string; url: string; region?: 'domestic' | 'global'; category?: string } }>(
    '/api/radar/news-brief/sources',
    async (req, reply) => {
      try {
        const newsSources = upsertUserNewsSource({
          name: String(req.body?.name || ''),
          url: String(req.body?.url || ''),
          region: req.body?.region === 'global' ? 'global' : 'domestic',
          category: req.body?.category ? String(req.body.category) : undefined,
        });
        return { ok: true, newsSources };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    }
  );

  app.post<{ Body: { id: string; enabled: boolean } }>('/api/radar/news-brief/sources/toggle', async (req) => {
    const newsSources = toggleUserNewsSource(String(req.body?.id || ''), Boolean(req.body?.enabled));
    return { ok: true, newsSources };
  });

  app.delete<{ Params: { id: string } }>('/api/radar/news-brief/sources/:id', async (req) => {
    return { ok: true, newsSources: deleteUserNewsSource(req.params.id) };
  });

  // ===== 12. 对标博主跨账号爆款排行榜 & 一站式爆款拆解二创工坊 =====
  app.get<{
    Querystring: {
      platform?: string;
      creatorId?: string;
      sort?: 'ratio' | 'likes' | 'views' | 'recent';
      days?: string;
      onlyBreakout?: string;
      limit?: string;
    };
  }>('/api/radar/creators/leaderboard', async (req) => {
    const items = getCreatorLeaderboard({
      platform: req.query.platform || undefined,
      creatorId: req.query.creatorId ? Number(req.query.creatorId) : undefined,
      sort: req.query.sort || 'ratio',
      days: req.query.days ? Number(req.query.days) : undefined,
      onlyBreakout: req.query.onlyBreakout === 'true',
      limit: req.query.limit ? Number(req.query.limit) : 40,
    });
    return { items };
  });

  app.get<{ Params: { id: string } }>('/api/radar/intel/:id/remix', async (req) => {
    return { record: getContentRemixRecord(Number(req.params.id)) };
  });

  app.post<{
    Params: { id: string };
    Body: {
      mode: 'breakdown' | 'rewrite';
      angle?: string;
      tone?: string;
      lengthLabel?: string;
      extraInstruction?: string;
      forceRefresh?: boolean;
    };
  }>('/api/radar/intel/:id/remix', async (req, reply) => {
    const contentId = Number(req.params.id);
    const mode = req.body?.mode || 'breakdown';
    try {
      if (mode === 'breakdown') {
        const breakdown = await generateViralBreakdown(contentId, Boolean(req.body?.forceRefresh));
        return { ok: true, breakdown, record: getContentRemixRecord(contentId) };
      }
      const draft = await generateRemixScript({
        contentId,
        angle: String(req.body?.angle || '').trim(),
        tone: String(req.body?.tone || '接地气大白话').trim(),
        lengthLabel: String(req.body?.lengthLabel || '2分钟干货').trim(),
        extraInstruction: req.body?.extraInstruction ? String(req.body.extraInstruction).trim() : undefined,
        forceRefresh: Boolean(req.body?.forceRefresh),
      });
      return { ok: true, draft, record: getContentRemixRecord(contentId) };
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  // ===== 13. 对标博主极简追更流（R1 每日更新与热度榜 + R2 三项分析与对比 + R3 历史分页 + R4 评论话题） =====
  app.get<{
    Querystring: {
      creatorId?: string;
      days?: string;
      onlyUnread?: string;
      offset?: string;
      limit?: string;
      includeRss?: string;
      search?: string;
    };
  }>('/api/radar/creators/feed', async (req) => {
    const db = getDb();
    const runningSet = new Set([...getRunningSourceIds(), ...historyFetchLocks]);
    const creatorId = req.query.creatorId ? Number(req.query.creatorId) : null;
    const rawDays = req.query.days !== undefined && req.query.days !== '' ? Number(req.query.days) : 7;
    const days = Number.isFinite(rawDays) ? rawDays : 7;
    const onlyUnread = req.query.onlyUnread === 'true';
    const offset = Math.max(0, Math.floor(Number(req.query.offset || 0) || 0));
    const limit = Math.min(Math.max(Math.floor(Number(req.query.limit || 30) || 30), 1), 200);
    const includeRss = req.query.includeRss === '1' || req.query.includeRss === 'true';
    const search = String(req.query.search || '').trim();

    // 默认将视频博主与 RSS 博客/资讯源分离；仅显式传 includeRss=1 时混入 RSS，始终排除热榜导入
    const sourceFilterSql = includeRss
      ? "s.source_type IN ('creator', 'rss', 'social', 'column')"
      : "s.source_type = 'creator'";

    const { dateLocal, todayStartUtcIso, todayEndUtcIso, todayStartMs } = getShanghaiDayWindow();

    // 统计 14 天内未读与东八区当日新发计数
    const rawCreators = db
      .prepare(`
        SELECT s.id, s.name, s.platform, s.url, s.source_type, s.status, s.interval_minutes,
               s.last_checked_at, s.last_error, s.follower_count, s.avatar_url,
               (SELECT COUNT(*) FROM contents c WHERE c.source_id = s.id) AS content_count,
               (SELECT COUNT(*) FROM contents c
                WHERE c.source_id = s.id
                  AND c.is_read = 0
                  AND COALESCE(c.published_at, c.discovered_at) >= datetime('now', '-14 days')) AS unread_count,
               (SELECT COUNT(*) FROM contents c
                WHERE c.source_id = s.id
                  AND COALESCE(c.published_at, c.discovered_at) >= ?
                  AND COALESCE(c.published_at, c.discovered_at) < ?) AS today_new_count,
               (SELECT MAX(COALESCE(c.published_at, c.discovered_at)) FROM contents c WHERE c.source_id = s.id) AS latest_published_at
        FROM sources s
        WHERE ${sourceFilterSql}
        ORDER BY today_new_count DESC, unread_count DESC, latest_published_at DESC, s.id DESC
      `)
      .all(todayStartUtcIso, todayEndUtcIso) as Array<Record<string, unknown>>;

    const creators = rawCreators.map((c) => ({
      ...c,
      content_count: Number(c.content_count || 0),
      unread_count: Number(c.unread_count || 0),
      today_new_count: Number(c.today_new_count || 0),
      is_running: runningSet.has(Number(c.id)),
    }));
    const totalUnread = creators.reduce((sum, c) => sum + c.unread_count, 0);

    const digestMap = getCreatorCopyDigestMap();

    // R1：今日最新更新视图（优先展示东八区今日新发；若今日暂无新发，展示每位博主最近 1 条动态）
    const todayRows = db
      .prepare(`
        ${CREATOR_FEED_SELECT}
        WHERE ${sourceFilterSql}
          AND COALESCE(c.published_at, c.discovered_at) >= ?
          AND COALESCE(c.published_at, c.discovered_at) < ?
        ORDER BY COALESCE(c.published_at, c.discovered_at) DESC, c.id DESC
        LIMIT 30
      `)
      .all(todayStartUtcIso, todayEndUtcIso) as Array<Record<string, unknown>>;

    let todayUpdatesItems: Array<Record<string, unknown>>;
    const hasTodayNew = todayRows.length > 0;
    if (hasTodayNew) {
      todayUpdatesItems = todayRows.map((r) => enrichCreatorFeedRow(r, digestMap));
    } else {
      const latestPerCreatorRows = db
        .prepare(`
          SELECT * FROM (
            SELECT c.id,
                   ROW_NUMBER() OVER (PARTITION BY c.source_id ORDER BY COALESCE(c.published_at, c.discovered_at) DESC, c.id DESC) AS rn
            FROM contents c
            JOIN sources s ON s.id = c.source_id
            WHERE ${sourceFilterSql}
          ) ranked
          JOIN (${CREATOR_FEED_SELECT}) full_row ON full_row.id = ranked.id
          WHERE ranked.rn = 1
          ORDER BY COALESCE(full_row.published_at, full_row.discovered_at) DESC, full_row.id DESC
          LIMIT 20
        `)
        .all() as Array<Record<string, unknown>>;
      todayUpdatesItems = latestPerCreatorRows.map((r) => {
        const { rn: _rn, ...clean } = r;
        return enrichCreatorFeedRow(clean, digestMap);
      });
    }

    const todayUpdates = {
      dateLocal,
      hasTodayNew,
      todayCount: todayRows.length,
      items: todayUpdatesItems,
    };

    // R1：当日新发热度排行榜（当日 -> 近3天 -> 近7天 -> 历史高热兜底，兼容抖音 views=null）
    const lbLadder: Array<{
      isFallback: boolean;
      fallbackLabel: string;
      startIso: string | null;
      endIso: string | null;
    }> = [
      { isFallback: false, fallbackLabel: '', startIso: todayStartUtcIso, endIso: todayEndUtcIso },
      {
        isFallback: true,
        fallbackLabel: '今日暂无新发，以下为近 3 天新发热度榜',
        startIso: new Date(todayStartMs - 2 * 86400000).toISOString(),
        endIso: null,
      },
      {
        isFallback: true,
        fallbackLabel: '今日暂无新发，以下为近 7 天新发热度榜',
        startIso: new Date(todayStartMs - 6 * 86400000).toISOString(),
        endIso: null,
      },
      {
        isFallback: true,
        fallbackLabel: '近期暂无新发，以下为历史高热作品榜',
        startIso: null,
        endIso: null,
      },
    ];

    let lbCandidates: Array<Record<string, unknown>> = [];
    let lbMeta = lbLadder[lbLadder.length - 1];
    for (const step of lbLadder) {
      const lbWhere: string[] = [sourceFilterSql];
      const lbArgs: (string | number)[] = [];
      if (step.startIso) {
        lbWhere.push('COALESCE(c.published_at, c.discovered_at) >= ?');
        lbArgs.push(step.startIso);
      }
      if (step.endIso) {
        lbWhere.push('COALESCE(c.published_at, c.discovered_at) < ?');
        lbArgs.push(step.endIso);
      }
      const rows = db
        .prepare(`
          ${CREATOR_FEED_SELECT}
          WHERE ${lbWhere.join(' AND ')}
          ORDER BY COALESCE(c.published_at, c.discovered_at) DESC, c.id DESC
          LIMIT 100
        `)
        .all(...lbArgs) as Array<Record<string, unknown>>;
      if (rows.length > 0) {
        lbCandidates = rows;
        lbMeta = step;
        break;
      }
    }

    const lbScored = lbCandidates
      .map((row) => {
        const enriched = enrichCreatorFeedRow(row, digestMap);
        const { heatScore, heatBasis } = computeContentHeatScore({
          latest_views: row.latest_views as number | null,
          latest_likes: row.latest_likes as number | null,
          latest_comments: row.latest_comments as number | null,
          latest_favorites: row.latest_favorites as number | null,
          latest_shares: row.latest_shares as number | null,
          breakout_ratio: row.breakout_ratio as number | null,
          breakout_score: row.breakout_score as number | null,
        });
        return { enriched, heatScore, heatBasis };
      })
      .sort((a, b) => {
        if (b.heatScore !== a.heatScore) return b.heatScore - a.heatScore;
        const bRatio = Number(b.enriched.breakout_ratio || 0);
        const aRatio = Number(a.enriched.breakout_ratio || 0);
        if (bRatio !== aRatio) return bRatio - aRatio;
        const bLikes = Number(b.enriched.latest_likes || 0);
        const aLikes = Number(a.enriched.latest_likes || 0);
        if (bLikes !== aLikes) return bLikes - aLikes;
        const bPub = Date.parse(String(b.enriched.published_at || b.enriched.discovered_at || '')) || 0;
        const aPub = Date.parse(String(a.enriched.published_at || a.enriched.discovered_at || '')) || 0;
        if (bPub !== aPub) return bPub - aPub;
        return Number(b.enriched.id) - Number(a.enriched.id);
      })
      .slice(0, 10)
      .map((entry, idx) => ({
        ...entry.enriched,
        rank: idx + 1,
        heatScore: entry.heatScore,
        heatBasis: entry.heatBasis,
      }));

    const todayLeaderboard = {
      dateLocal,
      isFallback: lbMeta.isFallback,
      fallbackLabel: lbMeta.fallbackLabel,
      items: lbScored,
    };

    // R3：分博主历史作品列表（严格按发布时间从新到旧排序 + offset/limit 分页 + 搜索）
    const where: string[] = [sourceFilterSql];
    const args: (string | number)[] = [];
    if (creatorId) {
      where.push('c.source_id = ?');
      args.push(creatorId);
    }
    if (days === 1) {
      where.push('COALESCE(c.published_at, c.discovered_at) >= ? AND COALESCE(c.published_at, c.discovered_at) < ?');
      args.push(todayStartUtcIso, todayEndUtcIso);
    } else if (days > 1) {
      const startIso = new Date(todayStartMs - (days - 1) * 86400000).toISOString();
      where.push('COALESCE(c.published_at, c.discovered_at) >= ?');
      args.push(startIso);
    }
    if (onlyUnread) {
      where.push('c.is_read = 0');
    }
    if (search) {
      const like = `%${search}%`;
      where.push('(c.title LIKE ? OR c.summary LIKE ? OR c.transcript LIKE ? OR s.name LIKE ?)');
      args.push(like, like, like, like);
    }

    const whereClause = where.join(' AND ');
    const total = Number(
      (
        db
          .prepare(`SELECT COUNT(*) AS c FROM contents c JOIN sources s ON s.id = c.source_id WHERE ${whereClause}`)
          .get(...args) as { c: number }
      ).c || 0
    );

    let items = db
      .prepare(`
        ${CREATOR_FEED_SELECT}
        WHERE ${whereClause}
        ORDER BY COALESCE(c.published_at, c.discovered_at) DESC, c.id DESC
        LIMIT ? OFFSET ?
      `)
      .all(...args, limit, offset) as Array<Record<string, unknown>>;

    let fallbackShown = false;
    // 仅在首页（offset=0）且未指定搜索/未读筛选、按天数过滤为空时，温柔回退最近历史条目避免白屏
    if (offset === 0 && items.length === 0 && days > 0 && !onlyUnread && !search) {
      const fallbackLimit = Math.min(limit, creatorId ? 5 : 8);
      const fbWhere: string[] = [sourceFilterSql];
      const fbArgs: (string | number)[] = [];
      if (creatorId) {
        fbWhere.push('c.source_id = ?');
        fbArgs.push(creatorId);
      }
      items = db
        .prepare(`
          ${CREATOR_FEED_SELECT}
          WHERE ${fbWhere.join(' AND ')}
          ORDER BY COALESCE(c.published_at, c.discovered_at) DESC, c.id DESC
          LIMIT ?
        `)
        .all(...fbArgs, fallbackLimit) as Array<Record<string, unknown>>;
      if (items.length > 0) fallbackShown = true;
    }

    const enrichedItems = items.map((it) => enrichCreatorFeedRow(it, digestMap));
    const hasMore = !fallbackShown && offset + enrichedItems.length < total;

    const intervalRow = db.prepare("SELECT value FROM app_settings WHERE key = 'default_creator_interval'").get() as
      | { value?: string }
      | undefined;
    const checkIntervalMinutes = Number(intervalRow?.value) > 0 ? Number(intervalRow?.value) : 30;

    return {
      creators,
      todayUpdates,
      todayLeaderboard,
      items: enrichedItems,
      total,
      offset,
      limit,
      hasMore,
      fallbackShown,
      totalUnread,
      checkIntervalMinutes,
      anyRunning: runningSet.size > 0,
      asrRunning: isAsrPipelineBusy(),
    };
  });

  // R2：单条视频统一三项 AI 分析（讲了什么 / 火不火 / 是否适合二创）
  app.post<{ Params: { id: string }; Body: { force?: boolean } }>(
    '/api/radar/intel/:id/r2-analyze',
    async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return reply.code(400).send({ error: '无效的内容 ID' });
      }
      const analysis = await analyzeContentForR2(id, Boolean(req.body?.force));
      if (!analysis) {
        return reply.code(404).send({ error: '内容不存在' });
      }
      return { ok: true, analysis };
    }
  );

  // R2：多视频横向对比，选出最适合二次创作的视频
  app.post<{ Body: { contentIds?: number[]; creatorId?: number } }>(
    '/api/radar/creators/compare-remix',
    async (req) => {
      return await compareContentRemixSuitability({
        contentIds: Array.isArray(req.body?.contentIds) ? req.body.contentIds : undefined,
        creatorId: req.body?.creatorId ? Number(req.body.creatorId) : undefined,
      });
    }
  );

  // R3：按需深抓指定博主更多历史视频（B站多页 / 抖音滚动加载）
  app.post<{ Params: { id: string }; Body: { maxPages?: number } }>(
    '/api/radar/creators/:id/fetch-history',
    async (req, reply) => {
      const sourceId = Number(req.params.id);
      if (!Number.isInteger(sourceId) || sourceId <= 0) {
        return reply.code(400).send({ error: '无效的博主 ID' });
      }
      const db = getDb();
      const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(sourceId) as SourceRecord | undefined;
      if (!source) {
        return reply.code(404).send({ error: '博主不存在' });
      }
      if (source.source_type === 'hot_board') {
        return reply.code(400).send({ error: '热榜来源不支持抓取博主历史作品' });
      }
      if (getRunningSourceIds().includes(sourceId) || historyFetchLocks.has(sourceId)) {
        return reply.code(409).send({ ok: false, error: '该博主正在采集或拉取历史作品中，请稍候完成' });
      }

      const maxPages = Math.min(Math.max(Math.round(Number(req.body?.maxPages || 3)), 1), 5);
      const modeRow = db.prepare("SELECT value FROM app_settings WHERE key = 'browser_mode'").get() as
        | { value?: string }
        | undefined;
      const headless = modeRow?.value !== 'headed';

      historyFetchLocks.add(sourceId);
      try {
        let fetchRes;
        if (source.platform === 'bilibili') {
          fetchRes = await fetchBilibiliHistory(source, { headless, maxPages });
        } else if (source.platform === 'douyin') {
          fetchRes = await fetchDouyinHistory(source, { headless, maxPages });
        } else {
          fetchRes = await getAdapter(source.platform).fetchLatest(source, { headless });
        }

        if (fetchRes.authorProfile) {
          updateSourceAuthorProfile(sourceId, fetchRes.authorProfile);
        }

        let insertedCount = 0;
        let updatedCount = 0;
        for (const item of fetchRes.items) {
          const saved = upsertContentWithMetrics({
            sourceId,
            platform: source.platform,
            platformItemId: item.platformItemId,
            url: item.url,
            title: item.title,
            author: item.author,
            summary: item.summary,
            body: item.body,
            coverUrl: item.coverUrl,
            tags: item.tags,
            publishedAt: item.publishedAt,
            pageUpdatedAt: item.pageUpdatedAt,
            contentType: item.contentType,
            rawMeta: item.rawMeta,
            metrics: item.metrics,
          });
          if (saved.isNew) {
            insertedCount++;
          } else if (saved.metricsUpdated) {
            updatedCount++;
          }
        }

        if (fetchRes.items.length > 0) {
          recomputeSourceBreakout(sourceId);
        }

        const totalStored = Number(
          (db.prepare('SELECT COUNT(*) AS c FROM contents WHERE source_id = ?').get(sourceId) as { c: number }).c || 0
        );

        if (!fetchRes.ok && fetchRes.items.length === 0) {
          return reply.code(fetchRes.authRequired ? 401 : 400).send({
            ok: false,
            error: fetchRes.errorMessage || '暂未抓取到更多历史作品',
            sourceId,
            fetchedCount: 0,
            insertedCount: 0,
            updatedCount: 0,
            totalStored,
          });
        }

        return {
          ok: true,
          sourceId,
          fetchedCount: fetchRes.items.length,
          insertedCount,
          updatedCount,
          totalStored,
        };
      } finally {
        historyFetchLocks.delete(sourceId);
      }
    }
  );

  // R4：基于真实评论区提炼讨论热门话题与对应创作选题（绝不编造虚假评论）
  app.post<{ Params: { id: string }; Body: { autoCrawl?: boolean; force?: boolean } }>(
    '/api/radar/intel/:id/comments/topics',
    async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return reply.code(400).send({ error: '无效的内容 ID' });
      }
      const result = await extractCommentTopicsAndIdeas(id, {
        autoCrawl: Boolean(req.body?.autoCrawl),
        force: Boolean(req.body?.force),
      });
      if (!result) {
        return reply.code(404).send({ error: '内容不存在' });
      }
      return result;
    }
  );

  // R4：将评论话题一键存入个人选题库（幂等防重复）
  app.post<{ Params: { topicId: string } }>(
    '/api/radar/comments/topics/:topicId/save-board',
    async (req, reply) => {
      const topicId = Number(req.params.topicId);
      if (!Number.isInteger(topicId) || topicId <= 0) {
        return reply.code(400).send({ error: '无效的话题 ID' });
      }
      const saved = saveCommentTopicToBoard(topicId);
      if (!saved) {
        return reply.code(404).send({ error: '评论话题不存在' });
      }
      return saved;
    }
  );

  // 单条视频深度 1234 文案归纳：视频必须基于完整转写口播（绝不拿标题硬猜）；未转写则一键入队「提音→显卡转写→自动归纳」
  app.post<{ Params: { id: string }; Body: { forceRefresh?: boolean } }>(
    '/api/radar/intel/:id/copy-digest',
    async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return reply.code(400).send({ error: '无效的内容 ID' });
      }
      const check = hasValidVideoTranscript(id);
      if (!check.exists) {
        return reply.code(404).send({ error: '视频记录不存在' });
      }
      // 视频尚无完整口播逐字稿：严禁拿标题/简介硬猜，直接自动串起本机 RTX 显卡转写 + 深度归纳流水线
      if (check.isVideo && !check.hasTranscript) {
        const queued = enqueueTranscriptAndDigest(id, true);
        if (!queued.started) {
          return reply.code(400).send({ ok: false, error: queued.message });
        }
        return {
          ok: true,
          status: 'transcribing',
          queued: true,
          alreadyQueued: Boolean(queued.alreadyQueued),
          jobId: queued.jobId,
          position: queued.position ?? 0,
          message: queued.message,
        };
      }
      try {
        const res = await generateCreatorCopyDigest(id, Boolean(req.body?.forceRefresh));
        return { ok: true, status: 'done', ...res };
      } catch (err) {
        return reply.code(500).send({ error: (err as Error).message });
      }
    }
  );

  app.post('/api/radar/creators/check-all', async () => {
    const res = enqueueAllActiveCreators();
    return {
      ok: true,
      ...res,
      message: res.queued > 0 ? `已启动追更，正在依次检查 ${res.queued} 位对标博主的最新更新...` : '所有博主都在检查中，请稍候',
    };
  });

  app.post<{ Body: { creatorId?: number; contentId?: number } }>('/api/radar/creators/mark-read', async (req) => {
    const db = getDb();
    const { creatorId, contentId } = req.body || {};
    let changes = 0;
    if (contentId) {
      changes = Number(db.prepare('UPDATE contents SET is_read = 1 WHERE id = ?').run(Number(contentId)).changes);
    } else if (creatorId) {
      changes = Number(db.prepare('UPDATE contents SET is_read = 1 WHERE source_id = ? AND is_read = 0').run(Number(creatorId)).changes);
    } else {
      changes = Number(
        db
          .prepare("UPDATE contents SET is_read = 1 WHERE is_read = 0 AND source_id IN (SELECT id FROM sources WHERE source_type != 'hot_board')")
          .run().changes
      );
    }
    return { ok: true, updated: changes };
  });

  app.put<{ Body: { intervalMinutes: number } }>('/api/radar/creators/interval', async (req) => {
    const mins = Math.min(240, Math.max(15, Number(req.body?.intervalMinutes || 30)));
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ('default_creator_interval', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(String(mins), now);
    db.prepare("UPDATE sources SET interval_minutes = ?, updated_at = ? WHERE source_type != 'hot_board'").run(mins, now);
    return { ok: true, intervalMinutes: mins };
  });
}
