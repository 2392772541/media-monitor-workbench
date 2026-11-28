import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../config.js';
import { getDb } from '../db/database.js';
import { callAiJsonWithCache } from './aiRadarService.js';

export interface CreatorCopyDigest {
  contentId: number;
  overview: string; // 一句话讲清大概讲什么
  keyPoints: string[]; // 核心要点（3~4条，简短干货）
  actionItems: string[]; // 对我有啥用 / 看完可以做什么（3~4条，直接可做）
  usedTranscript: boolean;
  sourceChars: number;
  generatedAt: string;
}

const DIGEST_FILE = path.join(PATHS.dataDir, 'creator_copy_digests.json');

function readDigestStore(): Record<string, CreatorCopyDigest> {
  try {
    if (!fs.existsSync(DIGEST_FILE)) return {};
    const parsed = JSON.parse(fs.readFileSync(DIGEST_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, CreatorCopyDigest>) : {};
  } catch {
    return {};
  }
}

function saveDigestStore(store: Record<string, CreatorCopyDigest>): void {
  fs.mkdirSync(path.dirname(DIGEST_FILE), { recursive: true });
  fs.writeFileSync(DIGEST_FILE, JSON.stringify(store, null, 2), 'utf8');
}

// 清理列表项开头的「1. / 1、 / - / •」等重复编号，统一由前端渲染干净的 1、2、3、4
export function normalizeNumberedLines(raw: unknown, maxItems = 4): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    const cleaned = String(item || '')
      .trim()
      .replace(/^(?:[①②③④⑤⑥⑦⑧⑨⑩]|\(?\d+\)?[.、:：\s)\-]+|[-•*·]\s*)/, '')
      .trim();
    if (cleaned) out.push(cleaned);
    if (out.length >= maxItems) break;
  }
  return out;
}

export function getCreatorCopyDigest(contentId: number): CreatorCopyDigest | null {
  const store = readDigestStore();
  return store[String(contentId)] || null;
}

export function getCreatorCopyDigestMap(): Record<string, CreatorCopyDigest> {
  return readDigestStore();
}

// 针对单条视频文案（优先完整口播逐字稿，未转写时回退标题+简介），归纳「大概讲什么 + 1234要点 + 1234能做什么」
export async function generateCreatorCopyDigest(
  contentId: number,
  forceRefresh = false
): Promise<{ digest: CreatorCopyDigest; cached: boolean }> {
  const db = getDb();
  const content = db
    .prepare(`
      SELECT c.id, c.title, c.platform, c.author, c.summary, c.body, c.transcript,
             s.name AS source_name
      FROM contents c
      JOIN sources s ON s.id = c.source_id
      WHERE c.id = ?
    `)
    .get(contentId) as
    | {
        id: number;
        title: string;
        platform: string;
        author: string;
        summary: string;
        body: string;
        transcript: string;
        source_name: string;
      }
    | undefined;

  if (!content) {
    throw new Error('视频记录不存在');
  }

  const transcript = (content.transcript || '').trim();
  const usedTranscript = transcript.length >= 40;
  const fallbackText = `${content.summary || ''}\n${content.body || ''}`.trim();
  const sourceText = usedTranscript ? transcript.slice(0, 5000) : fallbackText.slice(0, 2600);

  // 若本地已有归纳、未要求强制刷新、且素材级别未升级（比如还没新提取完整口播稿），直接秒回缓存
  const existing = getCreatorCopyDigest(contentId);
  if (existing && !forceRefresh && (existing.usedTranscript || !usedTranscript)) {
    return { digest: existing, cached: true };
  }

  const { data, cached } = await callAiJsonWithCache<{
    overview?: string;
    keyPoints?: string[];
    actionItems?: string[];
  }>({
    purpose: 'creator_copy_digest_1234',
    system: `你是极简务实的自媒体内容提炼助手。用户看完一条对标博主视频后，不想看长篇大论，只想一眼看懂三件事：
1. 这个视频大概讲什么（1句大白话，35字以内）。
2. 视频里最核心的要点（3~4条，每条28字以内，直给干货，不废话）。
3. 看完对创作者有什么帮助、可以马上做什么（3~4条，每条32字以内，直接给可落地的动作、可借鉴的方法或可拍角度）。

硬性要求：
- 全部说日常大白话，严禁“综上所述、赋能、闭环、从架构来看、值得注意的是”等AI套话。
- 数组元素里不要自己加“1.”“2.”序号（界面会自动标 1、2、3、4）。
- 只返回严格 JSON，不要额外说明。`,
    user: `博主：${content.source_name}（平台：${content.platform}）
视频标题：${content.title}
文案来源：${usedTranscript ? '完整口播逐字稿' : '视频标题与原帖简介'}

文案内容：
${sourceText || content.title}

请输出严格 JSON：
{
  "overview": "一句话大白话说明视频大概讲什么（35字以内）",
  "keyPoints": [
    "核心要点一（28字内）",
    "核心要点二（28字内）",
    "核心要点三（28字内）",
    "核心要点四（28字内）"
  ],
  "actionItems": [
    "看完可以直接做什么或怎么用在自己内容里（32字内）",
    "可直接做的第二件事（32字内）",
    "可直接做的第三件事（32字内）",
    "可直接做的第四件事（32字内）"
  ]
}`,
    temperature: 0.35,
    maxTokens: 1100,
    forceRefresh,
  });

  const digest: CreatorCopyDigest = {
    contentId,
    overview: String(data.overview || content.title).trim().slice(0, 80),
    keyPoints: normalizeNumberedLines(data.keyPoints, 4),
    actionItems: normalizeNumberedLines(data.actionItems, 4),
    usedTranscript,
    sourceChars: (sourceText || content.title).length,
    generatedAt: new Date().toISOString(),
  };

  if (digest.keyPoints.length === 0) {
    digest.keyPoints = [content.title.slice(0, 40)];
  }
  if (digest.actionItems.length === 0) {
    digest.actionItems = ['提炼其中最有反差的 1 个观点，结合自身经历重拍成 60 秒口播'];
  }

  const store = readDigestStore();
  store[String(contentId)] = digest;
  saveDigestStore(store);

  return { digest, cached };
}
