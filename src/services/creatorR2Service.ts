import crypto from 'node:crypto';
import { getDb } from '../db/database.js';
import { callAiJsonWithCache, getActiveAccount } from './aiRadarService.js';
import { computeEngagementScore } from './breakoutService.js';
import { fetchCommentsWithMediaCrawler } from './mediaCrawlerBridge.js';

export interface R2AnalysisPayload {
  contentId: number;
  whatItSays: string;
  heatVerdict: string;
  heatLevel: 'viral' | 'hot' | 'normal' | 'low' | 'unknown';
  remixSuitability: string;
  remixScore: number;
  remixAngle: string;
  basisSource: '口播全文+真实数据' | '标题简介+真实数据';
  updatedAt: string;
}

export interface RemixCompareItem {
  contentId: number;
  title: string;
  rank: number;
  remixScore: number;
  verdict: string;
  reason: string;
  suggestedHook: string;
}

export interface CommentTopicIdeaItem {
  id: number;
  topic: string;
  heatNote: string;
  evidenceComments: string[];
  creationIdeaTitle: string;
  creationAngle: string;
  savedBoardId: number | null;
}

const SHANGHAI_OFFSET_MS = 8 * 3600 * 1000;

// 计算东八区（Asia/Shanghai）日历日及对应的 UTC 起止边界
export function getShanghaiDayWindow(nowMs = Date.now()): {
  dateLocal: string;
  todayStartUtcIso: string;
  todayEndUtcIso: string;
  todayStartMs: number;
} {
  const shifted = new Date(nowMs + SHANGHAI_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth();
  const d = shifted.getUTCDate();
  const dateLocal = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const todayStartMs = Date.UTC(y, m, d, 0, 0, 0) - SHANGHAI_OFFSET_MS;
  const todayEndMs = todayStartMs + 86400000;
  return {
    dateLocal,
    todayStartUtcIso: new Date(todayStartMs).toISOString(),
    todayEndUtcIso: new Date(todayEndMs).toISOString(),
    todayStartMs,
  };
}

function sha256(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function formatCompactCount(n: number | null | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '';
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
  return n.toLocaleString('zh-CN');
}

function safeParseStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((x) => String(x || '').trim()).filter(Boolean);
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((x) => String(x || '').trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

// 兼容抖音（views 为 null）与 B站等全平台的热度评分与可读依据生成
export function computeContentHeatScore(item: {
  latest_views?: number | null;
  latest_likes?: number | null;
  latest_comments?: number | null;
  latest_favorites?: number | null;
  latest_shares?: number | null;
  breakout_ratio?: number | null;
  breakout_score?: number | null;
}): { heatScore: number; heatBasis: string } {
  const views = typeof item.latest_views === 'number' ? item.latest_views : null;
  const likes = typeof item.latest_likes === 'number' ? item.latest_likes : null;
  const comments = typeof item.latest_comments === 'number' ? item.latest_comments : null;
  const favorites = typeof item.latest_favorites === 'number' ? item.latest_favorites : null;
  const shares = typeof item.latest_shares === 'number' ? item.latest_shares : null;

  const eng = computeEngagementScore({ views, likes, comments, favorites, shares });
  const engComponent = eng !== null && eng > 0 ? Math.log10(1 + eng) * 18 : 0;
  const ratio = typeof item.breakout_ratio === 'number' && Number.isFinite(item.breakout_ratio) ? item.breakout_ratio : null;
  const bScore = typeof item.breakout_score === 'number' && Number.isFinite(item.breakout_score) ? item.breakout_score : null;

  const ratioComponent = ratio !== null && ratio > 0 ? Math.min(40, ratio * 10) : 0;
  const scoreComponent = bScore !== null && bScore > 0 ? bScore * 0.35 : 0;
  const heatScore = Math.round((engComponent + Math.max(ratioComponent, scoreComponent)) * 10) / 10;

  const parts: string[] = [];
  if (views !== null) parts.push(`播放 ${formatCompactCount(views)}`);
  if (likes !== null) parts.push(`点赞 ${formatCompactCount(likes)}`);
  if (comments !== null) parts.push(`评论 ${formatCompactCount(comments)}`);
  if (favorites !== null) parts.push(`收藏 ${formatCompactCount(favorites)}`);
  if (shares !== null && views === null) parts.push(`转发 ${formatCompactCount(shares)}`);
  if (ratio !== null) parts.push(`爆款 ${ratio}x`);

  return {
    heatScore,
    heatBasis: parts.length > 0 ? parts.slice(0, 4).join(' · ') : '暂无互动数据',
  };
}

interface ContentForR2Row {
  id: number;
  source_id: number;
  platform: string;
  title: string;
  author: string;
  summary: string;
  body: string;
  transcript: string;
  transcript_status: string;
  published_at: string | null;
  discovered_at: string;
  breakout_score: number | null;
  breakout_ratio: number | null;
  breakout_reason: string;
  source_name: string;
  follower_count: number | null;
  latest_views: number | null;
  latest_likes: number | null;
  latest_comments: number | null;
  latest_favorites: number | null;
  latest_shares: number | null;
  comment_count: number;
  legacy_summary_zh: string | null;
}

function queryContentForR2(contentId: number): ContentForR2Row | undefined {
  const db = getDb();
  return db
    .prepare(`
      SELECT c.id, c.source_id, c.platform, c.title, c.author, c.summary, c.body,
             c.transcript, c.transcript_status, c.published_at, c.discovered_at,
             c.breakout_score, c.breakout_ratio, c.breakout_reason,
             s.name AS source_name, s.follower_count,
             (SELECT views FROM content_metrics m WHERE m.content_id = c.id ORDER BY captured_at DESC LIMIT 1) AS latest_views,
             (SELECT likes FROM content_metrics m WHERE m.content_id = c.id ORDER BY captured_at DESC LIMIT 1) AS latest_likes,
             (SELECT comments FROM content_metrics m WHERE m.content_id = c.id ORDER BY captured_at DESC LIMIT 1) AS latest_comments,
             (SELECT favorites FROM content_metrics m WHERE m.content_id = c.id ORDER BY captured_at DESC LIMIT 1) AS latest_favorites,
             (SELECT shares FROM content_metrics m WHERE m.content_id = c.id ORDER BY captured_at DESC LIMIT 1) AS latest_shares,
             (SELECT COUNT(*) FROM content_comments cm WHERE cm.content_id = c.id) AS comment_count,
             (SELECT summary_zh FROM content_analyses ca WHERE ca.content_id = c.id LIMIT 1) AS legacy_summary_zh
      FROM contents c
      JOIN sources s ON s.id = c.source_id
      WHERE c.id = ?
      LIMIT 1
    `)
    .get(contentId) as ContentForR2Row | undefined;
}

function clampRemixScore(val: unknown, fallback = 55): number {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function normalizeHeatLevel(val: unknown, fallback: R2AnalysisPayload['heatLevel']): R2AnalysisPayload['heatLevel'] {
  const s = String(val || '').trim().toLowerCase();
  if (s === 'viral' || s === 'hot' || s === 'normal' || s === 'low' || s === 'unknown') {
    return s;
  }
  return fallback;
}

function suitabilityLabelByScore(score: number): string {
  if (score >= 78) return '高度适合二创';
  if (score >= 58) return '适合二创';
  if (score >= 38) return '可借鉴切入点';
  return '谨慎二创';
}

// 当大模型不可用时，严格依据真实口播/文本和真实互动数据生成确定性分析结论（不虚构任何数字）
function buildOfflineR2Analysis(
  row: ContentForR2Row,
  basisSource: '口播全文+真实数据' | '标题简介+真实数据'
): Omit<R2AnalysisPayload, 'contentId' | 'basisSource' | 'updatedAt'> {
  const hasTranscript = basisSource === '口播全文+真实数据';
  const rawText = (hasTranscript ? row.transcript : row.summary || row.body || row.title)
    .replace(/\s+/g, ' ')
    .trim();
  const cleanSummary = (row.legacy_summary_zh || '').trim();
  const whatItSays = cleanSummary
    ? cleanSummary.slice(0, 220)
    : hasTranscript
      ? `口播核心内容围绕「${row.title.slice(0, 40)}」展开，要点：${rawText.slice(0, 140)}${rawText.length > 140 ? '...' : ''}`
      : `围绕「${row.title}」展开${rawText && rawText !== row.title ? `，简介提及：${rawText.slice(0, 120)}` : '（当前尚未抓取口播全文，基于标题简介归纳）'}`;

  const eng = computeEngagementScore({
    views: row.latest_views,
    likes: row.latest_likes,
    comments: row.latest_comments,
    favorites: row.latest_favorites,
    shares: row.latest_shares,
  });
  const ratio = typeof row.breakout_ratio === 'number' ? row.breakout_ratio : null;
  const bScore = typeof row.breakout_score === 'number' ? row.breakout_score : null;

  const metricPieces: string[] = [];
  if (row.latest_views !== null) metricPieces.push(`播放 ${formatCompactCount(row.latest_views)}`);
  if (row.latest_likes !== null) metricPieces.push(`点赞 ${formatCompactCount(row.latest_likes)}`);
  if (row.latest_comments !== null) metricPieces.push(`评论 ${formatCompactCount(row.latest_comments)}`);
  if (row.latest_favorites !== null) metricPieces.push(`收藏 ${formatCompactCount(row.latest_favorites)}`);
  if (row.latest_shares !== null) metricPieces.push(`转发 ${formatCompactCount(row.latest_shares)}`);
  const metricDesc = metricPieces.length > 0 ? metricPieces.join(' / ') : '暂无公开互动数';
  const douyinNoViewsNote = row.platform === 'douyin' && row.latest_views === null ? '（平台未公开播放量）' : '';

  let heatLevel: R2AnalysisPayload['heatLevel'] = 'unknown';
  let heatVerdict = '';
  if ((ratio !== null && ratio >= 2.5) || (bScore !== null && bScore >= 80)) {
    heatLevel = 'viral';
    heatVerdict = `显著爆款：${ratio !== null ? `综合互动达博主常态 ${ratio}x，` : ''}${metricDesc}${douyinNoViewsNote}`;
  } else if ((ratio !== null && ratio >= 1.5) || (bScore !== null && bScore >= 65)) {
    heatLevel = 'hot';
    heatVerdict = `热度偏高：${ratio !== null ? `达博主常态 ${ratio}x，` : ''}${metricDesc}${douyinNoViewsNote}`;
  } else if (eng !== null) {
    if (eng >= 3000) {
      heatLevel = 'hot';
      heatVerdict = `互动表现较强：${metricDesc}${douyinNoViewsNote}`;
    } else if (ratio !== null && ratio < 0.7) {
      heatLevel = 'low';
      heatVerdict = `低于该博主日常均线（${ratio}x）：${metricDesc}${douyinNoViewsNote}`;
    } else {
      heatLevel = 'normal';
      heatVerdict = `常态稳定表现：${metricDesc}${douyinNoViewsNote}`;
    }
  } else {
    heatLevel = 'unknown';
    heatVerdict = '暂未采集到互动快照，建议先抓取最新数据或参考评论区活跃度';
  }

  // 计算确定性二创适配分
  let score = 42;
  if (hasTranscript) score += 18;
  if (ratio !== null) {
    score += Math.min(22, Math.round(ratio * 8));
  } else if (eng !== null && eng > 0) {
    score += Math.min(18, Math.round(Math.log10(1 + eng) * 4));
  }
  if (row.comment_count > 0) score += Math.min(10, row.comment_count);
  if (rawText.length >= 120) score += 8;
  const remixScore = clampRemixScore(score, 52);
  const remixSuitability = suitabilityLabelByScore(remixScore);

  const anglePrefix = hasTranscript ? '保留核心反差观点并补充实操步骤' : '先提取口播全文确认细节，再从用户痛点切入';
  const remixAngle = `${anglePrefix}：结合「${row.title.slice(0, 32)}」提炼 3 个落地做法或避坑清单`;

  return {
    whatItSays,
    heatVerdict,
    heatLevel,
    remixSuitability,
    remixScore,
    remixAngle,
  };
}

export function mapR2RowToPayload(r: Record<string, unknown>): R2AnalysisPayload {
  return {
    contentId: Number(r.content_id),
    whatItSays: String(r.what_it_says || ''),
    heatVerdict: String(r.heat_verdict || ''),
    heatLevel: normalizeHeatLevel(r.heat_level, 'normal'),
    remixSuitability: String(r.remix_suitability || ''),
    remixScore: Number(r.remix_score || 0),
    remixAngle: String(r.remix_angle || ''),
    basisSource: r.basis_source === '口播全文+真实数据' ? '口播全文+真实数据' : '标题简介+真实数据',
    updatedAt: String(r.updated_at || ''),
  };
}

/**
 * R2：单条视频三项统一 AI 分析（讲了什么 / 火不火 / 是否适合二创及切入建议）。
 * 若已有相同 fingerprint 的分析直接复用；当口播全文提取完成后指纹变化会自动重算升级。
 */
export async function analyzeContentForR2(
  contentId: number,
  force = false
): Promise<R2AnalysisPayload | null> {
  const row = queryContentForR2(contentId);
  if (!row) return null;

  const hasTranscript = (row.transcript || '').trim().length >= 40;
  const basisSource: R2AnalysisPayload['basisSource'] = hasTranscript ? '口播全文+真实数据' : '标题简介+真实数据';
  const textBody = (hasTranscript ? row.transcript : `${row.summary || ''}\n${row.body || ''}`).trim();
  const fingerprint = sha256(
    [
      row.title,
      basisSource,
      textBody.slice(0, 1500),
      row.latest_views ?? 'null',
      row.latest_likes ?? 'null',
      row.latest_comments ?? 'null',
      row.latest_favorites ?? 'null',
      row.latest_shares ?? 'null',
      row.breakout_ratio ?? 'null',
    ].join('|')
  );

  const db = getDb();
  if (!force) {
    const cached = db
      .prepare('SELECT * FROM content_r2_analyses WHERE content_id = ? LIMIT 1')
      .get(contentId) as Record<string, unknown> | undefined;
    if (cached && String(cached.fingerprint || '') === fingerprint) {
      return mapR2RowToPayload(cached);
    }
  }

  const offlineFallback = buildOfflineR2Analysis(row, basisSource);
  let result = offlineFallback;
  let usedModel = 'offline-heuristic';

  const metricsSummary = [
    `平台: ${row.platform}`,
    `博主: ${row.source_name}${row.follower_count != null ? `（粉丝 ${row.follower_count}）` : ''}`,
    `播放量: ${row.latest_views ?? '未提供'}`,
    `点赞数: ${row.latest_likes ?? '未提供'}`,
    `评论数: ${row.latest_comments ?? '未提供'}`,
    `收藏数: ${row.latest_favorites ?? '未提供'}`,
    `转发数: ${row.latest_shares ?? '未提供'}`,
    `爆款倍数: ${row.breakout_ratio != null ? `${row.breakout_ratio}x` : '未计算'}`,
    `爆款说明: ${row.breakout_reason || '无'}`,
    `已采集评论条数: ${row.comment_count}`,
  ].join('\n');

  try {
    const aiRes = await callAiJsonWithCache<{
      whatItSays?: string;
      heatVerdict?: string;
      heatLevel?: string;
      remixSuitability?: string;
      remixScore?: number;
      remixAngle?: string;
    }>({
      purpose: 'r2_unified_analysis',
      system: `你是短视频选题拆解与二次创作策划专家。请严格基于真实文本与互动数据输出简明大白话中文分析，严禁编造任何未提供的数据。
只输出严格 JSON：
{
  "whatItSays": "1-2句大白话说明这条视频具体讲了什么核心内容与结论",
  "heatVerdict": "1-2句明确判断这条视频火不火，并直接引用真实互动指标或爆款倍数说明原因",
  "heatLevel": "viral | hot | normal | low | unknown",
  "remixSuitability": "高度适合二创 | 适合二创 | 可借鉴切入点 | 谨慎二创",
  "remixScore": 0到100的整数,
  "remixAngle": "1句具体的二次创作切入角度与可拍结构"
}`,
      user: `依据来源: ${basisSource}\n视频标题: ${row.title}\n内容文本:\n${textBody.slice(0, 3600) || row.title}\n\n真实互动数据:\n${metricsSummary}`,
      temperature: 0.25,
      maxTokens: 900,
      forceRefresh: force,
    });

    const d = aiRes.data || {};
    const remixScore = clampRemixScore(d.remixScore, offlineFallback.remixScore);
    result = {
      whatItSays: String(d.whatItSays || '').trim() || offlineFallback.whatItSays,
      heatVerdict: String(d.heatVerdict || '').trim() || offlineFallback.heatVerdict,
      heatLevel: normalizeHeatLevel(d.heatLevel, offlineFallback.heatLevel),
      remixSuitability: String(d.remixSuitability || '').trim() || suitabilityLabelByScore(remixScore),
      remixScore,
      remixAngle: String(d.remixAngle || '').trim() || offlineFallback.remixAngle,
    };
    usedModel = aiRes.model || 'ai';
  } catch {
    // 大模型未配置或超时时静默降级为基于真实指标的离线判断，绝不中断接口
  }

  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO content_r2_analyses (
      content_id, what_it_says, heat_verdict, heat_level,
      remix_suitability, remix_score, remix_angle, basis_source,
      model, fingerprint, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(content_id) DO UPDATE SET
      what_it_says = excluded.what_it_says,
      heat_verdict = excluded.heat_verdict,
      heat_level = excluded.heat_level,
      remix_suitability = excluded.remix_suitability,
      remix_score = excluded.remix_score,
      remix_angle = excluded.remix_angle,
      basis_source = excluded.basis_source,
      model = excluded.model,
      fingerprint = excluded.fingerprint,
      updated_at = excluded.updated_at
  `).run(
    contentId,
    result.whatItSays,
    result.heatVerdict,
    result.heatLevel,
    result.remixSuitability,
    result.remixScore,
    result.remixAngle,
    basisSource,
    usedModel,
    fingerprint,
    now,
    now
  );

  return {
    contentId,
    ...result,
    basisSource,
    updatedAt: now,
  };
}

/**
 * R2：横向对比多条视频，明确选出“哪个最适合进行二次创作”并给出排名与开场钩子。
 */
export async function compareContentRemixSuitability(params: {
  contentIds?: number[];
  creatorId?: number;
}): Promise<{
  ok: true;
  bestContentId: number | null;
  summary: string;
  rankings: RemixCompareItem[];
}> {
  const db = getDb();
  const baseSql = `
    SELECT c.id, c.source_id, c.platform, c.title, c.summary, c.body,
           c.transcript, c.published_at, c.discovered_at,
           c.breakout_score, c.breakout_ratio, c.breakout_reason,
           s.name AS source_name, s.follower_count,
           (SELECT views FROM content_metrics m WHERE m.content_id = c.id ORDER BY captured_at DESC LIMIT 1) AS latest_views,
           (SELECT likes FROM content_metrics m WHERE m.content_id = c.id ORDER BY captured_at DESC LIMIT 1) AS latest_likes,
           (SELECT comments FROM content_metrics m WHERE m.content_id = c.id ORDER BY captured_at DESC LIMIT 1) AS latest_comments,
           (SELECT favorites FROM content_metrics m WHERE m.content_id = c.id ORDER BY captured_at DESC LIMIT 1) AS latest_favorites,
           (SELECT shares FROM content_metrics m WHERE m.content_id = c.id ORDER BY captured_at DESC LIMIT 1) AS latest_shares,
           (SELECT COUNT(*) FROM content_comments cm WHERE cm.content_id = c.id) AS comment_count,
           (SELECT summary_zh FROM content_analyses ca WHERE ca.content_id = c.id LIMIT 1) AS legacy_summary_zh,
           r2.remix_score AS saved_remix_score,
           r2.remix_suitability AS saved_remix_suitability,
           r2.remix_angle AS saved_remix_angle
    FROM contents c
    JOIN sources s ON s.id = c.source_id
    LEFT JOIN content_r2_analyses r2 ON r2.content_id = c.id
  `;

  type CandidateRow = ContentForR2Row & {
    saved_remix_score: number | null;
    saved_remix_suitability: string | null;
    saved_remix_angle: string | null;
  };

  let rows: CandidateRow[] = [];
  const cleanIds = Array.isArray(params.contentIds)
    ? Array.from(new Set(params.contentIds.map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0))).slice(0, 12)
    : [];

  if (cleanIds.length > 0) {
    const placeholders = cleanIds.map(() => '?').join(', ');
    rows = db.prepare(`${baseSql} WHERE c.id IN (${placeholders})`).all(...cleanIds) as unknown as CandidateRow[];
  } else if (params.creatorId && Number.isInteger(params.creatorId)) {
    rows = db
      .prepare(`${baseSql} WHERE c.source_id = ? ORDER BY COALESCE(c.breakout_score, 0) DESC, COALESCE(c.published_at, c.discovered_at) DESC LIMIT 8`)
      .all(params.creatorId) as unknown as CandidateRow[];
  } else {
    rows = db
      .prepare(`${baseSql} WHERE s.source_type = 'creator' ORDER BY COALESCE(c.breakout_score, 0) DESC, COALESCE(c.published_at, c.discovered_at) DESC LIMIT 8`)
      .all() as unknown as CandidateRow[];
    if (rows.length === 0) {
      rows = db
        .prepare(`${baseSql} WHERE s.source_type != 'hot_board' ORDER BY COALESCE(c.breakout_score, 0) DESC, COALESCE(c.published_at, c.discovered_at) DESC LIMIT 8`)
        .all() as unknown as CandidateRow[];
    }
  }

  if (rows.length === 0) {
    return {
      ok: true,
      bestContentId: null,
      summary: '暂无可供对比的视频',
      rankings: [],
    };
  }

  // 先为每条候选生成确定性基准分，既可离线直接输出，也可在 LLM 返回缺漏时补齐
  const candidateMeta = new Map<number, { row: CandidateRow; fallback: RemixCompareItem }>();
  for (const row of rows) {
    const hasTranscript = (row.transcript || '').trim().length >= 40;
    const basisSource: R2AnalysisPayload['basisSource'] = hasTranscript ? '口播全文+真实数据' : '标题简介+真实数据';
    const offline = buildOfflineR2Analysis(row, basisSource);
    const score = row.saved_remix_score != null ? clampRemixScore(row.saved_remix_score, offline.remixScore) : offline.remixScore;
    const { heatBasis } = computeContentHeatScore(row);
    const reasonParts = [
      hasTranscript ? '已获取口播全文可直接拆解结构' : '仅基于标题简介评估',
      heatBasis !== '暂无互动数据' ? `真实互动：${heatBasis}` : '暂无互动数据',
    ];
    candidateMeta.set(row.id, {
      row,
      fallback: {
        contentId: row.id,
        title: row.title,
        rank: 0,
        remixScore: score,
        verdict: row.saved_remix_suitability || offline.remixSuitability,
        reason: reasonParts.join('；'),
        suggestedHook: `「${row.title.slice(0, 26)}」这事其实大多数人做反了，今天给你拆 3 步实操...`,
      },
    });
  }

  let summary = '';
  const merged = new Map<number, RemixCompareItem>();

  try {
    const account = getActiveAccount();
    const promptItems = rows.map((r) => {
      const hasTranscript = (r.transcript || '').trim().length >= 40;
      const { heatScore, heatBasis } = computeContentHeatScore(r);
      return {
        contentId: r.id,
        title: r.title,
        creator: r.source_name,
        platform: r.platform,
        hasTranscript,
        transcriptSnippet: hasTranscript ? r.transcript.slice(0, 500) : r.summary.slice(0, 240),
        heatScore,
        heatBasis,
        savedR2Score: r.saved_remix_score,
      };
    });

    const aiRes = await callAiJsonWithCache<{
      bestContentId?: number;
      summary?: string;
      rankings?: Array<{
        contentId?: number;
        remixScore?: number;
        verdict?: string;
        reason?: string;
        suggestedHook?: string;
      }>;
    }>({
      purpose: 'r2_compare_remix',
      system: `你是自媒体二创选品总监。请结合我方账号定位，对候选视频进行横向对比，选出最适合二次创作的视频并排出先后顺序。
严格要求：
1. 只能使用输入里提供的真实 contentId，禁止编造新 ID。
2. 必须综合口播文案是否就绪、真实互动表现、以及普通创作者可复刻性。
3. 只输出严格 JSON：
{
  "bestContentId": 候选ID整数,
  "summary": "2句大白话总结为什么第一名最值得二创",
  "rankings": [
    { "contentId": 候选ID整数, "remixScore": 0-100整数, "verdict": "最推荐二创 | 适合二创 | 备选参考 | 不建议", "reason": "具体依据", "suggestedHook": "建议开头第一句话" }
  ]
}`,
      user: `我方账号定位：${account.niche}（擅长：${account.personal_expertise}）\n\n候选视频列表：\n${JSON.stringify(promptItems, null, 2)}`,
      temperature: 0.25,
      maxTokens: 1300,
    });

    const d = aiRes.data || {};
    summary = String(d.summary || '').trim();
    if (Array.isArray(d.rankings)) {
      for (const item of d.rankings) {
        const cid = Number(item.contentId);
        const meta = candidateMeta.get(cid);
        if (!meta || merged.has(cid)) continue;
        const score = clampRemixScore(item.remixScore, meta.fallback.remixScore);
        merged.set(cid, {
          contentId: cid,
          title: meta.row.title,
          rank: 0,
          remixScore: score,
          verdict: String(item.verdict || '').trim() || suitabilityLabelByScore(score),
          reason: String(item.reason || '').trim() || meta.fallback.reason,
          suggestedHook: String(item.suggestedHook || '').trim() || meta.fallback.suggestedHook,
        });
      }
    }
  } catch {
    // LLM 不可用时使用下方确定性排序补齐
  }

  // 补全任何未被大模型列出的真实候选，确保不丢项、不幻觉
  for (const [cid, meta] of candidateMeta.entries()) {
    if (!merged.has(cid)) {
      merged.set(cid, meta.fallback);
    }
  }

  const sorted = Array.from(merged.values()).sort((a, b) => {
    if (b.remixScore !== a.remixScore) return b.remixScore - a.remixScore;
    const aRow = candidateMeta.get(a.contentId)!.row;
    const bRow = candidateMeta.get(b.contentId)!.row;
    const aHas = (aRow.transcript || '').trim().length >= 40 ? 1 : 0;
    const bHas = (bRow.transcript || '').trim().length >= 40 ? 1 : 0;
    if (bHas !== aHas) return bHas - aHas;
    return Number(bRow.breakout_score || 0) - Number(aRow.breakout_score || 0);
  });

  const rankings: RemixCompareItem[] = sorted.map((item, idx) => ({
    ...item,
    rank: idx + 1,
    verdict: idx === 0 && item.remixScore >= 55 ? '最推荐二创' : item.verdict,
  }));

  const best = rankings[0] || null;
  if (!summary && best) {
    summary = `推荐优先二创「${best.title.slice(0, 32)}」（二创分 ${best.remixScore}），原因：${best.reason}`;
  }

  return {
    ok: true,
    bestContentId: best ? best.contentId : null,
    summary,
    rankings,
  };
}

interface RealCommentRow {
  id: number;
  author: string;
  text: string;
  likes: number | null;
  published_at: string | null;
}

function mapTopicRow(r: Record<string, unknown>): CommentTopicIdeaItem {
  return {
    id: Number(r.id),
    topic: String(r.topic || ''),
    heatNote: String(r.heat_note || ''),
    evidenceComments: safeParseStringArray(r.evidence_comments_json),
    creationIdeaTitle: String(r.creation_idea_title || ''),
    creationAngle: String(r.creation_angle || ''),
    savedBoardId: r.saved_board_id != null ? Number(r.saved_board_id) : null,
  };
}

export function getContentCommentTopics(contentId: number): CommentTopicIdeaItem[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM comment_topic_ideas WHERE content_id = ? ORDER BY id ASC')
    .all(contentId) as Array<Record<string, unknown>>;
  return rows.map(mapTopicRow);
}

// 批量查询一批视频已提炼好的评论区选题，用于对标博主列表页直接展示
export function getCommentTopicsMapForContents(contentIds: number[]): Record<string, CommentTopicIdeaItem[]> {
  const cleanIds = Array.from(new Set(contentIds.filter((id) => Number.isInteger(id) && id > 0)));
  if (cleanIds.length === 0) return {};
  const db = getDb();
  const placeholders = cleanIds.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT * FROM comment_topic_ideas WHERE content_id IN (${placeholders}) ORDER BY content_id ASC, id ASC`)
    .all(...cleanIds) as Array<Record<string, unknown>>;
  const map: Record<string, CommentTopicIdeaItem[]> = {};
  for (const row of rows) {
    const key = String(row.content_id);
    if (!map[key]) map[key] = [];
    map[key].push(mapTopicRow(row));
  }
  return map;
}

// 校验每条引用评论必须真实存在于 content_comments（子串或 >=6 字重叠），防止大模型编造假评论
function groundEvidenceComments(rawEvidence: unknown, realComments: RealCommentRow[]): string[] {
  const candidates = Array.isArray(rawEvidence) ? rawEvidence.map((x) => String(x || '').trim()).filter(Boolean) : [];
  const realTexts = realComments.map((c) => c.text.trim()).filter(Boolean);
  const grounded: string[] = [];

  for (const ev of candidates) {
    const cleanEv = ev.replace(/^["'「『]+|["'」』]+$/g, '').trim();
    if (!cleanEv) continue;
    const matched = realTexts.find((rt) => {
      if (rt.includes(cleanEv) || cleanEv.includes(rt)) return true;
      const probe = cleanEv.slice(0, Math.min(8, cleanEv.length));
      return probe.length >= 6 && rt.includes(probe);
    });
    if (matched) {
      grounded.push(matched.slice(0, 140));
    }
    if (grounded.length >= 3) break;
  }

  if (grounded.length === 0 && realTexts.length > 0) {
    return realTexts.slice(0, 2).map((t) => t.slice(0, 140));
  }
  return Array.from(new Set(grounded));
}

// 当大模型不可用时，直接基于高赞或提问型真实评论提炼话题与选题方向
function buildOfflineCommentTopics(
  contentTitle: string,
  realComments: RealCommentRow[]
): Array<Omit<CommentTopicIdeaItem, 'id' | 'savedBoardId'>> {
  const questionOrHot = [...realComments].sort((a, b) => {
    const aQ = /[？?怎么如何为什么多少哪里能不能是不是]/.test(a.text) ? 1 : 0;
    const bQ = /[？?怎么如何为什么多少哪里能不能是不是]/.test(b.text) ? 1 : 0;
    const aScore = Number(a.likes || 0) + aQ * 50;
    const bScore = Number(b.likes || 0) + bQ * 50;
    return bScore - aScore;
  });

  const picked = questionOrHot.slice(0, Math.min(3, questionOrHot.length));
  return picked.map((cm, idx) => {
    const cleanText = cm.text.replace(/\s+/g, ' ').trim();
    const isQuestion = /[？?怎么如何为什么多少哪里能不能是不是]/.test(cleanText);
    const shortFocus = cleanText.slice(0, 18).replace(/[，。！？?!]+$/g, '');
    const topic = isQuestion ? `观众追问：${shortFocus}` : `热评焦点 #${idx + 1}：${shortFocus}`;
    const likesNote = typeof cm.likes === 'number' && cm.likes > 0 ? `获赞 ${cm.likes}` : '真实评论反馈';
    return {
      topic,
      heatNote: `${likesNote}${isQuestion ? ' · 明确痛点提问' : ' · 评论区高频共鸣'}`,
      evidenceComments: [cleanText.slice(0, 140)],
      creationIdeaTitle: isQuestion
        ? `回应观众疑问：${shortFocus}（结合「${contentTitle.slice(0, 16)}」实测）`
        : `顺着热评深挖：${shortFocus} 背后的真实门道`,
      creationAngle: `直接拿评论区原话「${cleanText.slice(0, 36)}」当视频前 3 秒钩子，正面解答并给出实操结论。`,
    };
  });
}

/**
 * R4：从真实评论区提炼观众讨论热门话题，并直接转化为可存入选题库的创作选题。
 * 严格零虚构红线：若真实评论条数为 0，直接返回空话题列表，绝不编造任何评论或话题。
 */
export async function extractCommentTopicsAndIdeas(
  contentId: number,
  opts: { autoCrawl?: boolean; force?: boolean } = {}
): Promise<{
  ok: true;
  contentId: number;
  commentsCount: number;
  topics: CommentTopicIdeaItem[];
  message?: string;
} | null> {
  const db = getDb();
  const content = db
    .prepare('SELECT id, title, platform, canonical_url FROM contents WHERE id = ? LIMIT 1')
    .get(contentId) as { id: number; title: string; platform: string; canonical_url: string } | undefined;
  if (!content) return null;

  const queryComments = () => {
    const totalRow = db
      .prepare('SELECT COUNT(*) AS c FROM content_comments WHERE content_id = ?')
      .get(contentId) as { c: number };
    const rows = db
      .prepare('SELECT id, author, text, likes, published_at FROM content_comments WHERE content_id = ? ORDER BY COALESCE(likes, 0) DESC, id ASC LIMIT 50')
      .all(contentId) as unknown as RealCommentRow[];
    return { total: Number(totalRow.c || 0), rows };
  };

  let { total, rows: realComments } = queryComments();
  let crawlMessage: string | undefined;
  let crawledNow = false;
  // 若尚无评论，或用户主动重扒且之前仅抓到极少量（如旧 B站接口限流 3 条），自动重抓一次热评
  if (opts.autoCrawl === true && (total === 0 || (opts.force === true && total < 10))) {
    try {
      const crawlRes = await fetchCommentsWithMediaCrawler(contentId);
      crawledNow = true;
      if (!crawlRes.ok && crawlRes.message) {
        crawlMessage = crawlRes.message;
      }
    } catch (err) {
      crawlMessage = (err as Error).message;
    }
    const after = queryComments();
    total = after.total;
    realComments = after.rows;
  }

  // 零评论红线：绝不编造虚假评论或脱离评论的话题
  if (total === 0 || realComments.length === 0) {
    return {
      ok: true,
      contentId,
      commentsCount: 0,
      topics: [],
      message: crawlMessage || '暂无已采集的真实评论，请先抓取真实评论后再提炼话题',
    };
  }

  if (!opts.force && !crawledNow) {
    const existing = db
      .prepare('SELECT * FROM comment_topic_ideas WHERE content_id = ? ORDER BY id ASC')
      .all(contentId) as Array<Record<string, unknown>>;
    if (existing.length > 0 && Number(existing[0].comments_snapshot_count || 0) === total) {
      return {
        ok: true,
        contentId,
        commentsCount: total,
        topics: existing.map(mapTopicRow),
      };
    }
  }

  let extracted: Array<Omit<CommentTopicIdeaItem, 'id' | 'savedBoardId'>> = [];
  const numberedComments = realComments
    .map((cm, idx) => `#${idx + 1} [👍${cm.likes ?? 0}] ${cm.text.replace(/\s+/g, ' ').trim().slice(0, 220)}`)
    .join('\n');

  try {
    const aiRes = await callAiJsonWithCache<{
      topics?: Array<{
        topic?: string;
        heatNote?: string;
        evidenceComments?: string[];
        creationIdeaTitle?: string;
        creationAngle?: string;
      }>;
    }>({
      purpose: 'comment_topics_to_ideas',
      system: `你是擅长从评论区挖爆款选题的内容策划。请严格基于提供的真实评论列表提炼 2~5 个观众正在讨论的热门话题，并转成可拍视频的创作选题。
严格规则：
1. evidenceComments 必须原封不动摘自输入评论原文，禁止编造任何新评论。
2. 只输出严格 JSON：
{
  "topics": [
    {
      "topic": "4-14字具体讨论话题",
      "heatNote": "简述热度表现（如多人追问、高赞共鸣）",
      "evidenceComments": ["真实评论原文1", "真实评论原文2"],
      "creationIdeaTitle": "可直接拍视频的选题标题",
      "creationAngle": "1-2句具体切入角度与解答思路"
    }
  ]
}`,
      user: `原视频标题：${content.title}\n真实评论总数：${total}（展示前 ${realComments.length} 条高赞/精选）：\n${numberedComments}`,
      temperature: 0.3,
      maxTokens: 1300,
      forceRefresh: Boolean(opts.force),
    });

    if (Array.isArray(aiRes.data?.topics)) {
      const seenTopics = new Set<string>();
      for (const t of aiRes.data.topics) {
        const topic = String(t.topic || '').trim().slice(0, 80);
        if (!topic || seenTopics.has(topic)) continue;
        seenTopics.add(topic);
        const evidenceComments = groundEvidenceComments(t.evidenceComments, realComments);
        extracted.push({
          topic,
          heatNote: String(t.heatNote || '').trim() || '评论区高频讨论',
          evidenceComments,
          creationIdeaTitle: String(t.creationIdeaTitle || '').trim() || `围绕「${topic}」做一期实测拆解`,
          creationAngle: String(t.creationAngle || '').trim() || `针对评论区关心的「${topic}」正面给出实操答案`,
        });
        if (extracted.length >= 5) break;
      }
    }
  } catch {
    // LLM 不可用时走下方确定性真实评论提炼兜底
  }

  if (extracted.length === 0) {
    extracted = buildOfflineCommentTopics(content.title, realComments);
  }

  // 保留此前已存入选题库的 saved_board_id 关联，避免重新提炼时丢失绑定
  const prevBoardRows = db
    .prepare('SELECT topic, creation_idea_title, saved_board_id FROM comment_topic_ideas WHERE content_id = ? AND saved_board_id IS NOT NULL')
    .all(contentId) as Array<{ topic: string; creation_idea_title: string; saved_board_id: number }>;
  const savedMap = new Map<string, number>();
  for (const pr of prevBoardRows) {
    savedMap.set(pr.topic.trim(), pr.saved_board_id);
    if (pr.creation_idea_title.trim()) savedMap.set(pr.creation_idea_title.trim(), pr.saved_board_id);
  }

  const now = new Date().toISOString();
  db.exec('BEGIN;');
  try {
    db.prepare('DELETE FROM comment_topic_ideas WHERE content_id = ?').run(contentId);
    const ins = db.prepare(`
      INSERT INTO comment_topic_ideas (
        content_id, topic, heat_note, evidence_comments_json,
        creation_idea_title, creation_angle, comments_snapshot_count,
        saved_board_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of extracted) {
      const preservedBoardId =
        savedMap.get(item.topic.trim()) ?? savedMap.get(item.creationIdeaTitle.trim()) ?? null;
      ins.run(
        contentId,
        item.topic,
        item.heatNote,
        JSON.stringify(item.evidenceComments),
        item.creationIdeaTitle,
        item.creationAngle,
        total,
        preservedBoardId,
        now,
        now
      );
    }
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return {
    ok: true,
    contentId,
    commentsCount: total,
    topics: getContentCommentTopics(contentId),
  };
}

/**
 * R4：将评论区提炼出的一条话题选题幂等存入个人选题库 `topic_board`。
 */
export function saveCommentTopicToBoard(topicId: number): {
  ok: true;
  topicId: number;
  boardItem: Record<string, unknown>;
} | null {
  const db = getDb();
  const idea = db
    .prepare('SELECT * FROM comment_topic_ideas WHERE id = ? LIMIT 1')
    .get(topicId) as Record<string, unknown> | undefined;
  if (!idea) return null;

  // 幂等保护：若已关联有效选题库记录，直接返回既有记录不重复插入
  if (idea.saved_board_id != null) {
    const existingBoard = db
      .prepare('SELECT * FROM topic_board WHERE id = ? LIMIT 1')
      .get(Number(idea.saved_board_id)) as Record<string, unknown> | undefined;
    if (existingBoard) {
      return { ok: true, topicId, boardItem: existingBoard };
    }
  }

  const contentId = Number(idea.content_id);
  const content = db
    .prepare('SELECT id, title, platform, canonical_url, cluster_id FROM contents WHERE id = ? LIMIT 1')
    .get(contentId) as
    | { id: number; title: string; platform: string; canonical_url: string; cluster_id: number | null }
    | undefined;

  let accountId: number | null = null;
  try {
    accountId = getActiveAccount().id;
  } catch {
    accountId = null;
  }

  const evidence = safeParseStringArray(idea.evidence_comments_json);
  const title = (String(idea.creation_idea_title || '').trim() || String(idea.topic || '').trim()).slice(0, 160);
  const coreAngle = (String(idea.creation_angle || '').trim() || String(idea.topic || '').trim()).slice(0, 600);
  const notesLines = [
    `来源讨论话题：${String(idea.topic || '')}`,
    idea.heat_note ? `讨论热度：${String(idea.heat_note)}` : '',
    content?.title ? `原视频：${content.title}` : '',
    evidence.length > 0 ? `代表评论：\n${evidence.map((e) => `- ${e}`).join('\n')}` : '',
  ].filter(Boolean);

  const now = new Date().toISOString();
  const res = db
    .prepare(`
      INSERT INTO topic_board (
        account_id, source_content_id, cluster_id, title, core_angle,
        tags_json, notes, priority, status, source_url, reference_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'medium', 'to_research', ?, ?, ?, ?)
    `)
    .run(
      accountId,
      contentId,
      content?.cluster_id ?? null,
      title,
      coreAngle,
      JSON.stringify(['评论话题', content?.platform || 'video'].filter(Boolean)),
      notesLines.join('\n'),
      content?.canonical_url || '',
      JSON.stringify(evidence),
      now,
      now
    );

  const boardId = Number(res.lastInsertRowid);
  db.prepare('UPDATE comment_topic_ideas SET saved_board_id = ?, updated_at = ? WHERE id = ?').run(boardId, now, topicId);

  const boardItem = db.prepare('SELECT * FROM topic_board WHERE id = ?').get(boardId) as Record<string, unknown>;
  return { ok: true, topicId, boardItem };
}
