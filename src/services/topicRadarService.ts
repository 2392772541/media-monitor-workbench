import { getDb } from '../db/database.js';
import { callAiJsonWithCache } from './aiRadarService.js';

export interface TrackedTopicRow {
  id: number;
  name: string;
  domain: string;
  keywords_json: string;
  related_terms_json: string;
  exclude_terms_json: string;
  description: string;
  interval_minutes: number;
  alert_threshold: number;
  status: string;
  last_scanned_at: string | null;
  created_at: string;
  updated_at: string;
}

function parseJsonList(raw: string): string[] {
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map((x) => String(x || '').trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * 扫描单个自定义话题：
 * 1) 先用排除词剔除噪声，用主关键词/关联词做快速规则命中；
 * 2) 再对近期未按字面命中的内容调 8317 做 AI 语义追踪，发现字面没提关键词但语义高度相关的内容！
 */
export async function scanTrackedTopic(topicId: number, useSemanticAi = true): Promise<{
  topicId: number;
  ruleMatched: number;
  semanticMatched: number;
}> {
  const db = getDb();
  const topic = db.prepare('SELECT * FROM tracked_topics WHERE id = ?').get(topicId) as TrackedTopicRow | undefined;
  if (!topic) throw new Error('追踪话题不存在');

  const keywords = parseJsonList(topic.keywords_json);
  const related = parseJsonList(topic.related_terms_json);
  const excludes = parseJsonList(topic.exclude_terms_json);

  const recentContents = db
    .prepare(`
      SELECT c.id, c.title, c.summary, c.body, c.transcript, c.tags_json, c.platform, c.discovered_at,
             COALESCE(a.summary_zh, '') AS ai_summary
      FROM contents c
      LEFT JOIN content_analyses a ON a.content_id = c.id
      WHERE c.discovered_at >= datetime('now', '-30 days')
      ORDER BY c.discovered_at DESC
      LIMIT 80
    `)
    .all() as Array<{
    id: number;
    title: string;
    summary: string;
    body: string;
    transcript: string;
    tags_json: string;
    platform: string;
    discovered_at: string;
    ai_summary: string;
  }>;

  const now = new Date().toISOString();
  const upsertMatch = db.prepare(`
    INSERT INTO topic_matches (topic_id, content_id, match_mode, relevance_score, match_reason, matched_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(topic_id, content_id) DO UPDATE SET
      match_mode = CASE WHEN topic_matches.match_mode != excluded.match_mode THEN 'both' ELSE excluded.match_mode END,
      relevance_score = MAX(topic_matches.relevance_score, excluded.relevance_score),
      match_reason = excluded.match_reason,
      matched_at = excluded.matched_at
  `);

  let ruleMatched = 0;
  const semanticCandidates: typeof recentContents = [];

  for (const item of recentContents) {
    const haystack = `${item.title} ${item.ai_summary} ${item.summary} ${item.tags_json} ${item.transcript.slice(0, 600)}`.toLowerCase();
    // 排除词命中则跳过
    if (excludes.some((ex) => ex && haystack.includes(ex.toLowerCase()))) {
      continue;
    }

    const hitMain = keywords.filter((k) => haystack.includes(k.toLowerCase()));
    const hitRel = related.filter((k) => haystack.includes(k.toLowerCase()));

    if (hitMain.length > 0 || hitRel.length >= 2) {
      const score = Math.min(95, 68 + hitMain.length * 10 + hitRel.length * 5);
      const reason = `关键词命中：${[...hitMain, ...hitRel].slice(0, 4).join('、')}`;
      upsertMatch.run(topicId, item.id, 'rule', score, reason, now);
      ruleMatched++;
    } else if (useSemanticAi && semanticCandidates.length < 30) {
      semanticCandidates.push(item);
    }
  }

  let semanticMatched = 0;
  if (useSemanticAi && semanticCandidates.length > 0) {
    try {
      const system = `你是话题雷达语义追踪助手。判断下面每条内容是否在语义上与用户追踪的话题密切相关（即使字面没出现完全一样的关键词）。
只返回相关度 >= 60 分的条目，严格返回 JSON：
{
  "matches": [
    { "id": 12, "score": 78, "reason": "15-35字说明语义关联点" }
  ]
}`;

      const user = `【追踪话题】
话题名称: ${topic.name}
关注领域: ${topic.domain}
主关键词: ${keywords.join('、')}
关联词: ${related.join('、')}
排除词: ${excludes.join('、')}
语义关注描述: ${topic.description || topic.name}

【待判别内容】
${semanticCandidates.map((c) => `#${c.id} [${c.platform}] ${c.title} | ${(c.ai_summary || c.summary || '').slice(0, 90)}`).join('\n')}`;

      const { data } = await callAiJsonWithCache<{
        matches?: Array<{ id?: number; score?: number; reason?: string }>;
      }>({
        purpose: `topic_semantic_scan:t${topicId}`,
        system,
        user,
        maxTokens: 1600,
      });

      const validIds = new Set(semanticCandidates.map((c) => c.id));
      for (const m of Array.isArray(data.matches) ? data.matches : []) {
        const cid = Number(m.id);
        const sc = Number(m.score);
        if (!validIds.has(cid) || !Number.isFinite(sc) || sc < 60) continue;
        upsertMatch.run(topicId, cid, 'semantic', Math.min(100, Math.round(sc)), `AI语义相关：${String(m.reason || '').slice(0, 120)}`, now);
        semanticMatched++;
      }
    } catch {
      // AI 不可用时保留规则命中结果，不阻塞
    }
  }

  db.prepare('UPDATE tracked_topics SET last_scanned_at = ?, updated_at = ? WHERE id = ?').run(now, now, topicId);
  return { topicId, ruleMatched, semanticMatched };
}

export function getTopicTrendSeries(topicId: number, days = 14) {
  const db = getDb();
  const rows = db
    .prepare(`
      SELECT substr(COALESCE(c.published_at, c.discovered_at), 1, 10) AS day,
             COUNT(*) AS count,
             ROUND(AVG(COALESCE(c.breakout_score, m.relevance_score)), 1) AS avg_heat
      FROM topic_matches m
      JOIN contents c ON c.id = m.content_id
      WHERE m.topic_id = ? AND COALESCE(c.published_at, c.discovered_at) >= datetime('now', '-' || ? || ' days')
      GROUP BY day
      ORDER BY day ASC
    `)
    .all(topicId, days) as Array<{ day: string; count: number; avg_heat: number }>;

  // 补齐连续日期零值，确保趋势折线图连续自然
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const series: Array<{ day: string; count: number; avgHeat: number }> = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    const key = d.toISOString().slice(0, 10);
    const hit = byDay.get(key);
    series.push({
      day: key.slice(5),
      count: hit ? Number(hit.count) : 0,
      avgHeat: hit ? Number(hit.avg_heat) : 0,
    });
  }
  return series;
}
