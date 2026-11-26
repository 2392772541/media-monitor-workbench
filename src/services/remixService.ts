import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../config.js';
import { getDb } from '../db/database.js';
import { callAiJsonWithCache } from './aiRadarService.js';

export interface ViralBreakdown {
  hookAnalysis: string;
  structureSteps: Array<{ stage: string; summary: string; technique: string }>;
  viralDrivers: string[];
  remixAngles: Array<{ title: string; angle: string; targetAudience: string; whyBetter: string }>;
  usedTranscript: boolean;
  analyzedAt: string;
}

export interface RemixScriptDraft {
  id: string;
  angle: string;
  tone: string;
  lengthLabel: string;
  newTitle: string;
  hookLine: string;
  scriptText: string;
  shootingTips: string[];
  tags: string[];
  createdAt: string;
}

export interface ContentRemixRecord {
  contentId: number;
  breakdown: ViralBreakdown | null;
  drafts: RemixScriptDraft[];
  updatedAt: string;
}

const REMIX_FILE = path.join(PATHS.dataDir, 'remix_drafts.json');

function readRemixStore(): Record<string, ContentRemixRecord> {
  try {
    if (!fs.existsSync(REMIX_FILE)) return {};
    const parsed = JSON.parse(fs.readFileSync(REMIX_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, ContentRemixRecord>) : {};
  } catch {
    return {};
  }
}

function saveRemixStore(store: Record<string, ContentRemixRecord>): void {
  fs.mkdirSync(path.dirname(REMIX_FILE), { recursive: true });
  fs.writeFileSync(REMIX_FILE, JSON.stringify(store, null, 2), 'utf8');
}

export function getContentRemixRecord(contentId: number): ContentRemixRecord {
  const store = readRemixStore();
  return (
    store[String(contentId)] || {
      contentId,
      breakdown: null,
      drafts: [],
      updatedAt: '',
    }
  );
}

// 跨博主爆款总排行榜（彻底替代单纯翻单个主页，一眼知道谁爆了、排第几、爆了几倍）
export function getCreatorLeaderboard(params: {
  platform?: string;
  creatorId?: number;
  sort?: 'ratio' | 'likes' | 'views' | 'recent';
  days?: number;
  onlyBreakout?: boolean;
  limit?: number;
}) {
  const db = getDb();
  const where: string[] = ["s.source_type != 'hot_board'"];
  const args: (string | number)[] = [];

  if (params.platform) {
    where.push('c.platform = ?');
    args.push(params.platform);
  }
  if (params.creatorId) {
    where.push('c.source_id = ?');
    args.push(params.creatorId);
  }
  if (params.days && params.days > 0) {
    where.push(`COALESCE(c.published_at, c.discovered_at) >= datetime('now', '-' || ? || ' days')`);
    args.push(params.days);
  }
  if (params.onlyBreakout) {
    where.push('(c.breakout_ratio >= 1.6 OR c.breakout_score >= 68)');
  }

  let orderBy =
    'COALESCE(c.breakout_ratio, 0) DESC, COALESCE(c.breakout_score, 0) DESC, COALESCE(latest_likes, 0) DESC, COALESCE(c.published_at, c.discovered_at) DESC';
  if (params.sort === 'likes') {
    orderBy = 'COALESCE(latest_likes, 0) DESC, COALESCE(latest_views, 0) DESC';
  } else if (params.sort === 'views') {
    orderBy = 'COALESCE(latest_views, 0) DESC, COALESCE(latest_likes, 0) DESC';
  } else if (params.sort === 'recent') {
    orderBy = 'COALESCE(c.published_at, c.discovered_at) DESC';
  }

  const limit = Math.min(Math.max(params.limit || 40, 10), 100);
  const rows = db
    .prepare(`
      SELECT c.id, c.source_id, c.title, c.platform, c.author, c.canonical_url, c.cover_url,
             c.summary, c.published_at, c.discovered_at, c.transcript_status,
             length(COALESCE(c.transcript, '')) AS transcript_chars,
             c.breakout_score, c.breakout_ratio, c.breakout_reason,
             s.name AS source_name, s.follower_count, s.baseline_views, s.baseline_likes,
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
      WHERE ${where.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT ?
    `)
    .all(...args, limit) as Array<Record<string, unknown>>;

  const remixStore = readRemixStore();
  return rows.map((row, idx) => {
    const rec = remixStore[String(row.id)];
    return {
      ...row,
      rank: idx + 1,
      has_breakdown: Boolean(rec?.breakdown),
      remix_draft_count: rec?.drafts?.length || 0,
    };
  });
}

// 步骤 A：AI 深度拆解爆款结构（前3秒钩子 / 骨架步骤 / 爆款驱动力 / 3个差异化二创角度）
export async function generateViralBreakdown(contentId: number, forceRefresh = false): Promise<ViralBreakdown> {
  const db = getDb();
  const content = db
    .prepare(`
      SELECT c.id, c.title, c.platform, c.author, c.summary, c.body, c.transcript, c.breakout_ratio, c.breakout_reason,
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
        breakout_ratio: number | null;
        breakout_reason: string;
        source_name: string;
      }
    | undefined;
  if (!content) throw new Error('作品不存在');

  const comments = db
    .prepare('SELECT text, likes FROM content_comments WHERE content_id = ? ORDER BY COALESCE(likes, 0) DESC LIMIT 8')
    .all(contentId) as Array<{ text: string; likes: number | null }>;

  const hasTranscript = (content.transcript || '').trim().length >= 50;
  const sourceText = hasTranscript
    ? content.transcript.slice(0, 4800)
    : `${content.summary || ''}\n${content.body || ''}`.trim().slice(0, 2500);
  const commentsBlock =
    comments.length > 0
      ? `\n观众高赞热评：\n${comments.map((c) => `- [赞${c.likes ?? 0}] ${c.text.slice(0, 120)}`).join('\n')}`
      : '';

  const { data } = await callAiJsonWithCache<{
    hookAnalysis?: string;
    structureSteps?: Array<{ stage?: string; summary?: string; technique?: string }>;
    viralDrivers?: string[];
    remixAngles?: Array<{ title?: string; angle?: string; targetAudience?: string; whyBetter?: string }>;
  }>({
    purpose: 'creator_viral_breakdown',
    system: `你是顶级爆款短视频编导和文案拆解专家。
请用最接地气的大白话，把对标博主的爆款视频彻底拆透，让创作者 30 秒就能看懂它为什么爆、怎么用更好看的新角度进行原创二创。
要求：
1. 禁止空话套话，紧扣原视频内容和结构拆解。
2. remixAngles 给 3 个真正差异化、不抄袭、直接就能拿来拍的二创切入角度。
3. 只输出严格 JSON。`,
    user: `对标博主：${content.source_name}（平台：${content.platform}）
视频标题：${content.title}
爆款表现：${content.breakout_ratio ? `达到平时均值的 ${content.breakout_ratio} 倍` : '近期热门作品'} ${content.breakout_reason || ''}
素材类型：${hasTranscript ? '完整视频口播逐字稿' : '标题与简介（暂未提取完整口播）'}

原视频内容：
${sourceText || content.title}
${commentsBlock}

请输出 JSON：
{
  "hookAnalysis": "拆解前3~5秒是怎么留住人的（40~80字）",
  "structureSteps": [
    { "stage": "开头钩子", "summary": "他怎么讲的", "technique": "用到的留人技巧" },
    { "stage": "核心干货/反转", "summary": "中段怎么铺开", "technique": "信息密度或对比手法" },
    { "stage": "结尾引导", "summary": "怎么收尾引导点赞关注", "technique": "互动钩子" }
  ],
  "viralDrivers": ["爆点原因1（简短直白）", "爆点原因2", "爆点原因3"],
  "remixAngles": [
    {
      "title": "可直接用的二创新标题（18字内）",
      "angle": "二创切入角度说明（30字内）",
      "targetAudience": "最吸引哪类观众",
      "whyBetter": "比原视频更容易出彩的地方（25字内）"
    }
  ]
}`,
    temperature: 0.4,
    maxTokens: 1600,
    forceRefresh,
  });

  const breakdown: ViralBreakdown = {
    hookAnalysis: String(data.hookAnalysis || '').trim(),
    structureSteps: Array.isArray(data.structureSteps)
      ? data.structureSteps
          .map((s) => ({
            stage: String(s?.stage || '').trim(),
            summary: String(s?.summary || '').trim(),
            technique: String(s?.technique || '').trim(),
          }))
          .filter((s) => s.stage || s.summary)
      : [],
    viralDrivers: Array.isArray(data.viralDrivers)
      ? data.viralDrivers.map((x) => String(x || '').trim()).filter(Boolean)
      : [],
    remixAngles: Array.isArray(data.remixAngles)
      ? data.remixAngles
          .map((a) => ({
            title: String(a?.title || '').trim(),
            angle: String(a?.angle || '').trim(),
            targetAudience: String(a?.targetAudience || '').trim(),
            whyBetter: String(a?.whyBetter || '').trim(),
          }))
          .filter((a) => a.title || a.angle)
          .slice(0, 4)
      : [],
    usedTranscript: hasTranscript,
    analyzedAt: new Date().toISOString(),
  };

  const store = readRemixStore();
  const prev = store[String(contentId)] || { contentId, breakdown: null, drafts: [], updatedAt: '' };
  store[String(contentId)] = {
    ...prev,
    breakdown,
    updatedAt: new Date().toISOString(),
  };
  saveRemixStore(store);
  return breakdown;
}

// 步骤 B：按选定角度/口吻/时长，一键生成原创二创口播逐字稿（直接能对着提词器念）
export async function generateRemixScript(params: {
  contentId: number;
  angle: string;
  tone: string;
  lengthLabel: string;
  extraInstruction?: string;
  forceRefresh?: boolean;
}): Promise<RemixScriptDraft> {
  const db = getDb();
  const content = db
    .prepare(`
      SELECT c.id, c.title, c.platform, c.summary, c.body, c.transcript, s.name AS source_name
      FROM contents c
      JOIN sources s ON s.id = c.source_id
      WHERE c.id = ?
    `)
    .get(params.contentId) as
    | {
        id: number;
        title: string;
        platform: string;
        summary: string;
        body: string;
        transcript: string;
        source_name: string;
      }
    | undefined;
  if (!content) throw new Error('作品不存在');

  const sourceText =
    (content.transcript || '').trim().length >= 50
      ? content.transcript.slice(0, 4200)
      : `${content.summary || ''}\n${content.body || ''}`.trim().slice(0, 2200);

  const lengthSpec =
    params.lengthLabel === '60秒短视频'
      ? '约 240~320 字（节奏极快、句句干货，适合 60 秒竖屏口播）'
      : params.lengthLabel === '3分钟深度'
        ? '约 750~950 字（层层递进、举例充分，适合 3 分钟深度讲解）'
        : '约 480~620 字（黄金 2 分钟口播，结构清晰、干货扎实）';

  const { data } = await callAiJsonWithCache<{
    newTitle?: string;
    hookLine?: string;
    scriptText?: string;
    shootingTips?: string[];
    tags?: string[];
  }>({
    purpose: 'creator_remix_script',
    system: `你是百万粉短视频口播文案主笔，擅长借鉴对标爆款的成功结构和选题灵感，写出 100% 原创、自然口语化、直接能对着镜头念的二创口播逐字稿。
严格要求：
1. 绝对不要逐句照抄原博主的话！必须按用户指定的新角度和口吻重新组织逻辑、换案例、换表达，做到既保留爆款节奏又完全原创。
2. 口播正文（scriptText）必须是纯粹的「人话口语」，分自然段、无时间轴、无“【镜头1】”这种多余脚本标记，用户复制进提词器张嘴就能念。
3. 严禁 AI 翻译腔和“总而言之/综上所述/赋能/闭环”等假大空套话。
4. 只返回严格 JSON。`,
    user: `参考爆款原题：${content.title}（来自：${content.source_name}）
参考内容素材：
${sourceText || content.title}

我的二创要求：
- 切入角度：${params.angle || '保留核心话题但换一个更接地气、更痛点直击的新视角'}
- 说话口吻：${params.tone || '接地气大白话'}
- 目标时长与字数：${lengthSpec}
${params.extraInstruction ? `- 补充要求：${params.extraInstruction}` : ''}

请返回 JSON：
{
  "newTitle": "吸睛原创标题（15~26字）",
  "hookLine": "黄金前3秒开场第一句话（抓注意力）",
  "scriptText": "完整原创口播逐字稿（包含开场第一句、正文分段与自然结尾互动，纯口语无脚本标记）",
  "shootingTips": ["拍摄或画面建议1", "拍摄或画面建议2"],
  "tags": ["话题标签1", "话题标签2", "话题标签3", "话题标签4"]
}`,
    temperature: 0.6,
    maxTokens: 2200,
    forceRefresh: Boolean(params.forceRefresh),
  });

  const draft: RemixScriptDraft = {
    id: `rmx_${Date.now().toString(36)}`,
    angle: params.angle,
    tone: params.tone,
    lengthLabel: params.lengthLabel,
    newTitle: String(data.newTitle || content.title).trim(),
    hookLine: String(data.hookLine || '').trim(),
    scriptText: String(data.scriptText || '').trim(),
    shootingTips: Array.isArray(data.shootingTips)
      ? data.shootingTips.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 4)
      : [],
    tags: Array.isArray(data.tags)
      ? data.tags.map((x) => String(x || '').replace(/^#+/, '').trim()).filter(Boolean).slice(0, 6)
      : [],
    createdAt: new Date().toISOString(),
  };

  const store = readRemixStore();
  const prev = store[String(params.contentId)] || { contentId: params.contentId, breakdown: null, drafts: [], updatedAt: '' };
  prev.drafts = [draft, ...prev.drafts].slice(0, 8);
  prev.updatedAt = new Date().toISOString();
  store[String(params.contentId)] = prev;
  saveRemixStore(store);
  return draft;
}
