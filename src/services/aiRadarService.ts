import crypto from 'node:crypto';
import fs from 'node:fs';
import { PATHS } from '../config.js';
import { getDb } from '../db/database.js';
import { log } from '../utils/logger.js';

export interface CreatorAccountRow {
  id: number;
  name: string;
  platform_focus: string;
  niche: string;
  target_audience: string;
  content_direction: string;
  personal_expertise: string;
  style_preferences: string;
  is_active: number;
  weight_match: number;
  weight_heat: number;
  weight_diff: number;
  weight_experience: number;
  weight_timeliness: number;
  weight_feasibility: number;
  created_at: string;
  updated_at: string;
}

interface AiRuntimeConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  keySource: 'settings' | 'env' | 'local-8317' | 'missing';
}

// 从本机可选中转配置安全读取密钥（仅在后端内存使用，绝不打印或返回给前端）
function readLocal8317Key(): string {
  try {
    if (!PATHS.defaultCliProxyConfig || !fs.existsSync(PATHS.defaultCliProxyConfig)) return '';
    const text = fs.readFileSync(PATHS.defaultCliProxyConfig, 'utf8');
    let inKeys = false;
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.startsWith('api-keys:')) {
        inKeys = true;
        continue;
      }
      if (inKeys) {
        if (line.startsWith('-')) {
          const val = line.slice(1).trim().replace(/^["']|["']$/g, '');
          if (val) return val;
        } else if (line && !line.startsWith('#')) {
          inKeys = false;
        }
      }
    }
  } catch {
    // ignore
  }
  return '';
}

export function getAiRuntimeConfig(): AiRuntimeConfig {
  const db = getDb();
  const rows = db
    .prepare("SELECT key, value FROM app_settings WHERE key IN ('ai_base_url', 'ai_model', 'ai_api_key')")
    .all() as Array<{ key: string; value: string }>;
  const map: Record<string, string> = {};
  for (const r of rows) map[r.key] = r.value;

  const envUrl = (process.env.AI_BASE_URL || '').trim();
  const envModel = (process.env.AI_MODEL || '').trim();
  const envKey = (process.env.AI_API_KEY || '').trim();

  const baseUrl = (map.ai_base_url || envUrl || 'http://127.0.0.1:8317/v1').trim().replace(/\/+$/, '');
  const model = (map.ai_model || envModel || 'grok-4.20-0309-non-reasoning').trim();
  const customKey = (map.ai_api_key || '').trim();
  if (customKey) {
    return { baseUrl, model, apiKey: customKey, keySource: 'settings' };
  }
  if (envKey) {
    return { baseUrl, model, apiKey: envKey, keySource: 'env' };
  }
  const localKey = readLocal8317Key();
  if (localKey) {
    return { baseUrl, model, apiKey: localKey, keySource: 'local-8317' };
  }
  return { baseUrl, model, apiKey: '', keySource: 'missing' };
}

export function getAiHealthSummary() {
  const cfg = getAiRuntimeConfig();
  const db = getDb();
  const totalReceipts = (db.prepare('SELECT COUNT(*) AS c FROM ai_receipts').get() as { c: number }).c;
  const okReceipts = (db.prepare("SELECT COUNT(*) AS c FROM ai_receipts WHERE status = 'ok'").get() as { c: number }).c;
  const analyzedCount = (db.prepare('SELECT COUNT(*) AS c FROM content_analyses').get() as { c: number }).c;
  const recCount = (db.prepare('SELECT COUNT(*) AS c FROM topic_recommendations').get() as { c: number }).c;
  return {
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    configured: cfg.keySource !== 'missing',
    keySource: cfg.keySource,
    totalReceipts,
    okReceipts,
    analyzedCount,
    recCount,
  };
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function extractJsonObject(raw: string): Record<string, unknown> {
  let t = raw.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('模型未返回有效 JSON 对象');
  }
  const snippet = t.slice(start, end + 1);
  return JSON.parse(snippet) as Record<string, unknown>;
}

/**
 * 带防重复扣费缓存的 AI JSON 调用封装（借鉴 AIHOT receipts 机制）。
 * 同一 purpose + model + inputHash 已成功执行过的直接返回本地缓存。
 */
export async function callAiJsonWithCache<T = Record<string, unknown>>(params: {
  purpose: string;
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  forceRefresh?: boolean;
}): Promise<{ data: T; cached: boolean; model: string }> {
  const cfg = getAiRuntimeConfig();
  if (!cfg.apiKey) {
    throw new Error('未检测到可用大模型 API Key（请确认本机 8317 中转运行正常或在系统设置填入 Key）');
  }

  const inputHash = sha256(`${params.system}\n---\n${params.user}`);
  const cacheKey = `${params.purpose}:${cfg.model}:${inputHash}`;
  const db = getDb();

  if (!params.forceRefresh) {
    const hit = db
      .prepare("SELECT response_json, model FROM ai_receipts WHERE cache_key = ? AND status = 'ok' LIMIT 1")
      .get(cacheKey) as { response_json: string; model: string } | undefined;
    if (hit) {
      try {
        return { data: JSON.parse(hit.response_json) as T, cached: true, model: hit.model };
      } catch {
        // 缓存损坏时重跑
      }
    }
  }

  const t0 = Date.now();
  const body = {
    model: cfg.model,
    messages: [
      { role: 'system', content: params.system },
      { role: 'user', content: params.user },
    ],
    temperature: params.temperature ?? 0.2,
    max_tokens: params.maxTokens ?? 1800,
    response_format: { type: 'json_object' },
  };

  let parsed: Record<string, unknown>;
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;

  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90000),
    });
    const rawText = await res.text();
    if (!res.ok) {
      throw new Error(`大模型接口返回 HTTP ${res.status}: ${rawText.slice(0, 220)}`);
    }
    const json = JSON.parse(rawText) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = json.choices?.[0]?.message?.content || '';
    parsed = extractJsonObject(content);
    promptTokens = json.usage?.prompt_tokens ?? null;
    completionTokens = json.usage?.completion_tokens ?? null;

    const latencyMs = Date.now() - t0;
    db.prepare(`
      INSERT INTO ai_receipts (cache_key, purpose, model, input_hash, status, response_json, prompt_tokens, completion_tokens, latency_ms, error_message, created_at)
      VALUES (?, ?, ?, ?, 'ok', ?, ?, ?, ?, NULL, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        status = 'ok',
        response_json = excluded.response_json,
        prompt_tokens = excluded.prompt_tokens,
        completion_tokens = excluded.completion_tokens,
        latency_ms = excluded.latency_ms,
        error_message = NULL,
        created_at = excluded.created_at
    `).run(cacheKey, params.purpose, cfg.model, inputHash, JSON.stringify(parsed), promptTokens, completionTokens, latencyMs, new Date().toISOString());

    return { data: parsed as T, cached: false, model: cfg.model };
  } catch (err) {
    const latencyMs = Date.now() - t0;
    const msg = (err as Error).message;
    db.prepare(`
      INSERT INTO ai_receipts (cache_key, purpose, model, input_hash, status, response_json, latency_ms, error_message, created_at)
      VALUES (?, ?, ?, ?, 'error', '{}', ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET status = 'error', error_message = excluded.error_message, created_at = excluded.created_at
    `).run(cacheKey, params.purpose, cfg.model, inputHash, latencyMs, msg.slice(0, 400), new Date().toISOString());
    throw err;
  }
}

export function getActiveAccount(accountId?: number): CreatorAccountRow {
  const db = getDb();
  let row: CreatorAccountRow | undefined;
  if (accountId) {
    row = db.prepare('SELECT * FROM creator_accounts WHERE id = ?').get(accountId) as CreatorAccountRow | undefined;
  }
  if (!row) {
    row = db.prepare('SELECT * FROM creator_accounts ORDER BY is_active DESC, id ASC LIMIT 1').get() as CreatorAccountRow | undefined;
  }
  if (!row) {
    throw new Error('请先创建至少一个自媒体账号定位配置');
  }
  return row;
}

function asStringArray(v: unknown, max = 6): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x || '').trim()).filter(Boolean).slice(0, max);
}

function clampScore(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 50;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function formatMetricsForPrompt(row: {
  views?: number | null;
  likes?: number | null;
  comments?: number | null;
  favorites?: number | null;
  shares?: number | null;
  follower_count?: number | null;
  breakout_ratio?: number | null;
  growth_rate_per_hour?: number | null;
  breakout_reason?: string;
}): string {
  const lines = [
    `播放量: ${row.views != null ? row.views : '未提供'}`,
    `点赞数: ${row.likes != null ? row.likes : '未提供'}`,
    `评论数: ${row.comments != null ? row.comments : '未提供'}`,
    `收藏数: ${row.favorites != null ? row.favorites : '未提供'}`,
    `转发数: ${row.shares != null ? row.shares : '未提供'}`,
    `博主粉丝数: ${row.follower_count != null ? row.follower_count : '未提供'}`,
    `异常爆款倍数: ${row.breakout_ratio != null ? `${row.breakout_ratio}x` : '未计算/基线不足'}`,
    `每小时互动增速: ${row.growth_rate_per_hour != null ? `+${row.growth_rate_per_hour}/小时` : '暂无多次快照'}`,
    `爆款基线说明: ${row.breakout_reason || '无'}`,
  ];
  return lines.join('\n');
}

/**
 * 1. 单条内容 AI 深度分析（分类、摘要、核心观点、受众需求、评论痛点、差异化切入角度、趋势判断）
 */
export async function analyzeContentDeep(contentId: number, forceRefresh = false): Promise<{
  contentId: number;
  cached: boolean;
  analysis: Record<string, unknown>;
}> {
  const db = getDb();
  const row = db
    .prepare(`
      SELECT c.*, s.name AS source_name, s.follower_count,
        (SELECT views FROM content_metrics m WHERE m.content_id = c.id ORDER BY captured_at DESC LIMIT 1) AS latest_views,
        (SELECT likes FROM content_metrics m WHERE m.content_id = c.id ORDER BY captured_at DESC LIMIT 1) AS latest_likes,
        (SELECT comments FROM content_metrics m WHERE m.content_id = c.id ORDER BY captured_at DESC LIMIT 1) AS latest_comments,
        (SELECT favorites FROM content_metrics m WHERE m.content_id = c.id ORDER BY captured_at DESC LIMIT 1) AS latest_favorites,
        (SELECT shares FROM content_metrics m WHERE m.content_id = c.id ORDER BY captured_at DESC LIMIT 1) AS latest_shares
      FROM contents c
      JOIN sources s ON s.id = c.source_id
      WHERE c.id = ?
    `)
    .get(contentId) as Record<string, unknown> | undefined;

  if (!row) throw new Error('内容不存在');

  const comments = db
    .prepare('SELECT author, text, likes FROM content_comments WHERE content_id = ? ORDER BY COALESCE(likes, 0) DESC LIMIT 20')
    .all(contentId) as Array<{ author: string; text: string; likes: number | null }>;

  const textBody = String(row.transcript || row.body || row.summary || '').slice(0, 4500);
  const fingerprint = sha256(
    `${row.title}|${textBody.slice(0, 1200)}|comments:${comments.length}|v:${row.latest_views}|l:${row.latest_likes}`
  );

  if (!forceRefresh) {
    const existing = db
      .prepare('SELECT * FROM content_analyses WHERE content_id = ? AND content_fingerprint = ?')
      .get(contentId, fingerprint) as Record<string, unknown> | undefined;
    if (existing) {
      return { contentId, cached: true, analysis: existing };
    }
  }

  const metricsBlock = formatMetricsForPrompt({
    views: row.latest_views as number | null,
    likes: row.latest_likes as number | null,
    comments: row.latest_comments as number | null,
    favorites: row.latest_favorites as number | null,
    shares: row.latest_shares as number | null,
    follower_count: row.follower_count as number | null,
    breakout_ratio: row.breakout_ratio as number | null,
    growth_rate_per_hour: row.growth_rate_per_hour as number | null,
    breakout_reason: String(row.breakout_reason || ''),
  });

  const commentsBlock =
    comments.length > 0
      ? comments.map((c, i) => `${i + 1}. [${c.likes ?? 0}赞] ${c.text.slice(0, 140)}`).join('\n')
      : '（尚未采集评论区数据——请严禁凭空编造评论区痛点，在 comment_pain_points 返回空数组并说明未采评论）';

  const system = `你是资深自媒体选题编辑部的内容分析师。
必须严格遵守“不编造数据”红线：
1. 所有热度、互动和评论分析只能引用用户给出的真实数据；标记为“未提供”或“未采集”的字段严禁杜撰数字或假装读过全文/评论。
2. 全部输出简洁大白话中文，输出严格 JSON 对象，包含以下键：
{
  "category": "2-6字内容分类，如 AI工具/行业热点/干货教程/产品评测/商业洞察/农业技术",
  "summary_zh": "80-160字直奔重点的中文摘要，说清讲了什么和核心结论",
  "core_points": ["核心观点1", "核心观点2", "核心观点3"],
  "audience_needs": ["受众底层需求或痛点1", "受众需求2"],
  "comment_pain_points": ["仅当提供了真实评论时提取评论区高频追问/争议；无评论返回空数组"],
  "diff_angles": ["可供二次创作的差异化切入角度1", "差异化切入角度2"],
  "trend_judgement": "一句话判断该内容处于萌芽上升/爆发高峰/常规信息/长青干货哪一阶段及依据",
  "content_form_advice": "建议的创作形式（如60秒口播痛点/3分钟实操演示/图文避坑清单）",
  "evidence_note": "说明本次分析基于哪些真实材料（如：仅标题与简介 / 含通义听悟口播全文 / 含20条高赞评论）"
}`;

  const user = `平台: ${row.platform}
来源/博主: ${row.source_name}（作者: ${row.author || row.source_name}）
发布时间: ${row.published_at || row.discovered_at}
内容类型: ${row.content_type}
是否含口播转写稿: ${row.transcript ? `是（${String(row.transcript).length}字）` : '否'}
标题: ${row.title}

正文/简介/口播文字:
${textBody || '（仅有标题，无额外正文）'}

真实互动数据:
${metricsBlock}

真实高赞评论:
${commentsBlock}`;

  const { data, cached, model } = await callAiJsonWithCache<Record<string, unknown>>({
    purpose: 'content_deep_analysis',
    system,
    user,
    forceRefresh,
  });

  const now = new Date().toISOString();
  const category = String(data.category || '行业动态').slice(0, 40);
  const summaryZh = String(data.summary_zh || row.summary || row.title).slice(0, 800);
  const corePoints = asStringArray(data.core_points, 5);
  const audienceNeeds = asStringArray(data.audience_needs, 5);
  const commentPainPoints = comments.length > 0 ? asStringArray(data.comment_pain_points, 5) : [];
  const diffAngles = asStringArray(data.diff_angles, 4);
  const trendJudgement = String(data.trend_judgement || '').slice(0, 300);
  const contentFormAdvice = String(data.content_form_advice || '').slice(0, 200);
  const evidenceNote =
    String(data.evidence_note || '').slice(0, 300) ||
    `基于${row.transcript ? '听悟口播全文' : textBody.length > 80 ? '标题与正文/简介' : '仅标题'}${comments.length > 0 ? `+${comments.length}条评论` : '（未采评论）'}`;

  db.prepare(`
    INSERT INTO content_analyses (
      content_id, model, content_fingerprint, category, summary_zh,
      core_points_json, audience_needs_json, comment_pain_points_json, diff_angles_json,
      trend_judgement, content_form_advice, evidence_note, analyzed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(content_id) DO UPDATE SET
      model = excluded.model,
      content_fingerprint = excluded.content_fingerprint,
      category = excluded.category,
      summary_zh = excluded.summary_zh,
      core_points_json = excluded.core_points_json,
      audience_needs_json = excluded.audience_needs_json,
      comment_pain_points_json = excluded.comment_pain_points_json,
      diff_angles_json = excluded.diff_angles_json,
      trend_judgement = excluded.trend_judgement,
      content_form_advice = excluded.content_form_advice,
      evidence_note = excluded.evidence_note,
      analyzed_at = excluded.analyzed_at
  `).run(
    contentId,
    model,
    fingerprint,
    category,
    summaryZh,
    JSON.stringify(corePoints),
    JSON.stringify(audienceNeeds),
    JSON.stringify(commentPainPoints),
    JSON.stringify(diffAngles),
    trendJudgement,
    contentFormAdvice,
    evidenceNote,
    now
  );

  const saved = db.prepare('SELECT * FROM content_analyses WHERE content_id = ?').get(contentId) as Record<string, unknown>;
  return { contentId, cached, analysis: saved };
}

/**
 * 2. 6 维自定义权重智能选题推荐（结合账号定位 + 反馈偏好 + 历史选题查重 + 真实热度证据）
 */
export async function generateRecommendationForContent(
  contentId: number,
  accountId?: number,
  forceRefresh = false
): Promise<{ recommendation: Record<string, unknown>; cached: boolean }> {
  const db = getDb();
  const account = getActiveAccount(accountId);

  // 确保内容已完成基础 AI 深度分析（命中缓存则零额外调用）
  await analyzeContentDeep(contentId, false);

  const row = db
    .prepare(`
      SELECT c.*, s.name AS source_name, s.follower_count,
        a.category AS ai_category, a.summary_zh, a.core_points_json, a.audience_needs_json,
        a.comment_pain_points_json, a.diff_angles_json, a.trend_judgement, a.content_form_advice, a.evidence_note,
        (SELECT views FROM content_metrics m WHERE m.content_id = c.id ORDER BY captured_at DESC LIMIT 1) AS latest_views,
        (SELECT likes FROM content_metrics m WHERE m.content_id = c.id ORDER BY captured_at DESC LIMIT 1) AS latest_likes,
        (SELECT comments FROM content_metrics m WHERE m.content_id = c.id ORDER BY captured_at DESC LIMIT 1) AS latest_comments,
        (SELECT favorites FROM content_metrics m WHERE m.content_id = c.id ORDER BY captured_at DESC LIMIT 1) AS latest_favorites,
        (SELECT shares FROM content_metrics m WHERE m.content_id = c.id ORDER BY captured_at DESC LIMIT 1) AS latest_shares
      FROM contents c
      JOIN sources s ON s.id = c.source_id
      LEFT JOIN content_analyses a ON a.content_id = c.id
      WHERE c.id = ?
    `)
    .get(contentId) as Record<string, unknown> | undefined;
  if (!row) throw new Error('内容不存在');

  // 获取同聚簇关联来源
  const refSources: Array<{ title: string; url: string; source: string; platform: string }> = [
    {
      title: String(row.title),
      url: String(row.canonical_url),
      source: String(row.source_name),
      platform: String(row.platform),
    },
  ];
  if (row.cluster_id) {
    const siblings = db
      .prepare(`
        SELECT c.title, c.canonical_url, c.platform, s.name AS source_name
        FROM contents c JOIN sources s ON s.id = c.source_id
        WHERE c.cluster_id = ? AND c.id != ? LIMIT 5
      `)
      .all(Number(row.cluster_id), contentId) as Array<{ title: string; canonical_url: string; platform: string; source_name: string }>;
    for (const sib of siblings) {
      refSources.push({ title: sib.title, url: sib.canonical_url, source: sib.source_name, platform: sib.platform });
    }
  }

  // 拉取用户最近的反馈偏好与已讲过记录（让推荐随用户反馈逐步进化）
  const recentFeedback = db
    .prepare(`
      SELECT recommended_title, feedback_status, feedback_note
      FROM topic_recommendations
      WHERE account_id = ? AND feedback_status != 'none'
      ORDER BY feedback_at DESC LIMIT 12
    `)
    .all(account.id) as Array<{ recommended_title: string; feedback_status: string; feedback_note: string }>;

  const feedbackSummary =
    recentFeedback.length > 0
      ? recentFeedback.map((f) => `- [${f.feedback_status}] ${f.recommended_title}${f.feedback_note ? `（${f.feedback_note}）` : ''}`).join('\n')
      : '暂无历史反馈';

  const metricsBlock = formatMetricsForPrompt({
    views: row.latest_views as number | null,
    likes: row.latest_likes as number | null,
    comments: row.latest_comments as number | null,
    favorites: row.latest_favorites as number | null,
    shares: row.latest_shares as number | null,
    follower_count: row.follower_count as number | null,
    breakout_ratio: row.breakout_ratio as number | null,
    growth_rate_per_hour: row.growth_rate_per_hour as number | null,
    breakout_reason: String(row.breakout_reason || ''),
  });

  const system = `你是私人自媒体选题主编。请根据创作者的账号定位和真实内容数据，输出一份可直接开拍/开写的选题推荐评估（严格 JSON）。
硬规则：
1. 6 项评分（0-100 整数）必须每项都有客观依据；凡未提供的播放/点赞/趋势数据必须明说“平台未提供”或“样本不足”，严禁编造互动数据或虚构全网爆火趋势！
2. 若内容与账号定位明显无关，score_match 必须给低分（<30），不要强行尬吹。
3. 参考用户历史反馈：对“not_interested / covered”类似主题要压低推荐分并给出提示。
返回严格 JSON：
{
  "recommended_title": "适合自媒体传播的爆款候选标题（大白话有钩子，不超过28字）",
  "core_viewpoint": "一句话核心观点",
  "recommend_reason": "为什么要做这个选题（2-3句直白理由）",
  "heat_evidence": "严格引用真实数据说明热度依据（无互动数据时明确说明仅基于来源时效/事件聚簇）",
  "suitable_format": "最适合的创作形式（如：60秒短视频口播 / 3分钟演示测评 / 深度图文）",
  "target_audience": "精准目标受众画像",
  "diff_angle": "避开同质化的差异化切入角度",
  "creation_advice": "具体结构建议（开头钩子 + 中间干货 + 结尾互动引导）",
  "scores": {
    "match": 0-100,
    "heat": 0-100,
    "diff": 0-100,
    "experience": 0-100,
    "timeliness": 0-100,
    "feasibility": 0-100
  },
  "score_reasons": {
    "match": "简短依据",
    "heat": "简短依据",
    "diff": "简短依据",
    "experience": "简短依据",
    "timeliness": "简短依据",
    "feasibility": "简短依据"
  }
}`;

  const user = `【我的账号定位】
账号名: ${account.name}
主力平台: ${account.platform_focus}
垂直领域: ${account.niche}
目标受众: ${account.target_audience}
内容方向: ${account.content_direction}
个人专业经验: ${account.personal_expertise}
创作偏好: ${account.style_preferences}

【我近期的选题反馈偏好】
${feedbackSummary}

【待评估素材】
标题: ${row.title}
平台/来源: ${row.platform} / ${row.source_name}
发布时间: ${row.published_at || row.discovered_at}
多源聚簇来源数: ${refSources.length}
AI摘要: ${row.summary_zh || row.summary || ''}
核心观点: ${row.core_points_json || '[]'}
受众需求: ${row.audience_needs_json || '[]'}
评论区痛点: ${row.comment_pain_points_json || '[]'}
差异化角度备选: ${row.diff_angles_json || '[]'}
趋势判断: ${row.trend_judgement || ''}
分析材料依据: ${row.evidence_note || ''}

【真实互动数据】
${metricsBlock}`;

  const { data, cached } = await callAiJsonWithCache<Record<string, unknown>>({
    purpose: `topic_recommend:acc${account.id}`,
    system,
    user,
    forceRefresh,
  });

  const sc = (data.scores && typeof data.scores === 'object' ? data.scores : {}) as Record<string, unknown>;
  const sMatch = clampScore(sc.match);
  const sHeat = clampScore(sc.heat);
  const sDiff = clampScore(sc.diff);
  const sExp = clampScore(sc.experience);
  const sTime = clampScore(sc.timeliness);
  const sFeas = clampScore(sc.feasibility);

  // 严格按账号自定义权重在后端重算加权总分（防止模型算术错误）
  const weightSum =
    account.weight_match +
    account.weight_heat +
    account.weight_diff +
    account.weight_experience +
    account.weight_timeliness +
    account.weight_feasibility || 100;

  const scoreTotal =
    Math.round(
      ((sMatch * account.weight_match +
        sHeat * account.weight_heat +
        sDiff * account.weight_diff +
        sExp * account.weight_experience +
        sTime * account.weight_timeliness +
        sFeas * account.weight_feasibility) /
        weightSum) *
        10
    ) / 10;

  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO topic_recommendations (
      account_id, content_id, cluster_id, recommended_title, core_viewpoint, recommend_reason,
      heat_evidence, reference_sources_json, suitable_format, target_audience, diff_angle, creation_advice,
      score_total, score_match, score_heat, score_diff, score_experience, score_timeliness, score_feasibility,
      score_breakdown_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, content_id) DO UPDATE SET
      cluster_id = excluded.cluster_id,
      recommended_title = excluded.recommended_title,
      core_viewpoint = excluded.core_viewpoint,
      recommend_reason = excluded.recommend_reason,
      heat_evidence = excluded.heat_evidence,
      reference_sources_json = excluded.reference_sources_json,
      suitable_format = excluded.suitable_format,
      target_audience = excluded.target_audience,
      diff_angle = excluded.diff_angle,
      creation_advice = excluded.creation_advice,
      score_total = excluded.score_total,
      score_match = excluded.score_match,
      score_heat = excluded.score_heat,
      score_diff = excluded.score_diff,
      score_experience = excluded.score_experience,
      score_timeliness = excluded.score_timeliness,
      score_feasibility = excluded.score_feasibility,
      score_breakdown_json = excluded.score_breakdown_json,
      updated_at = excluded.updated_at
  `).run(
    account.id,
    contentId,
    row.cluster_id != null ? Number(row.cluster_id) : null,
    String(data.recommended_title || row.title).slice(0, 120),
    String(data.core_viewpoint || '').slice(0, 400),
    String(data.recommend_reason || '').slice(0, 600),
    String(data.heat_evidence || row.breakout_reason || '暂无平台互动指标').slice(0, 400),
    JSON.stringify(refSources),
    String(data.suitable_format || row.content_form_advice || '').slice(0, 120),
    String(data.target_audience || account.target_audience).slice(0, 200),
    String(data.diff_angle || '').slice(0, 400),
    String(data.creation_advice || '').slice(0, 800),
    scoreTotal,
    sMatch,
    sHeat,
    sDiff,
    sExp,
    sTime,
    sFeas,
    JSON.stringify(data.score_reasons || {}),
    now,
    now
  );

  const saved = db
    .prepare('SELECT * FROM topic_recommendations WHERE account_id = ? AND content_id = ?')
    .get(account.id, contentId) as Record<string, unknown>;
  return { recommendation: saved, cached };
}

/**
 * 3. 批量运行近期内容的 AI 分析 + 选题推荐 + 事件聚簇
 */
export async function runBatchRecommendations(options: {
  accountId?: number;
  limit?: number;
  forceRefresh?: boolean;
}): Promise<{ processed: number; cachedHits: number; errors: string[] }> {
  const db = getDb();
  const account = getActiveAccount(options.accountId);
  const limit = Math.min(Math.max(options.limit || 8, 1), 20);

  // 优先挑出尚未为该账号生成推荐、或最新高爆款的内容
  const candidates = db
    .prepare(`
      SELECT c.id
      FROM contents c
      LEFT JOIN topic_recommendations r ON r.content_id = c.id AND r.account_id = ?
      WHERE (? = 1 OR r.id IS NULL)
      ORDER BY COALESCE(c.breakout_score, 0) DESC, c.discovered_at DESC
      LIMIT ?
    `)
    .all(account.id, options.forceRefresh ? 1 : 0, limit) as Array<{ id: number }>;

  let processed = 0;
  let cachedHits = 0;
  const errors: string[] = [];

  for (const c of candidates) {
    try {
      const res = await generateRecommendationForContent(c.id, account.id, Boolean(options.forceRefresh));
      processed++;
      if (res.cached) cachedHits++;
    } catch (err) {
      errors.push(`内容#${c.id}: ${(err as Error).message}`);
      log('WARN', 'ai-radar', `Recommend content#${c.id} failed: ${(err as Error).message}`);
    }
  }

  // 顺手执行一次事件聚簇
  try {
    await clusterRecentContents();
  } catch (err) {
    log('WARN', 'ai-radar', `Cluster failed: ${(err as Error).message}`);
  }

  return { processed, cachedHits, errors };
}

/**
 * 4. 多源事件/话题聚簇：把多个博主或媒体讨论的同一事件合并为一个话题，保留全部原始来源
 */
export async function clusterRecentContents(): Promise<{ clustersCreated: number; linked: number }> {
  const db = getDb();
  const items = db
    .prepare(`
      SELECT c.id, c.title, c.platform, c.discovered_at, c.breakout_score, s.name AS source_name,
             COALESCE(a.summary_zh, c.summary, '') AS brief
      FROM contents c
      JOIN sources s ON s.id = c.source_id
      LEFT JOIN content_analyses a ON a.content_id = c.id
      WHERE c.discovered_at >= datetime('now', '-14 days')
      ORDER BY c.discovered_at DESC
      LIMIT 40
    `)
    .all() as Array<{
    id: number;
    title: string;
    platform: string;
    discovered_at: string;
    breakout_score: number | null;
    source_name: string;
    brief: string;
  }>;

  if (items.length < 2) return { clustersCreated: 0, linked: 0 };

  const system = `你是热点事件编辑。给你最近一批内容列表，请把“明显讨论同一件事/同一个新产品/同一个热点话题”的内容聚成一个话题组（每组至少 1 条，同类内容务必合并，不相关的各自独立或忽略）。
严格返回 JSON：
{
  "clusters": [
    {
      "title": "10-22字简洁中文事件标题",
      "summary": "40-90字综合概述",
      "trend_stage": "rising|peak|steady|fading",
      "content_ids": [1, 2]
    }
  ]
}`;

  const user = items
    .map((it) => `#${it.id} [${it.platform}/${it.source_name}] ${it.title} | ${it.brief.slice(0, 90)}`)
    .join('\n');

  const { data } = await callAiJsonWithCache<{
    clusters?: Array<{ title?: string; summary?: string; trend_stage?: string; content_ids?: number[] }>;
  }>({
    purpose: 'topic_clustering',
    system,
    user,
    maxTokens: 2000,
  });

  const clusters = Array.isArray(data.clusters) ? data.clusters : [];
  if (clusters.length === 0) return { clustersCreated: 0, linked: 0 };

  const validIds = new Set(items.map((i) => i.id));
  const itemMap = new Map(items.map((i) => [i.id, i]));
  const now = new Date().toISOString();

  // 清空旧聚簇指针后按最新聚簇写回（轻量刷新）
  db.exec('UPDATE contents SET cluster_id = NULL; DELETE FROM topic_clusters;');

  const insertCluster = db.prepare(`
    INSERT INTO topic_clusters (title, summary, trend_stage, heat_score, source_count, first_seen_at, latest_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const linkContent = db.prepare('UPDATE contents SET cluster_id = ? WHERE id = ?');

  let clustersCreated = 0;
  let linked = 0;

  for (const cl of clusters) {
    const ids = (Array.isArray(cl.content_ids) ? cl.content_ids : [])
      .map((x) => Number(x))
      .filter((id) => validIds.has(id));
    if (ids.length === 0 || !cl.title) continue;

    const members = ids.map((id) => itemMap.get(id)!);
    const uniqueSources = new Set(members.map((m) => m.source_name)).size;
    const avgBreakout =
      members.reduce((acc, m) => acc + (typeof m.breakout_score === 'number' ? m.breakout_score : 40), 0) / members.length;
    const heatScore = Math.min(100, Math.round(avgBreakout * 0.6 + Math.min(40, uniqueSources * 14)));
    const times = members.map((m) => m.discovered_at).sort();
    const stage = ['rising', 'peak', 'steady', 'fading'].includes(String(cl.trend_stage)) ? String(cl.trend_stage) : 'rising';

    const res = insertCluster.run(
      String(cl.title).trim().slice(0, 80),
      String(cl.summary || '').trim().slice(0, 300),
      stage,
      heatScore,
      uniqueSources,
      times[0] || now,
      times[times.length - 1] || now,
      now,
      now
    );
    const cid = Number(res.lastInsertRowid);
    clustersCreated++;
    for (const id of ids) {
      linkContent.run(cid, id);
      linked++;
    }
  }

  return { clustersCreated, linked };
}

/**
 * 5. 用当前账号定位给行业热榜条目做垂直创作相关性筛选打分
 */
export async function scoreHotBoardForAccount(accountId?: number): Promise<{ scored: number }> {
  const db = getDb();
  const account = getActiveAccount(accountId);
  const items = db
    .prepare('SELECT id, platform, board_name, title, summary, category, hot_label FROM hot_board_items ORDER BY captured_at DESC, rank_no ASC LIMIT 45')
    .all() as Array<{
    id: number;
    platform: string;
    board_name: string;
    title: string;
    summary: string;
    category: string;
    hot_label: string;
  }>;

  if (items.length === 0) return { scored: 0 };

  const system = `你是自媒体垂直热点筛选官。请判断下面每条平台热榜对用户账号是否具有真实创作参考价值（0-100分，纯娱乐八卦/无关社会新闻给 0-25 分，高度贴合垂直赛道给 70-100 分）。
严格返回 JSON：
{
  "scores": [
    { "id": 1, "score": 82, "reason": "15-35字说明为什么值得追或不相关" }
  ]
}`;

  const user = `【账号定位】
账号: ${account.name}
领域: ${account.niche}
受众: ${account.target_audience}
方向: ${account.content_direction}

【热榜列表】
${items.map((x) => `#${x.id} [${x.board_name}/${x.category}] ${x.title} (${x.hot_label}) ${x.summary.slice(0, 60)}`).join('\n')}`;

  const { data } = await callAiJsonWithCache<{ scores?: Array<{ id?: number; score?: number; reason?: string }> }>({
    purpose: `hotboard_relevance:acc${account.id}`,
    system,
    user,
    maxTokens: 2200,
  });

  const upd = db.prepare('UPDATE hot_board_items SET account_relevance_score = ?, account_relevance_reason = ? WHERE id = ?');
  let scored = 0;
  for (const s of Array.isArray(data.scores) ? data.scores : []) {
    const id = Number(s.id);
    if (!Number.isFinite(id)) continue;
    upd.run(clampScore(s.score), String(s.reason || '').slice(0, 160), id);
    scored++;
  }
  return { scored };
}

/**
 * 6. 根据账号当前权重即时重算所有推荐总分（用户在页面拖动权重滑块时秒级生效，不重调大模型）
 */
export function recalculateAccountScores(accountId: number): number {
  const db = getDb();
  const account = getActiveAccount(accountId);
  const weightSum =
    account.weight_match +
    account.weight_heat +
    account.weight_diff +
    account.weight_experience +
    account.weight_timeliness +
    account.weight_feasibility || 100;

  const rows = db
    .prepare(
      'SELECT id, score_match, score_heat, score_diff, score_experience, score_timeliness, score_feasibility FROM topic_recommendations WHERE account_id = ?'
    )
    .all(accountId) as Array<{
    id: number;
    score_match: number;
    score_heat: number;
    score_diff: number;
    score_experience: number;
    score_timeliness: number;
    score_feasibility: number;
  }>;

  const upd = db.prepare('UPDATE topic_recommendations SET score_total = ?, updated_at = ? WHERE id = ?');
  const now = new Date().toISOString();
  for (const r of rows) {
    const total =
      Math.round(
        ((r.score_match * account.weight_match +
          r.score_heat * account.weight_heat +
          r.score_diff * account.weight_diff +
          r.score_experience * account.weight_experience +
          r.score_timeliness * account.weight_timeliness +
          r.score_feasibility * account.weight_feasibility) /
          weightSum) *
          10
      ) / 10;
    upd.run(total, now, r.id);
  }
  return rows.length;
}
