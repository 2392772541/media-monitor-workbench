import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../config.js';
import { getDb } from '../db/database.js';
import { callAiJsonWithCache } from './aiRadarService.js';

export const VIDEO_PLATFORMS = new Set([
  'douyin',
  'bilibili',
  'youtube',
  'kuaishou',
  'xiaohongshu',
  'wechat-channels',
]);

export function isVideoPlatform(platform: string): boolean {
  return VIDEO_PLATFORMS.has(String(platform || '').trim().toLowerCase());
}

export interface CreatorCopyDigest {
  contentId: number;
  overview: string; // 1~2句大白话讲清整期视频核心观点/逻辑与结论
  keyPoints: string[]; // 核心要点（严格4条，来自口播原话干货细节）
  actionItems: string[]; // 对我有啥用 / 看完可以做什么（严格4条，具体可执行动作）
  usedTranscript: boolean;
  sourceKind?: 'transcript' | 'article';
  sourceChars: number;
  transcriptChars?: number;
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

// 清理「大概讲什么」文本，避免在半句话中间生硬截断
export function normalizeOverviewText(raw: unknown, maxChars = 220): string {
  const clean = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '已按完整口播完成提炼';
  if (clean.length <= maxChars) return clean;
  const sliced = clean.slice(0, maxChars);
  const lastStop = Math.max(sliced.lastIndexOf('。'), sliced.lastIndexOf('！'), sliced.lastIndexOf('？'));
  if (lastStop >= Math.floor(maxChars * 0.5)) {
    return sliced.slice(0, lastStop + 1);
  }
  return `${sliced.replace(/[，,、；;：:\s]+$/, '')}。`;
}

// 清理列表项开头的「1. / 1、 / ① / - / •」等重复编号，统一由前端渲染干净的 1、2、3、4
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

// 长口播全文覆盖：12000字以内完整送入；超长视频保留开头+中段+结尾，避免漏掉后半段核心结论
export function buildTranscriptExcerpt(text: string, maxChars = 12000): string {
  const clean = String(text || '').trim();
  if (clean.length <= maxChars) return clean;
  const headLen = Math.floor(maxChars * 0.46);
  const midLen = Math.floor(maxChars * 0.29);
  const tailLen = maxChars - headLen - midLen;
  const midStart = Math.max(headLen, Math.floor((clean.length - midLen) / 2));
  return [
    clean.slice(0, headLen).trim(),
    '[……中段节选……]',
    clean.slice(midStart, midStart + midLen).trim(),
    '[……后段与收尾……]',
    clean.slice(-tailLen).trim(),
  ].join('\n\n');
}

// 清理历史版本里未转口播、仅靠标题简介硬猜出来的浅层视频归纳，避免页面继续展示低质量结果
export function purgeShallowVideoDigests(): number {
  const store = readDigestStore();
  const keys = Object.keys(store);
  if (keys.length === 0) return 0;

  let removed = 0;
  let db: ReturnType<typeof getDb> | null = null;
  try {
    db = getDb();
  } catch {
    db = null;
  }

  for (const k of keys) {
    const item = store[k];
    if (!item) {
      delete store[k];
      removed++;
      continue;
    }
    if (item.usedTranscript) continue;

    // 查数据库确认是否属于视频平台；若是视频平台且未基于转写口播，一律清除
    let isVideo = false;
    if (db) {
      const row = db.prepare('SELECT platform FROM contents WHERE id = ?').get(Number(k)) as
        | { platform?: string }
        | undefined;
      if (!row || isVideoPlatform(row.platform || '')) {
        isVideo = true;
      }
    } else if (item.sourceKind !== 'article') {
      isVideo = true;
    }

    if (isVideo) {
      delete store[k];
      removed++;
    }
  }

  if (removed > 0) {
    saveDigestStore(store);
  }
  return removed;
}

export function getCreatorCopyDigest(contentId: number): CreatorCopyDigest | null {
  const store = readDigestStore();
  return store[String(contentId)] || null;
}

export function getCreatorCopyDigestMap(): Record<string, CreatorCopyDigest> {
  purgeShallowVideoDigests();
  return readDigestStore();
}

export function hasValidVideoTranscript(contentId: number): {
  exists: boolean;
  isVideo: boolean;
  hasTranscript: boolean;
  transcriptChars: number;
  platform: string;
  title: string;
} {
  const db = getDb();
  const row = db
    .prepare('SELECT id, platform, title, transcript FROM contents WHERE id = ?')
    .get(contentId) as { id: number; platform: string; title: string; transcript?: string } | undefined;
  if (!row) {
    return { exists: false, isVideo: false, hasTranscript: false, transcriptChars: 0, platform: '', title: '' };
  }
  const t = (row.transcript || '').trim();
  return {
    exists: true,
    isVideo: isVideoPlatform(row.platform),
    hasTranscript: t.length >= 40,
    transcriptChars: t.length,
    platform: row.platform,
    title: row.title,
  };
}

/**
 * 强依赖完整口播逐字稿的深度 1234 归纳：
 * - 视频类内容（抖音/B站/YouTube/快手/小红书/视频号）：严禁仅靠标题或简介猜内容，必须已有完整转写口播（>=40字）；
 * - 纯图文/RSS文章源：基于完整正文（>=80字）提炼。
 */
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

  const isVideo = isVideoPlatform(content.platform);
  const transcript = (content.transcript || '').trim();
  const articleBody = (content.body || content.summary || '').trim();

  // 视频类内容硬性守卫：没转写完整口播稿，绝不拿标题/简介硬猜
  if (isVideo && transcript.length < 40) {
    throw new Error('NEED_TRANSCRIPT: 视频尚未完成口播转写，不能仅凭标题猜测；请先转写完整口播文案');
  }
  if (!isVideo && articleBody.length < 80) {
    throw new Error('当前文章正文内容过短，暂无足够文案可供深度归纳');
  }

  const usedTranscript = isVideo;
  const rawFullText = isVideo ? transcript : articleBody;
  const excerptText = buildTranscriptExcerpt(rawFullText, 12000);

  // 若本地已有基于完整口播（且字数相符）的新版深度归纳且未强制刷新，直接命中缓存
  const existing = getCreatorCopyDigest(contentId);
  if (
    existing &&
    !forceRefresh &&
    existing.usedTranscript === usedTranscript &&
    existing.sourceKind !== undefined &&
    existing.sourceChars >= Math.min(rawFullText.length, 40)
  ) {
    return { digest: existing, cached: true };
  }

  const { data, cached } = await callAiJsonWithCache<{
    overview?: string;
    keyPoints?: string[];
    actionItems?: string[];
  }>({
    purpose: 'creator_copy_digest_v2_transcript',
    system: `你是极其务实的自媒体深度拆解助手。你会收到一条视频【完整语音转写出来的口播逐字稿】（或文章全文）。
用户嫌之前只看标题归纳太浅了，现在要求你必须彻底吃透全文原话，提炼出“不看原视频也能学到真干货”的 1234 深度总结。

严格规则：
1. 【大概讲什么 (overview)】：1~2句大白话（严格控制在 60~115 字并完整收句）。必须说清博主在正片里到底展开了什么核心观点、用了什么关键案例/实操步骤、最终得出了什么判断，严禁把标题换几个字敷衍复述！
2. 【核心要点 (keyPoints)】：严格输出 4 条，每条 30~70 字。必须全部来自口播逐字稿中的【具体内容】——写清博主提到的真实做法、具体工具/参数/成本/步骤、核心因果逻辑、关键转折或反常识细节。绝不能写“内容很有干货/制作门槛高/要注重细节”这类放之四海而皆准的空话！
3. 【对我有啥用 · 可以做什么 (actionItems)】：严格输出 4 条，每条 35~75 字。必须直接对照上面口播里的真实方法/观点/案例，告诉创作者看完马上能做什么——比如直接套用哪个具体步骤或话术、怎么借这个真实案例切出一条自己的新选题、工作流里哪一步能照着改。严禁“拆分最小步骤/多和团队合作/持续学习”这类废话！
4. 全部说日常大白话中文（除原本专有名词外，严禁夹杂 visibly/actually 等英文副词），严禁出现“综上所述、赋能、闭环、矩阵、颗粒度、值得注意的是”等 AI 套话。
5. 数组元素开头不要自己写“1.”“2.”序号（界面会自动标 1、2、3、4）。只输出严格 JSON。`,
    user: `博主：${content.source_name}（平台：${content.platform}）
视频标题（仅供参考，严禁只靠标题发挥）：${content.title}
素材来源：${isVideo ? `本机转写的完整视频口播逐字稿（全文共 ${rawFullText.length} 字）` : `文章全文（共 ${rawFullText.length} 字）`}

=== 完整文案正文开始 ===
${excerptText}
=== 完整文案正文结束 ===

请严格基于上方正文里的具体原话，输出 JSON：
{
  "overview": "1~2句大白话讲透整期视频真正展开了什么核心内容与结论（45~95字）",
  "keyPoints": [
    "口播原话里的核心干货要点一（含具体方法/例子/数据/原因，30~70字）",
    "口播原话里的核心干货要点二（30~70字）",
    "口播原话里的核心干货要点三（30~70字）",
    "口播原话里的核心干货要点四（30~70字）"
  ],
  "actionItems": [
    "对照视频里的真实做法，我马上能落地的具体动作或可拍角度一（35~75字）",
    "具体可做事项二（35~75字）",
    "具体可做事项三（35~75字）",
    "具体可做事项四（35~75字）"
  ]
}`,
    temperature: 0.3,
    maxTokens: 2000,
    forceRefresh,
  });

  const digest: CreatorCopyDigest = {
    contentId,
    overview: normalizeOverviewText(data.overview, 220),
    keyPoints: normalizeNumberedLines(data.keyPoints, 4),
    actionItems: normalizeNumberedLines(data.actionItems, 4),
    usedTranscript,
    sourceKind: isVideo ? 'transcript' : 'article',
    sourceChars: rawFullText.length,
    transcriptChars: isVideo ? transcript.length : 0,
    generatedAt: new Date().toISOString(),
  };

  if (digest.keyPoints.length === 0) {
    throw new Error('模型未返回有效核心要点，请稍后重试');
  }
  if (digest.actionItems.length === 0) {
    throw new Error('模型未返回有效行动建议，请稍后重试');
  }

  const store = readDigestStore();
  store[String(contentId)] = digest;
  saveDigestStore(store);

  return { digest, cached };
}
