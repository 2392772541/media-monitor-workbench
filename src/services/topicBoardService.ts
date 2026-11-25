import { getDb } from '../db/database.js';

export const TOPIC_BOARD_STATUSES = [
  'to_research',
  'to_create',
  'creating',
  'to_publish',
  'published',
  'reviewed',
] as const;

export type TopicBoardStatus = (typeof TOPIC_BOARD_STATUSES)[number];

// 基于中文/英文二元组（bigram）计算标题相似度，用于离线瞬时历史选题查重
function textBigrams(input: string): Set<string> {
  const norm = input
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .trim();
  const out = new Set<string>();
  if (norm.length <= 2) {
    if (norm) out.add(norm);
    return out;
  }
  for (let i = 0; i < norm.length - 1; i++) {
    out.add(norm.slice(i, i + 2));
  }
  return out;
}

export function titleSimilarity(a: string, b: string): number {
  const sa = textBigrams(a);
  const sb = textBigrams(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const x of sa) {
    if (sb.has(x)) inter++;
  }
  return Math.round(((2 * inter) / (sa.size + sb.size)) * 100);
}

/**
 * 历史选题查重：比对「个人选题库所有历史选题」以及「曾标记为“已讲过”的推荐记录」
 */
export function findDuplicateTopics(title: string, excludeBoardId?: number): Array<{
  source: 'board' | 'covered_feedback';
  id: number;
  title: string;
  status: string;
  similarity: number;
  created_at: string;
}> {
  const clean = title.trim();
  if (clean.length < 3) return [];

  const db = getDb();
  const boardRows = db
    .prepare('SELECT id, title, status, created_at FROM topic_board ORDER BY updated_at DESC LIMIT 300')
    .all() as Array<{ id: number; title: string; status: string; created_at: string }>;

  const coveredRows = db
    .prepare(`
      SELECT id, recommended_title AS title, feedback_status AS status, COALESCE(feedback_at, updated_at) AS created_at
      FROM topic_recommendations
      WHERE feedback_status = 'covered'
      ORDER BY updated_at DESC LIMIT 200
    `)
    .all() as Array<{ id: number; title: string; status: string; created_at: string }>;

  const hits: Array<{
    source: 'board' | 'covered_feedback';
    id: number;
    title: string;
    status: string;
    similarity: number;
    created_at: string;
  }> = [];

  for (const r of boardRows) {
    if (excludeBoardId && r.id === excludeBoardId) continue;
    const sim = titleSimilarity(clean, r.title);
    if (sim >= 38) {
      hits.push({ source: 'board', id: r.id, title: r.title, status: r.status, similarity: sim, created_at: r.created_at });
    }
  }
  for (const r of coveredRows) {
    const sim = titleSimilarity(clean, r.title);
    if (sim >= 38) {
      hits.push({ source: 'covered_feedback', id: r.id, title: r.title, status: '已讲过', similarity: sim, created_at: r.created_at });
    }
  }

  return hits.sort((a, b) => b.similarity - a.similarity).slice(0, 6);
}
