import { getDb } from '../db/database.js';
import { callAiJsonWithCache, getActiveAccount } from './aiRadarService.js';
import { proxySauJson } from './sauBridge.js';
import { log } from '../utils/logger.js';

export type CommentGuardMode = 'auto' | 'draft';
export type WarmupStyle = 'debate' | 'insight' | 'poll';
export type ReplyToneStyle = 'friendly' | 'sharp' | 'expert';

export interface CommentGuardSettings {
  enabled: boolean;
  mode: CommentGuardMode;
  enabledPlatforms: number[];
  warmupEnabled: boolean;
  warmupCount: number;
  warmupDelayMinutes: number;
  warmupSpacingMinSec: number;
  warmupSpacingMaxSec: number;
  warmupStyle: WarmupStyle;
  patrolIntervalMinutes: number;
  maxVideosPerPatrol: number;
  maxRepliesPerPatrol: number;
  dailyReplyCapPerPlatform: number;
  replySpacingMinSec: number;
  replySpacingMaxSec: number;
  activeHourStart: number;
  activeHourEnd: number;
  persona: string;
  toneStyle: ReplyToneStyle;
  spamKeywords: string[];
  forbiddenReplyWords: string[];
}

export interface WarmupCommentItem {
  text: string;
  angle: string;
  status: 'pending' | 'sent' | 'failed' | 'skipped';
  sentAt?: string;
  error?: string;
  postedCommentId?: string;
}

export interface WarmupJobRow {
  id: number;
  platform_type: number;
  account_name: string;
  platform_video_id: string;
  video_title: string;
  video_script: string;
  tags_json: string;
  comments_json: string;
  target_count: number;
  sent_count: number;
  mode: string;
  status: string;
  scheduled_for: string;
  retry_count: number;
  last_error: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreatorCommentRow {
  id: number;
  platform_type: number;
  account_name: string;
  platform_video_id: string;
  video_title: string;
  platform_comment_id: string;
  parent_comment_id: string;
  author_uid: string;
  author_name: string;
  comment_text: string;
  like_count: number;
  comment_created_at: string | null;
  is_author_comment: number;
  has_author_reply: number;
  reply_status: string;
  skip_reason: string;
  ai_reply_text: string;
  sent_reply_text: string;
  replied_at: string | null;
  last_error: string | null;
  discovered_at: string;
  updated_at: string;
}

export interface PlatformCapability {
  platformType: number;
  key: string;
  name: string;
  supported: boolean;
  reserved: boolean;
  note: string;
  accounts: Array<{ id: number; accountName: string; valid: boolean }>;
  hasAccount: boolean;
  hasValidAccount: boolean;
}

export const PLATFORM_NAMES: Record<number, string> = {
  1: '小红书',
  2: '微信视频号',
  3: '抖音',
  4: '快手',
};

export const SUPPORTED_LIVE_PLATFORMS = new Set<number>([3, 4]);

const SETTINGS_KEY = 'comment_guard_settings';
const LAST_PATROL_KEY = 'comment_guard_last_patrol_at';

export const DEFAULT_COMMENT_GUARD_SETTINGS: CommentGuardSettings = {
  enabled: true,
  mode: 'auto',
  enabledPlatforms: [3, 4],
  warmupEnabled: true,
  warmupCount: 3,
  warmupDelayMinutes: 3,
  warmupSpacingMinSec: 25,
  warmupSpacingMaxSec: 55,
  warmupStyle: 'debate',
  patrolIntervalMinutes: 20,
  maxVideosPerPatrol: 20,
  maxRepliesPerPatrol: 5,
  dailyReplyCapPerPlatform: 30,
  replySpacingMinSec: 12,
  replySpacingMaxSec: 28,
  activeHourStart: 0,
  activeHourEnd: 24,
  persona: '实战派科技与效率创作者，说话接地气、有主见、像朋友聊天一样回应粉丝，不端架子、不用“感谢您的评论”等官方模板话术',
  toneStyle: 'friendly',
  spamKeywords: [
    '加微',
    '加v',
    'vx',
    '微信',
    '私信领',
    '免费领',
    '日赚',
    '兼职',
    '互粉',
    '互赞',
    '互关',
    '刷单',
    '代发',
    '卖号',
    '点击主页',
    '置顶领',
    '领资料',
  ],
  forbiddenReplyWords: ['加我微信', '加微', '私信购买', '保证暴富', '百分百稳赚'],
};

let patrolRunning = false;
let warmupRunning = false;

function clampInt(val: unknown, fallback: number, min: number, max: number): number {
  const num = Number(val);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

function normalizeStringList(raw: unknown, fallback: string[]): string[] {
  if (Array.isArray(raw)) {
    return Array.from(
      new Set(
        raw
          .map((x) => String(x || '').trim())
          .filter(Boolean)
      )
    );
  }
  if (typeof raw === 'string') {
    return Array.from(
      new Set(
        raw
          .split(/[\n,，、;；]+/)
          .map((x) => x.trim())
          .filter(Boolean)
      )
    );
  }
  return [...fallback];
}

export function getCommentGuardSettings(): CommentGuardSettings {
  const db = getDb();
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(SETTINGS_KEY) as
    | { value?: string }
    | undefined;
  let parsed: Partial<CommentGuardSettings> = {};
  if (row?.value) {
    try {
      parsed = JSON.parse(row.value) as Partial<CommentGuardSettings>;
    } catch {
      parsed = {};
    }
  }

  const enabledPlatforms = Array.isArray(parsed.enabledPlatforms)
    ? Array.from(new Set(parsed.enabledPlatforms.map(Number).filter((n) => [1, 2, 3, 4].includes(n))))
    : [...DEFAULT_COMMENT_GUARD_SETTINGS.enabledPlatforms];

  const warmupSpacingMinSec = clampInt(
    parsed.warmupSpacingMinSec,
    DEFAULT_COMMENT_GUARD_SETTINGS.warmupSpacingMinSec,
    0,
    600
  );
  const warmupSpacingMaxSec = Math.max(
    warmupSpacingMinSec,
    clampInt(parsed.warmupSpacingMaxSec, DEFAULT_COMMENT_GUARD_SETTINGS.warmupSpacingMaxSec, 0, 900)
  );
  const replySpacingMinSec = clampInt(
    parsed.replySpacingMinSec,
    DEFAULT_COMMENT_GUARD_SETTINGS.replySpacingMinSec,
    0,
    300
  );
  const replySpacingMaxSec = Math.max(
    replySpacingMinSec,
    clampInt(parsed.replySpacingMaxSec, DEFAULT_COMMENT_GUARD_SETTINGS.replySpacingMaxSec, 0, 600)
  );

  return {
    enabled: parsed.enabled !== undefined ? Boolean(parsed.enabled) : DEFAULT_COMMENT_GUARD_SETTINGS.enabled,
    mode: parsed.mode === 'draft' ? 'draft' : 'auto',
    enabledPlatforms: enabledPlatforms.length > 0 ? enabledPlatforms : [3, 4],
    warmupEnabled:
      parsed.warmupEnabled !== undefined ? Boolean(parsed.warmupEnabled) : DEFAULT_COMMENT_GUARD_SETTINGS.warmupEnabled,
    warmupCount: clampInt(parsed.warmupCount, DEFAULT_COMMENT_GUARD_SETTINGS.warmupCount, 1, 3),
    warmupDelayMinutes: clampInt(parsed.warmupDelayMinutes, DEFAULT_COMMENT_GUARD_SETTINGS.warmupDelayMinutes, 0, 120),
    warmupSpacingMinSec,
    warmupSpacingMaxSec,
    warmupStyle:
      parsed.warmupStyle === 'insight' || parsed.warmupStyle === 'poll' ? parsed.warmupStyle : 'debate',
    patrolIntervalMinutes: clampInt(
      parsed.patrolIntervalMinutes,
      DEFAULT_COMMENT_GUARD_SETTINGS.patrolIntervalMinutes,
      5,
      180
    ),
    maxVideosPerPatrol: clampInt(parsed.maxVideosPerPatrol, DEFAULT_COMMENT_GUARD_SETTINGS.maxVideosPerPatrol, 3, 50),
    maxRepliesPerPatrol: clampInt(parsed.maxRepliesPerPatrol, DEFAULT_COMMENT_GUARD_SETTINGS.maxRepliesPerPatrol, 1, 20),
    dailyReplyCapPerPlatform: clampInt(
      parsed.dailyReplyCapPerPlatform,
      DEFAULT_COMMENT_GUARD_SETTINGS.dailyReplyCapPerPlatform,
      1,
      120
    ),
    replySpacingMinSec,
    replySpacingMaxSec,
    activeHourStart: clampInt(parsed.activeHourStart, DEFAULT_COMMENT_GUARD_SETTINGS.activeHourStart, 0, 23),
    activeHourEnd: clampInt(parsed.activeHourEnd, DEFAULT_COMMENT_GUARD_SETTINGS.activeHourEnd, 1, 24),
    persona:
      typeof parsed.persona === 'string' && parsed.persona.trim()
        ? parsed.persona.trim()
        : DEFAULT_COMMENT_GUARD_SETTINGS.persona,
    toneStyle:
      parsed.toneStyle === 'sharp' || parsed.toneStyle === 'expert' ? parsed.toneStyle : 'friendly',
    spamKeywords: normalizeStringList(parsed.spamKeywords, DEFAULT_COMMENT_GUARD_SETTINGS.spamKeywords),
    forbiddenReplyWords: normalizeStringList(
      parsed.forbiddenReplyWords,
      DEFAULT_COMMENT_GUARD_SETTINGS.forbiddenReplyWords
    ),
  };
}

export function updateCommentGuardSettings(patch: Partial<CommentGuardSettings>): CommentGuardSettings {
  const current = getCommentGuardSettings();
  const merged: CommentGuardSettings = {
    ...current,
    ...patch,
    spamKeywords:
      patch.spamKeywords !== undefined
        ? normalizeStringList(patch.spamKeywords, current.spamKeywords)
        : current.spamKeywords,
    forbiddenReplyWords:
      patch.forbiddenReplyWords !== undefined
        ? normalizeStringList(patch.forbiddenReplyWords, current.forbiddenReplyWords)
        : current.forbiddenReplyWords,
  };
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(SETTINGS_KEY, JSON.stringify(merged), now);
  const normalized = getCommentGuardSettings();
  appendGuardLog('config', null, 'INFO', '已更新评论托管规则设置', {
    enabled: normalized.enabled,
    mode: normalized.mode,
    patrolIntervalMinutes: normalized.patrolIntervalMinutes,
    warmupEnabled: normalized.warmupEnabled,
  });
  return normalized;
}

export function appendGuardLog(
  actionType: 'patrol' | 'warmup' | 'reply' | 'publish_hook' | 'config',
  platformType: number | null,
  level: 'INFO' | 'WARN' | 'ERROR',
  summary: string,
  detail: Record<string, unknown> = {}
): void {
  try {
    const db = getDb();
    db.prepare(
      `INSERT INTO comment_guard_logs (action_type, platform_type, level, summary, detail_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(actionType, platformType, level, summary, JSON.stringify(detail), new Date().toISOString());
    // 只保留最近 500 条日志，保持数据库轻巧
    db.prepare(
      `DELETE FROM comment_guard_logs WHERE id NOT IN (SELECT id FROM comment_guard_logs ORDER BY id DESC LIMIT 500)`
    ).run();
  } catch {
    // 忽略日志表写入失败
  }
  log(level, `comment-guard:${actionType}`, summary);
}

/**
 * 垃圾/广告/无意义符号评论检测（保留真实粉丝的短夸奖和真实提问）
 */
export function detectSpamComment(
  commentText: string,
  spamKeywords: string[]
): { isSpam: boolean; reason: string } {
  const text = String(commentText || '').trim();
  if (!text) return { isSpam: true, reason: '评论内容为空' };

  const lower = text.toLowerCase();
  for (const kw of spamKeywords) {
    const k = kw.trim().toLowerCase();
    if (k && lower.includes(k)) {
      return { isSpam: true, reason: `命中广告/引流屏蔽词「${kw}」` };
    }
  }

  // 含外链网址或长串数字微信号/手机号
  if (/(https?:\/\/|www\.|\.com\/|\.cn\/)/i.test(text)) {
    return { isSpam: true, reason: '疑似外链广告评论' };
  }
  if (/(?<!\d)(?:1[3-9]\d{9}|[0-9]{9,})(?!\d)/.test(text)) {
    return { isSpam: true, reason: '疑似留联系方式引流' };
  }

  // 纯表情、纯标点或纯单个无意义符号
  const meaningful = text.replace(/[\s\p{P}\p{S}\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\[\]0-9]+/gu, '');
  if (meaningful.length === 0) {
    return { isSpam: true, reason: '纯表情/符号评论，无需文字回复' };
  }

  return { isSpam: false, reason: '' };
}

function sanitizeReplyText(text: string, forbiddenWords: string[]): string {
  let cleaned = String(text || '')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/\r?\n+/g, ' ')
    .trim();
  for (const w of forbiddenWords) {
    const word = w.trim();
    if (word) {
      cleaned = cleaned.split(word).join('');
    }
  }
  return cleaned.trim().slice(0, 140);
}

function buildFallbackWarmupComments(
  videoTitle: string,
  count: number,
  style: WarmupStyle
): WarmupCommentItem[] {
  const cleanTitle = String(videoTitle || '这期内容')
    .replace(/#[^\s#]+/g, '')
    .trim()
    .slice(0, 26);
  const pool: WarmupCommentItem[] =
    style === 'poll'
      ? [
          {
            angle: '站队互动提问',
            text: `评论区站个队：聊到「${cleanTitle}」，你现在是已经动手试过，还是还在观望？`,
            status: 'pending',
          },
          {
            angle: '反方观点抛砖',
            text: '我猜肯定有人不同意我视频里最后那段判断，欢迎直接来反驳，说不定你踩过的坑比我更真实。',
            status: 'pending',
          },
          {
            angle: '经验征集补充',
            text: '你平时遇到类似问题最省事的做法是啥？打在评论区给后面看到的人抄个作业。',
            status: 'pending',
          },
        ]
      : style === 'insight'
        ? [
            {
              angle: '补充关键前提',
              text: `补一句视频里没展开的：「${cleanTitle}」最容易翻车的往往不是第一步，而是后面懒得复盘，你们有同感吗？`,
              status: 'pending',
            },
            {
              angle: '观点讨论反问',
              text: '老实说，我自己也是踩完两次坑才总结出这个结论，大家觉得这条在你们行业里管用吗？',
              status: 'pending',
            },
            {
              angle: '延伸追问',
              text: '如果下期顺着这个话题深挖一个实操案例，你们最想看哪一块？',
              status: 'pending',
            },
          ]
        : [
            {
              angle: '抛出争议观点',
              text: `说句可能会被杠的话：关于「${cleanTitle}」，我觉得90%的人一开始都使错劲了，你们实际体验是不是这样？`,
              status: 'pending',
            },
            {
              angle: '正反派站队',
              text: '好奇大家真实站哪边：是觉得早折腾早吃红利，还是等工具彻底成熟了再上车更香？评论区聊聊。',
              status: 'pending',
            },
            {
              angle: '作者反向追问',
              text: '这条我自己复盘时也在纠结要不要把话说这么直，如果你是过来人，你会给新手提哪条相反建议？',
              status: 'pending',
            },
          ];
  return pool.slice(0, Math.max(1, Math.min(3, count)));
}

/**
 * 为刚发布（或已有）视频生成 2~3 条能引发讨论的作者暖场评论
 */
export async function generateWarmupComments(params: {
  platformType: number;
  videoTitle: string;
  videoScript?: string;
  tags?: string[];
  count?: number;
  style?: WarmupStyle;
  forceRefresh?: boolean;
}): Promise<{ comments: WarmupCommentItem[]; usedAi: boolean; model: string }> {
  const settings = getCommentGuardSettings();
  const count = clampInt(params.count ?? settings.warmupCount, settings.warmupCount, 1, 3);
  const style: WarmupStyle = params.style || settings.warmupStyle;
  const platformName = PLATFORM_NAMES[params.platformType] || '短视频平台';

  const styleDesc =
    style === 'debate'
      ? '抛出有态度、有讨论张力的争议切口（让人忍不住想回复赞同或反驳，但绝不低俗引战、不违规）'
      : style === 'poll'
        ? '抛选择题/站队式轻松互动问题，降低评论门槛，引导大家晒自己经历'
        : '以作者补充一条犀利实战干货 + 反问收尾，引发同行与观众交流';

  const account = getActiveAccount();
  const personaText = settings.persona || account?.style_preferences || '务实真诚的创作者';

  const systemPrompt = [
    '你是短视频创作者本人的评论区运营搭档。',
    '任务：帮作者在刚发布的自己视频下面，写几条以【作者本人第一人称】发布的暖场讨论评论，让观众看到后忍不住参与争论或分享观点。',
    `作者人设与说话风格：${personaText}`,
    `目标平台：${platformName}；目标策略：${styleDesc}`,
    '硬性要求：',
    `1. 必须输出恰好 ${count} 条角度完全不同的评论，彼此不能重复套话。`,
    '2. 每条 18~68 字，像真人在手机上随手敲出来的口语，禁止书面腔、禁止“大家好/感谢观看/欢迎点赞关注”等机器人客套。',
    '3. 严禁假装路人或小号吹捧自己（绝不能说“博主讲得太好了”），必须是作者本人视角。',
    '4. 严禁违规引战、人身攻击、敏感政治、虚假承诺或营销导流词。',
    '5. 严格返回 JSON 对象：{"comments":[{"angle":"角度简述(4~8字)","text":"具体评论正文"}]}',
  ].join('\n');

  const userPrompt = [
    `视频标题：${params.videoTitle}`,
    params.videoScript ? `视频文案/简介：${params.videoScript.slice(0, 900)}` : '',
    params.tags && params.tags.length > 0 ? `话题标签：${params.tags.join(' / ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const res = await callAiJsonWithCache<{ comments?: Array<{ angle?: string; text?: string }> }>({
      purpose: 'comment_guard_warmup',
      system: systemPrompt,
      user: userPrompt,
      temperature: 0.75,
      maxTokens: 700,
      forceRefresh: Boolean(params.forceRefresh),
    });
    const list = Array.isArray(res.data?.comments) ? res.data.comments : [];
    const cleaned: WarmupCommentItem[] = list
      .map((it) => ({
        angle: String(it?.angle || '讨论引子').trim().slice(0, 16),
        text: sanitizeReplyText(String(it?.text || ''), settings.forbiddenReplyWords),
        status: 'pending' as const,
      }))
      .filter((it) => it.text.length >= 6);

    if (cleaned.length >= 1) {
      const padded =
        cleaned.length >= count
          ? cleaned.slice(0, count)
          : [...cleaned, ...buildFallbackWarmupComments(params.videoTitle, count - cleaned.length, style)];
      return { comments: padded, usedAi: true, model: res.model };
    }
  } catch (err) {
    log('WARN', 'comment-guard', `AI 生成暖评降级规则兜底: ${(err as Error).message}`);
  }

  return {
    comments: buildFallbackWarmupComments(params.videoTitle, count, style),
    usedAi: false,
    model: 'fallback-rule',
  };
}

function buildFallbackFanReply(commentText: string, toneStyle: ReplyToneStyle): string {
  const txt = String(commentText || '');
  if (/[？?怎么如何哪里什么哪个]/.test(txt)) {
    return toneStyle === 'sharp'
      ? '问到点子上了，这块确实最容易踩坑，你现在卡在具体哪一步了？展开说说。'
      : '这个问题挺实在的，你目前具体卡在哪一步？可以细说一下我看看怎么帮你拆解。';
  }
  if (/不重要|不对|不同意|胡说|扯|太片面|不一定/.test(txt)) {
    return '你这个角度挺有意思的，确实不同场景体感差别很大，你平时实战里更看重哪一块？';
  }
  return toneStyle === 'expert'
    ? '说到点上了，实际落地时确实是这么回事，你平时有自己的顺手经验也可以一起聊聊。'
    : '哈哈确实是这样，你平时遇到类似情况一般怎么处理的？';
}

/**
 * 结合视频主题、作者人设和粉丝评论内容，生成自然拟人的作者回复
 */
export async function generateFanCommentReply(params: {
  platformType: number;
  videoTitle: string;
  videoDescription?: string;
  authorName: string;
  commentText: string;
  parentCommentText?: string;
  forceRefresh?: boolean;
}): Promise<{ replyText: string; usedAi: boolean; model: string }> {
  const settings = getCommentGuardSettings();
  const platformName = PLATFORM_NAMES[params.platformType] || '短视频平台';
  const toneDesc =
    settings.toneStyle === 'sharp'
      ? '直接有主见、幽默接梗，遇到反对观点不卑不亢地顺着聊深一层'
      : settings.toneStyle === 'expert'
        ? '务实专业、一针见血给出有价值的补充，顺手抛个小追问延续互动'
        : '真诚接地气、像朋友聊天一样回应，顺带自然引出一句互动延续讨论';

  const systemPrompt = [
    '你是短视频创作者本人，正在回复自己视频下方的粉丝评论。',
    `作者人设：${settings.persona}`,
    `目标平台：${platformName}；回复风格：${toneDesc}`,
    '硬性要求：',
    '1. 回复必须紧扣粉丝说的具体观点或问题，绝不说空洞套话（严禁“感谢您的评论/感谢支持/欢迎关注”）。',
    '2. 字数控制在 15~65 字，口语自然，像真人手机打字，不要用序号分点。',
    '3. 如果粉丝提出质疑或补充观点，先真诚接住对方有道理的地方，再自然补充你的看法或反问一句，鼓励对方继续聊。',
    '4. 严禁出现营销导流、联系方式、违规词或攻击辱骂。',
    '5. 严格返回 JSON 对象：{"reply":"回复正文"}',
  ].join('\n');

  const userPrompt = [
    `视频标题：${params.videoTitle}`,
    params.videoDescription ? `视频简介：${params.videoDescription.slice(0, 300)}` : '',
    params.parentCommentText ? `原一级评论：${params.parentCommentText}` : '',
    `粉丝昵称：${params.authorName}`,
    `粉丝评论：${params.commentText}`,
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const res = await callAiJsonWithCache<{ reply?: string }>({
      purpose: 'comment_guard_reply',
      system: systemPrompt,
      user: userPrompt,
      temperature: 0.65,
      maxTokens: 300,
      forceRefresh: Boolean(params.forceRefresh),
    });
    const reply = sanitizeReplyText(String(res.data?.reply || ''), settings.forbiddenReplyWords);
    if (reply.length >= 4) {
      return { replyText: reply, usedAi: true, model: res.model };
    }
  } catch (err) {
    log('WARN', 'comment-guard', `AI 生成评论回复降级兜底: ${(err as Error).message}`);
  }

  return {
    replyText: sanitizeReplyText(buildFallbackFanReply(params.commentText, settings.toneStyle), settings.forbiddenReplyWords),
    usedAi: false,
    model: 'fallback-rule',
  };
}

function getTodayUtcPrefix(): string {
  return new Date().toISOString().slice(0, 10);
}

function getDailyRepliedCount(platformType: number): number {
  const db = getDb();
  const today = `${getTodayUtcPrefix()}%`;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM creator_video_comments
       WHERE platform_type = ? AND reply_status = 'replied' AND replied_at LIKE ?`
    )
    .get(platformType, today) as { c: number };
  return Number(row?.c || 0);
}

function randomDelayMs(minSec: number, maxSec: number): number {
  const lo = Math.max(0, minSec);
  const hi = Math.max(lo, maxSec);
  if (hi <= 0) return 0;
  return Math.round((lo + Math.random() * (hi - lo)) * 1000);
}

async function sleepMs(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function parseScheduledPublishTime(payload: Record<string, unknown>, delayMinutes: number): string {
  const delayMs = Math.max(0, delayMinutes) * 60_000;
  const enableTimer = Boolean(payload.enableTimer);
  if (!enableTimer) {
    return new Date(Date.now() + delayMs).toISOString();
  }

  const rawAt = payload.scheduleAt;
  if (typeof rawAt === 'string' && rawAt.trim()) {
    const parsed = Date.parse(rawAt.trim().replace(' ', 'T'));
    if (Number.isFinite(parsed)) {
      return new Date(parsed + delayMs).toISOString();
    }
  }
  if (Array.isArray(rawAt) && rawAt.length > 0 && typeof rawAt[0] === 'string') {
    const parsed = Date.parse(rawAt[0].trim().replace(' ', 'T'));
    if (Number.isFinite(parsed)) {
      return new Date(parsed + delayMs).toISOString();
    }
  }

  // 兜底：若按天排期（startDays + dailyTimes），按最早排期点后顺延 delayMinutes
  const dailyTimes = Array.isArray(payload.dailyTimes) ? payload.dailyTimes : [];
  const firstTime = typeof dailyTimes[0] === 'string' ? dailyTimes[0].trim() : '';
  const match = /^(\d{1,2}):(\d{2})$/.exec(firstTime);
  if (match) {
    const startDays = Number(payload.startDays || 0);
    const dt = new Date();
    dt.setDate(dt.getDate() + Math.max(0, startDays) + 1);
    dt.setHours(Number(match[1]), Number(match[2]), 0, 0);
    return new Date(dt.getTime() + delayMs).toISOString();
  }

  return new Date(Date.now() + 2 * 3600_000 + delayMs).toISOString();
}

/**
 * 发布成功后自动挂钩：为刚发出的视频创建 2~3 条讨论型暖场评论任务
 */
export async function hookPostPublishWarmup(payload: Record<string, unknown>): Promise<{
  queued: boolean;
  jobId?: number;
  reason?: string;
}> {
  const settings = getCommentGuardSettings();
  if (!settings.enabled || !settings.warmupEnabled) {
    return { queued: false, reason: '暖场评论托管当前已关闭' };
  }
  if (payload.autoWarmup === false) {
    return { queued: false, reason: '本次发布已关闭自动暖评' };
  }
  if (payload.isDraft) {
    return { queued: false, reason: '草稿发布不触发暖场评论' };
  }

  const platformType = Number(payload.type || 0);
  if (![1, 2, 3, 4].includes(platformType)) {
    return { queued: false, reason: `平台 ${platformType} 暂不接入评论托管` };
  }
  if (!settings.enabledPlatforms.includes(platformType)) {
    return { queued: false, reason: `${PLATFORM_NAMES[platformType]}未在评论托管启用列表中` };
  }
  if (!SUPPORTED_LIVE_PLATFORMS.has(platformType)) {
    appendGuardLog('publish_hook', platformType, 'INFO', `${PLATFORM_NAMES[platformType]}暖评通道已预留，本次发布暂不自动发暖评`, {
      title: String(payload.title || ''),
    });
    return { queued: false, reason: `${PLATFORM_NAMES[platformType]}为预留平台` };
  }

  const videoTitle = String(payload.title || '').trim();
  const videoScript = String(payload.description || payload.rawCopy || '').trim();
  const tags = Array.isArray(payload.tags) ? payload.tags.map((t) => String(t).trim()).filter(Boolean) : [];
  if (!videoTitle) {
    return { queued: false, reason: '缺少视频标题' };
  }

  const db = getDb();
  // 10 分钟内同平台同标题防重复入队
  const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
  const dup = db
    .prepare(
      `SELECT id FROM comment_warmup_jobs
       WHERE platform_type = ? AND video_title = ? AND created_at >= ? AND status NOT IN ('cancelled', 'failed')
       LIMIT 1`
    )
    .get(platformType, videoTitle, tenMinAgo) as { id: number } | undefined;
  if (dup) {
    return { queued: false, jobId: dup.id, reason: '相同视频暖评任务已在队列中' };
  }

  const scheduledFor = parseScheduledPublishTime(payload, settings.warmupDelayMinutes);
  const generated = await generateWarmupComments({
    platformType,
    videoTitle,
    videoScript,
    tags,
    count: settings.warmupCount,
    style: settings.warmupStyle,
    forceRefresh: true,
  });

  const jobStatus = settings.mode === 'draft' ? 'pending_approval' : 'queued';
  const now = new Date().toISOString();
  const res = db
    .prepare(
      `INSERT INTO comment_warmup_jobs (
        platform_type, account_name, platform_video_id, video_title, video_script, tags_json,
        comments_json, target_count, sent_count, mode, status, scheduled_for, created_at, updated_at
      ) VALUES (?, ?, '', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`
    )
    .run(
      platformType,
      String(payload.accountName || ''),
      videoTitle,
      videoScript,
      JSON.stringify(tags),
      JSON.stringify(generated.comments),
      generated.comments.length,
      settings.mode,
      jobStatus,
      scheduledFor,
      now,
      now
    );

  const jobId = Number(res.lastInsertRowid);
  appendGuardLog(
    'publish_hook',
    platformType,
    'INFO',
    `视频「${videoTitle.slice(0, 24)}」已自动排队 ${generated.comments.length} 条暖场评论（${jobStatus === 'queued' ? `${settings.warmupDelayMinutes}分钟后自动发出` : '待你确认发出'}）`,
    { jobId, scheduledFor, usedAi: generated.usedAi }
  );
  return { queued: true, jobId };
}

export async function createManualWarmupJob(params: {
  platformType: number;
  accountName?: string;
  videoId?: string;
  videoTitle: string;
  videoScript?: string;
  tags?: string[];
  comments?: Array<{ text: string; angle?: string }>;
  count?: number;
  style?: WarmupStyle;
  sendNow?: boolean;
  dryRun?: boolean;
}): Promise<{ job: WarmupJobRow; runResult?: Record<string, unknown> }> {
  const settings = getCommentGuardSettings();
  const platformType = Number(params.platformType);
  if (![1, 2, 3, 4].includes(platformType)) {
    throw new Error('不支持的平台类型');
  }
  const videoTitle = String(params.videoTitle || '').trim();
  if (!videoTitle) {
    throw new Error('请填写或选择目标视频标题');
  }

  let items: WarmupCommentItem[];
  if (Array.isArray(params.comments) && params.comments.length > 0) {
    items = params.comments
      .map((c) => ({
        text: sanitizeReplyText(c.text, settings.forbiddenReplyWords),
        angle: String(c.angle || '自定义暖评').trim() || '自定义暖评',
        status: 'pending' as const,
      }))
      .filter((c) => c.text.length > 0)
      .slice(0, 3);
    if (items.length === 0) throw new Error('至少需要一条有效暖场评论内容');
  } else {
    const gen = await generateWarmupComments({
      platformType,
      videoTitle,
      videoScript: params.videoScript,
      tags: params.tags,
      count: params.count ?? settings.warmupCount,
      style: params.style ?? settings.warmupStyle,
      forceRefresh: true,
    });
    items = gen.comments;
  }

  const now = new Date().toISOString();
  const status = params.sendNow ? 'queued' : settings.mode === 'draft' ? 'pending_approval' : 'queued';
  const db = getDb();
  const res = db
    .prepare(
      `INSERT INTO comment_warmup_jobs (
        platform_type, account_name, platform_video_id, video_title, video_script, tags_json,
        comments_json, target_count, sent_count, mode, status, scheduled_for, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`
    )
    .run(
      platformType,
      String(params.accountName || ''),
      String(params.videoId || ''),
      videoTitle,
      String(params.videoScript || ''),
      JSON.stringify(params.tags || []),
      JSON.stringify(items),
      items.length,
      params.sendNow ? 'auto' : settings.mode,
      status,
      now,
      now,
      now
    );

  const jobId = Number(res.lastInsertRowid);
  let runResult: Record<string, unknown> | undefined;
  if (params.sendNow) {
    runResult = await executeWarmupJobById(jobId, { dryRun: Boolean(params.dryRun), skipSpacing: Boolean(params.dryRun) });
  }
  const job = db.prepare('SELECT * FROM comment_warmup_jobs WHERE id = ?').get(jobId) as unknown as WarmupJobRow;
  return { job, runResult };
}

/**
 * 执行单条暖评队列任务（逐条发完落库，支持审核期自动重试与防重复）
 */
export async function executeWarmupJobById(
  jobId: number,
  options?: { dryRun?: boolean; skipSpacing?: boolean }
): Promise<{
  ok: boolean;
  jobId: number;
  status: string;
  sentCount: number;
  message: string;
}> {
  const db = getDb();
  const job = db.prepare('SELECT * FROM comment_warmup_jobs WHERE id = ?').get(jobId) as WarmupJobRow | undefined;
  if (!job) {
    return { ok: false, jobId, status: 'not_found', sentCount: 0, message: '暖评任务不存在' };
  }
  if (job.status === 'done' || job.status === 'cancelled') {
    return { ok: true, jobId, status: job.status, sentCount: job.sent_count, message: '任务已结束' };
  }

  const settings = getCommentGuardSettings();
  let items: WarmupCommentItem[] = [];
  try {
    items = JSON.parse(job.comments_json || '[]') as WarmupCommentItem[];
  } catch {
    items = [];
  }
  if (items.length === 0) {
    const gen = await generateWarmupComments({
      platformType: job.platform_type,
      videoTitle: job.video_title,
      videoScript: job.video_script,
      count: job.target_count || settings.warmupCount,
      style: settings.warmupStyle,
    });
    items = gen.comments;
  }

  const nowStart = new Date().toISOString();
  db.prepare(`UPDATE comment_warmup_jobs SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?`).run(
    nowStart,
    nowStart,
    jobId
  );

  let sentCount = items.filter((it) => it.status === 'sent').length;
  let retryableDeferred = false;
  let lastError = '';
  let postedThisRun = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.status === 'sent' || item.status === 'skipped') continue;

    // 2~3 条暖评之间加随机真人间隔，降低平台风控
    if (postedThisRun > 0 && !options?.skipSpacing) {
      const waitMs = randomDelayMs(settings.warmupSpacingMinSec, settings.warmupSpacingMaxSec);
      await sleepMs(waitMs);
    }

    const res = await proxySauJson(
      'POST',
      '/comments/post',
      {
        type: job.platform_type,
        accountName: job.account_name || '',
        videoId: job.platform_video_id || '',
        videoTitle: job.video_title,
        commentText: item.text,
        dryRun: Boolean(options?.dryRun),
      },
      120000
    );

    const body = (res.payload || {}) as { code?: number; msg?: string; data?: Record<string, unknown> };
    const data = body.data || {};
    const ok = res.status === 200 && Boolean(data.ok ?? body.code === 200);

    if (ok) {
      if (!options?.dryRun) {
        item.status = 'sent';
        item.sentAt = new Date().toISOString();
        item.error = undefined;
        if (data.posted_comment_id) item.postedCommentId = String(data.posted_comment_id);
        sentCount += 1;
      }
      postedThisRun += 1;
      if (data.video_id && !job.platform_video_id) {
        db.prepare('UPDATE comment_warmup_jobs SET platform_video_id = ? WHERE id = ?').run(String(data.video_id), jobId);
      }
    } else {
      lastError = String(data.message || body.msg || `发送失败(${res.status})`);
      if (data.retryable && job.retry_count < 4 && !options?.dryRun) {
        retryableDeferred = true;
        break;
      }
      item.status = 'failed';
      item.error = lastError;
    }

    // 每发完一条立即落库进度，断电或重启也不重复发
    db.prepare(`UPDATE comment_warmup_jobs SET comments_json = ?, sent_count = ?, updated_at = ? WHERE id = ?`).run(
      JSON.stringify(items),
      sentCount,
      new Date().toISOString(),
      jobId
    );
  }

  const nowEnd = new Date().toISOString();
  if (options?.dryRun) {
    db.prepare(`UPDATE comment_warmup_jobs SET status = ?, updated_at = ? WHERE id = ?`).run(
      job.status === 'running' ? 'queued' : job.status,
      nowEnd,
      jobId
    );
    return {
      ok: postedThisRun > 0,
      jobId,
      status: 'dry_run',
      sentCount: postedThisRun,
      message: postedThisRun > 0 ? `暖评通道预检通过（模拟验证 ${postedThisRun} 条，未公开发送）` : lastError || '预检未通过',
    };
  }

  if (retryableDeferred) {
    const nextRetryAt = new Date(Date.now() + 4 * 60_000).toISOString();
    db.prepare(
      `UPDATE comment_warmup_jobs
       SET status = 'queued', retry_count = retry_count + 1, scheduled_for = ?, last_error = ?, updated_at = ?
       WHERE id = ?`
    ).run(nextRetryAt, lastError, nowEnd, jobId);
    appendGuardLog('warmup', job.platform_type, 'WARN', `视频「${job.video_title.slice(0, 20)}」仍在平台审核中，4 分钟后自动重试暖评`, {
      jobId,
      lastError,
    });
    return { ok: false, jobId, status: 'queued', sentCount, message: `视频尚在审核，已自动延后 4 分钟重试` };
  }

  const allSent = items.every((it) => it.status === 'sent' || it.status === 'skipped');
  const finalStatus = allSent ? 'done' : sentCount > 0 ? 'partial' : 'failed';
  db.prepare(
    `UPDATE comment_warmup_jobs
     SET status = ?, comments_json = ?, sent_count = ?, last_error = ?, finished_at = ?, updated_at = ?
     WHERE id = ?`
  ).run(finalStatus, JSON.stringify(items), sentCount, lastError || null, nowEnd, nowEnd, jobId);

  if (job.platform_video_id) {
    db.prepare(
      `UPDATE creator_published_videos SET warmup_status = ?, updated_at = ? WHERE platform_type = ? AND platform_video_id = ?`
    ).run(finalStatus === 'done' ? 'done' : finalStatus, nowEnd, job.platform_type, job.platform_video_id);
  }

  appendGuardLog(
    'warmup',
    job.platform_type,
    finalStatus === 'failed' ? 'ERROR' : 'INFO',
    `暖场评论执行完毕「${job.video_title.slice(0, 22)}」：成功 ${sentCount}/${items.length} 条${lastError ? `（${lastError}）` : ''}`,
    { jobId, finalStatus, sentCount }
  );

  return {
    ok: finalStatus === 'done' || finalStatus === 'partial',
    jobId,
    status: finalStatus,
    sentCount,
    message:
      finalStatus === 'done'
        ? `暖场评论已全部发出（共 ${sentCount} 条）`
        : finalStatus === 'partial'
          ? `暖场评论部分发出（${sentCount}/${items.length} 条）：${lastError}`
          : `暖场评论发送失败：${lastError}`,
  };
}

export async function processDueWarmupJobs(options?: { skipSpacing?: boolean }): Promise<number> {
  if (warmupRunning) return 0;
  const settings = getCommentGuardSettings();
  if (!settings.enabled || !settings.warmupEnabled) return 0;

  warmupRunning = true;
  let processed = 0;
  try {
    const db = getDb();
    const now = new Date().toISOString();
    const dueJobs = db
      .prepare(
        `SELECT id FROM comment_warmup_jobs
         WHERE status = 'queued' AND scheduled_for <= ?
         ORDER BY scheduled_for ASC, id ASC
         LIMIT 3`
      )
      .all(now) as Array<{ id: number }>;

    for (const row of dueJobs) {
      await executeWarmupJobById(row.id, { skipSpacing: options?.skipSpacing });
      processed += 1;
    }
  } finally {
    warmupRunning = false;
  }
  return processed;
}

export async function fetchPlatformCapabilities(): Promise<PlatformCapability[]> {
  try {
    const res = await proxySauJson('GET', '/comments/capabilities', undefined, 8000);
    const body = (res.payload || {}) as { code?: number; data?: PlatformCapability[] };
    if (res.status === 200 && Array.isArray(body.data)) {
      return body.data;
    }
  } catch {
    // 引擎离线时返回静态能力清单
  }
  return [
    { platformType: 3, key: 'douyin', name: '抖音', supported: true, reserved: false, note: '等待发布引擎就绪', accounts: [], hasAccount: false, hasValidAccount: false },
    { platformType: 4, key: 'kuaishou', name: '快手', supported: true, reserved: false, note: '等待发布引擎就绪', accounts: [], hasAccount: false, hasValidAccount: false },
    { platformType: 1, key: 'xiaohongshu', name: '小红书', supported: false, reserved: true, note: '已预留接口与开关位，扫码绑定后即可扩展启用', accounts: [], hasAccount: false, hasValidAccount: false },
    { platformType: 2, key: 'tencent', name: '微信视频号', supported: false, reserved: true, note: '已预留接口与开关位，扫码绑定后即可扩展启用', accounts: [], hasAccount: false, hasValidAccount: false },
  ];
}

/**
 * 同步各平台已发布作品与评论，并按规则执行防风控过滤与 AI 自动回复（或生成草稿）
 */
export async function runCommentPatrol(options?: {
  manual?: boolean;
  platforms?: number[];
  dryRun?: boolean;
  syncOnly?: boolean;
  skipSpacing?: boolean;
}): Promise<{
  ok: boolean;
  skipped?: boolean;
  message: string;
  syncedVideos: number;
  discoveredComments: number;
  repliedCount: number;
  draftCount: number;
  spamSkippedCount: number;
  platformResults: Array<{
    platformType: number;
    platformName: string;
    ok: boolean;
    message: string;
    videos: number;
    newComments: number;
    replied: number;
  }>;
}> {
  if (patrolRunning) {
    return {
      ok: false,
      skipped: true,
      message: '评论巡检正在进行中，请稍候完成',
      syncedVideos: 0,
      discoveredComments: 0,
      repliedCount: 0,
      draftCount: 0,
      spamSkippedCount: 0,
      platformResults: [],
    };
  }

  const settings = getCommentGuardSettings();
  if (!options?.manual && !settings.enabled) {
    return {
      ok: true,
      skipped: true,
      message: '评论托管总开关已暂停',
      syncedVideos: 0,
      discoveredComments: 0,
      repliedCount: 0,
      draftCount: 0,
      spamSkippedCount: 0,
      platformResults: [],
    };
  }

  // 非手动触发时遵守活跃时段
  if (!options?.manual && (settings.activeHourStart > 0 || settings.activeHourEnd < 24)) {
    const h = new Date().getHours();
    if (h < settings.activeHourStart || h >= settings.activeHourEnd) {
      return {
        ok: true,
        skipped: true,
        message: '当前处于静默时段，跳过自动巡检',
        syncedVideos: 0,
        discoveredComments: 0,
        repliedCount: 0,
        draftCount: 0,
        spamSkippedCount: 0,
        platformResults: [],
      };
    }
  }

  patrolRunning = true;
  const db = getDb();
  const now = new Date().toISOString();
  let syncedVideos = 0;
  let discoveredComments = 0;
  let repliedCount = 0;
  let draftCount = 0;
  let spamSkippedCount = 0;
  const platformResults: Array<{
    platformType: number;
    platformName: string;
    ok: boolean;
    message: string;
    videos: number;
    newComments: number;
    replied: number;
  }> = [];

  try {
    const caps = await fetchPlatformCapabilities();
    const requested = options?.platforms && options.platforms.length > 0 ? options.platforms : settings.enabledPlatforms;
    const targetPlatforms = requested.filter((p) => SUPPORTED_LIVE_PLATFORMS.has(p));

    for (const ptype of targetPlatforms) {
      const pName = PLATFORM_NAMES[ptype] || `平台(${ptype})`;
      const cap = caps.find((c) => c.platformType === ptype);
      if (cap && !cap.hasAccount) {
        platformResults.push({
          platformType: ptype,
          platformName: pName,
          ok: false,
          message: `尚未绑定${pName}账号，跳过巡检`,
          videos: 0,
          newComments: 0,
          replied: 0,
        });
        continue;
      }

      const syncRes = await proxySauJson(
        'POST',
        '/comments/sync',
        { type: ptype, maxVideos: settings.maxVideosPerPatrol },
        150000
      );
      const syncBody = (syncRes.payload || {}) as { code?: number; msg?: string; data?: Record<string, unknown> };
      const data = syncBody.data || {};
      if (syncRes.status !== 200 || !data.ok) {
        const errMsg = String(data.message || syncBody.msg || `同步失败(${syncRes.status})`);
        appendGuardLog('patrol', ptype, 'WARN', `${pName}评论巡检失败：${errMsg}`);
        platformResults.push({
          platformType: ptype,
          platformName: pName,
          ok: false,
          message: errMsg,
          videos: 0,
          newComments: 0,
          replied: 0,
        });
        continue;
      }

      const accountName = String(data.account_name || '');
      const videos = Array.isArray(data.videos) ? (data.videos as Array<Record<string, unknown>>) : [];
      const comments = Array.isArray(data.comments) ? (data.comments as Array<Record<string, unknown>>) : [];
      const ts = new Date().toISOString();

      // 1. 写入/更新自有已发布作品
      const upsertVideoStmt = db.prepare(`
        INSERT INTO creator_published_videos (
          platform_type, account_name, platform_video_id, title, description, cover_url, video_url,
          published_at, comment_count, like_count, play_count, last_synced_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(platform_type, platform_video_id) DO UPDATE SET
          account_name = excluded.account_name,
          title = CASE WHEN excluded.title != '' THEN excluded.title ELSE creator_published_videos.title END,
          cover_url = CASE WHEN excluded.cover_url != '' THEN excluded.cover_url ELSE creator_published_videos.cover_url END,
          video_url = CASE WHEN excluded.video_url != '' THEN excluded.video_url ELSE creator_published_videos.video_url END,
          published_at = COALESCE(NULLIF(excluded.published_at, ''), creator_published_videos.published_at),
          comment_count = excluded.comment_count,
          like_count = excluded.like_count,
          play_count = excluded.play_count,
          last_synced_at = excluded.last_synced_at,
          updated_at = excluded.updated_at
      `);

      for (const v of videos) {
        const vid = String(v.video_id || '').trim();
        if (!vid) continue;
        upsertVideoStmt.run(
          ptype,
          accountName,
          vid,
          String(v.title || ''),
          String(v.cover_url || ''),
          String(v.video_url || ''),
          String(v.published_at || ''),
          Number(v.comment_count || 0),
          Number(v.like_count || 0),
          Number(v.play_count || 0),
          ts,
          ts,
          ts
        );
      }
      syncedVideos += videos.length;

      // 2. 写入新发现的评论（按 platform_type + platform_comment_id 严格去重，绝不覆盖已回复记录）
      let pNewComments = 0;
      const commentByPlatformId = new Map<string, Record<string, unknown>>();
      for (const c of comments) {
        const cid = String(c.comment_id || '').trim();
        if (cid) commentByPlatformId.set(cid, c);
      }

      for (const c of comments) {
        const cid = String(c.comment_id || '').trim();
        const vid = String(c.video_id || '').trim();
        const cText = String(c.text || '').trim();
        if (!cid || !vid || !cText) continue;

        const existing = db
          .prepare('SELECT id, reply_status FROM creator_video_comments WHERE platform_type = ? AND platform_comment_id = ?')
          .get(ptype, cid) as { id: number; reply_status: string } | undefined;

        const isAuthor = c.is_author ? 1 : 0;
        const hasAuthorReply = c.has_author_reply ? 1 : 0;

        if (existing) {
          // 若平台侧检测到作者已手动回复，且本地仍处于 pending/draft_ready，则同步标为 skipped_already_replied 防重回
          if (hasAuthorReply && (existing.reply_status === 'pending' || existing.reply_status === 'draft_ready')) {
            db.prepare(
              `UPDATE creator_video_comments
               SET has_author_reply = 1, reply_status = 'skipped_already_replied', skip_reason = '检测到作者已在平台回复', updated_at = ?
               WHERE id = ?`
            ).run(ts, existing.id);
          }
          continue;
        }

        let initialStatus = 'pending';
        let skipReason = '';
        if (isAuthor) {
          initialStatus = 'skipped_author';
          skipReason = '作者本人评论';
        } else if (hasAuthorReply) {
          initialStatus = 'skipped_already_replied';
          skipReason = '平台已有作者回复';
        } else {
          const spamCheck = detectSpamComment(cText, settings.spamKeywords);
          if (spamCheck.isSpam) {
            initialStatus = 'skipped_spam';
            skipReason = spamCheck.reason;
            spamSkippedCount += 1;
          }
        }

        db.prepare(
          `INSERT INTO creator_video_comments (
            platform_type, account_name, platform_video_id, video_title, platform_comment_id,
            parent_comment_id, author_uid, author_name, comment_text, like_count, comment_created_at,
            is_author_comment, has_author_reply, reply_status, skip_reason, discovered_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          ptype,
          accountName,
          vid,
          String(c.video_title || ''),
          cid,
          String(c.parent_comment_id || ''),
          String(c.author_uid || ''),
          String(c.author_name || '粉丝'),
          cText,
          Number(c.like_count || 0),
          String(c.created_at || ''),
          isAuthor,
          hasAuthorReply,
          initialStatus,
          skipReason,
          ts,
          ts
        );
        pNewComments += 1;
        discoveredComments += 1;
      }

      // 3. 针对待回复粉丝评论，生成 AI 回复并在全自动模式下限速发出
      let pReplied = 0;
      if (!options?.syncOnly) {
        const dailyUsed = getDailyRepliedCount(ptype);
        const dailyRemaining = Math.max(0, settings.dailyReplyCapPerPlatform - dailyUsed);
        const batchQuota = Math.min(settings.maxRepliesPerPatrol, dailyRemaining);

        const pendingRows = db
          .prepare(
            `SELECT * FROM creator_video_comments
             WHERE platform_type = ? AND reply_status = 'pending' AND is_author_comment = 0
             ORDER BY discovered_at ASC, id ASC
             LIMIT ?`
          )
          .all(ptype, Math.max(batchQuota, settings.mode === 'draft' ? settings.maxRepliesPerPatrol : batchQuota)) as unknown as CreatorCommentRow[];

        for (let idx = 0; idx < pendingRows.length; idx++) {
          const row = pendingRows[idx];
          // 二次确认没有命中最新屏蔽词
          const spamCheck = detectSpamComment(row.comment_text, settings.spamKeywords);
          if (spamCheck.isSpam) {
            db.prepare(
              `UPDATE creator_video_comments SET reply_status = 'skipped_spam', skip_reason = ?, updated_at = ? WHERE id = ?`
            ).run(spamCheck.reason, new Date().toISOString(), row.id);
            spamSkippedCount += 1;
            continue;
          }

          let parentText = '';
          if (row.parent_comment_id) {
            const pRow = db
              .prepare('SELECT comment_text FROM creator_video_comments WHERE platform_type = ? AND platform_comment_id = ?')
              .get(ptype, row.parent_comment_id) as { comment_text?: string } | undefined;
            parentText = pRow?.comment_text || String(commentByPlatformId.get(row.parent_comment_id)?.text || '');
          }

          const gen = await generateFanCommentReply({
            platformType: ptype,
            videoTitle: row.video_title,
            authorName: row.author_name,
            commentText: row.comment_text,
            parentCommentText: parentText,
          });

          const stepNow = new Date().toISOString();
          if (settings.mode === 'draft' || options?.dryRun) {
            db.prepare(
              `UPDATE creator_video_comments SET ai_reply_text = ?, reply_status = 'draft_ready', updated_at = ? WHERE id = ?`
            ).run(gen.replyText, stepNow, row.id);
            draftCount += 1;
            continue;
          }

          if (pReplied >= batchQuota) {
            db.prepare(
              `UPDATE creator_video_comments SET ai_reply_text = ?, reply_status = 'draft_ready', updated_at = ? WHERE id = ?`
            ).run(gen.replyText, stepNow, row.id);
            draftCount += 1;
            continue;
          }

          if (pReplied > 0 && !options?.skipSpacing) {
            await sleepMs(randomDelayMs(settings.replySpacingMinSec, settings.replySpacingMaxSec));
          }

          const sendRes = await proxySauJson(
            'POST',
            '/comments/reply',
            {
              type: ptype,
              accountName: row.account_name || accountName,
              videoId: row.platform_video_id,
              videoTitle: row.video_title,
              commentId: row.platform_comment_id,
              commentText: row.comment_text,
              authorName: row.author_name,
              replyText: gen.replyText,
              dryRun: false,
            },
            120000
          );
          const sendBody = (sendRes.payload || {}) as { code?: number; msg?: string; data?: Record<string, unknown> };
          const sendData = sendBody.data || {};
          const sendOk = sendRes.status === 200 && Boolean(sendData.ok ?? sendBody.code === 200);
          const doneTs = new Date().toISOString();

          if (sendOk) {
            db.prepare(
              `UPDATE creator_video_comments
               SET ai_reply_text = ?, sent_reply_text = ?, reply_status = 'replied', replied_at = ?, last_error = NULL, updated_at = ?
               WHERE id = ?`
            ).run(gen.replyText, gen.replyText, doneTs, doneTs, row.id);
            pReplied += 1;
            repliedCount += 1;
            appendGuardLog(
              'reply',
              ptype,
              'INFO',
              `已自动回复 ${pName} 粉丝「${row.author_name}」：${gen.replyText.slice(0, 36)}`,
              { commentId: row.id, videoTitle: row.video_title }
            );
          } else {
            const errMsg = String(sendData.message || sendBody.msg || `回复失败(${sendRes.status})`);
            db.prepare(
              `UPDATE creator_video_comments
               SET ai_reply_text = ?, reply_status = 'failed', last_error = ?, updated_at = ?
               WHERE id = ?`
            ).run(gen.replyText, errMsg, doneTs, row.id);
            appendGuardLog('reply', ptype, 'ERROR', `自动回复 ${pName} 粉丝「${row.author_name}」失败：${errMsg}`, {
              commentId: row.id,
            });
          }
        }
      }

      platformResults.push({
        platformType: ptype,
        platformName: pName,
        ok: true,
        message: `同步 ${videos.length} 条作品，新增 ${pNewComments} 条评论，自动回复 ${pReplied} 条`,
        videos: videos.length,
        newComments: pNewComments,
        replied: pReplied,
      });
    }

    db.prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(LAST_PATROL_KEY, now, now);

    const summaryMsg = `巡检完成：同步 ${syncedVideos} 条作品，新发现 ${discoveredComments} 条评论，自动回复 ${repliedCount} 条${
      draftCount > 0 ? `，生成待确认草稿 ${draftCount} 条` : ''
    }${spamSkippedCount > 0 ? `，拦截广告/无效评论 ${spamSkippedCount} 条` : ''}`;
    appendGuardLog('patrol', null, 'INFO', summaryMsg, { platformResults });

    return {
      ok: true,
      message: summaryMsg,
      syncedVideos,
      discoveredComments,
      repliedCount,
      draftCount,
      spamSkippedCount,
      platformResults,
    };
  } finally {
    patrolRunning = false;
  }
}

export async function approveAndSendCommentReply(
  commentDbId: number,
  customReplyText?: string,
  options?: { dryRun?: boolean }
): Promise<{ ok: boolean; message: string; comment?: CreatorCommentRow }> {
  const db = getDb();
  const row = db.prepare('SELECT * FROM creator_video_comments WHERE id = ?').get(commentDbId) as
    | CreatorCommentRow
    | undefined;
  if (!row) return { ok: false, message: '评论记录不存在' };
  if (row.is_author_comment) return { ok: false, message: '不能回复作者自己的评论' };

  const settings = getCommentGuardSettings();
  let replyText = customReplyText !== undefined ? sanitizeReplyText(customReplyText, settings.forbiddenReplyWords) : row.ai_reply_text;
  if (!replyText) {
    const gen = await generateFanCommentReply({
      platformType: row.platform_type,
      videoTitle: row.video_title,
      authorName: row.author_name,
      commentText: row.comment_text,
    });
    replyText = gen.replyText;
  }

  const sendRes = await proxySauJson(
    'POST',
    '/comments/reply',
    {
      type: row.platform_type,
      accountName: row.account_name,
      videoId: row.platform_video_id,
      videoTitle: row.video_title,
      commentId: row.platform_comment_id,
      commentText: row.comment_text,
      authorName: row.author_name,
      replyText,
      dryRun: Boolean(options?.dryRun),
    },
    120000
  );
  const body = (sendRes.payload || {}) as { code?: number; msg?: string; data?: Record<string, unknown> };
  const data = body.data || {};
  const ok = sendRes.status === 200 && Boolean(data.ok ?? body.code === 200);
  const now = new Date().toISOString();

  if (options?.dryRun) {
    db.prepare('UPDATE creator_video_comments SET ai_reply_text = ?, updated_at = ? WHERE id = ?').run(replyText, now, row.id);
    const updated = db.prepare('SELECT * FROM creator_video_comments WHERE id = ?').get(row.id) as unknown as CreatorCommentRow;
    return { ok, message: String(data.message || body.msg || (ok ? '预检通过' : '预检失败')), comment: updated };
  }

  if (ok) {
    db.prepare(
      `UPDATE creator_video_comments
       SET ai_reply_text = ?, sent_reply_text = ?, reply_status = 'replied', replied_at = ?, last_error = NULL, updated_at = ?
       WHERE id = ?`
    ).run(replyText, replyText, now, now, row.id);
    appendGuardLog('reply', row.platform_type, 'INFO', `已手动确认回复粉丝「${row.author_name}」：${replyText.slice(0, 36)}`, {
      commentId: row.id,
    });
  } else {
    const errMsg = String(data.message || body.msg || `发送失败(${sendRes.status})`);
    db.prepare(
      `UPDATE creator_video_comments SET ai_reply_text = ?, reply_status = 'failed', last_error = ?, updated_at = ? WHERE id = ?`
    ).run(replyText, errMsg, now, row.id);
  }

  const updated = db.prepare('SELECT * FROM creator_video_comments WHERE id = ?').get(row.id) as unknown as CreatorCommentRow;
  return {
    ok,
    message: ok ? '回复已成功发出' : String(data.message || body.msg || '回复发送失败'),
    comment: updated,
  };
}

/**
 * 供主调度器每 60 秒调用一次：推进到期暖评任务 + 触发到点定时巡检
 */
export async function checkDueCommentGuardWork(): Promise<void> {
  try {
    const settings = getCommentGuardSettings();
    if (!settings.enabled) return;

    // 1. 先推进到期的发后暖场评论任务
    if (settings.warmupEnabled) {
      await processDueWarmupJobs();
    }

    // 2. 再检查是否达到定时巡检间隔
    if (!patrolRunning) {
      const db = getDb();
      const lastRow = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(LAST_PATROL_KEY) as
        | { value?: string }
        | undefined;
      const lastMs = lastRow?.value ? Date.parse(lastRow.value) : 0;
      const intervalMs = Math.max(5, settings.patrolIntervalMinutes) * 60_000;
      if (!lastMs || Date.now() - lastMs >= intervalMs) {
        void runCommentPatrol({ manual: false }).catch((err) => {
          log('WARN', 'comment-guard', `定时巡检异常: ${(err as Error).message}`);
        });
      }
    }
  } catch (err) {
    log('WARN', 'comment-guard', `评论托管调度检查异常: ${(err as Error).message}`);
  }
}

export async function getCommentGuardOverview() {
  const db = getDb();
  const settings = getCommentGuardSettings();
  const capabilities = await fetchPlatformCapabilities();
  const today = `${getTodayUtcPrefix()}%`;

  const todayReplied = Number(
    (
      db
        .prepare("SELECT COUNT(*) AS c FROM creator_video_comments WHERE reply_status = 'replied' AND replied_at LIKE ?")
        .get(today) as { c: number }
    )?.c || 0
  );
  const totalReplied = Number(
    (db.prepare("SELECT COUNT(*) AS c FROM creator_video_comments WHERE reply_status = 'replied'").get() as { c: number })?.c || 0
  );
  const pendingCount = Number(
    (
      db
        .prepare("SELECT COUNT(*) AS c FROM creator_video_comments WHERE reply_status IN ('pending', 'draft_ready')")
        .get() as { c: number }
    )?.c || 0
  );
  const spamBlockedCount = Number(
    (db.prepare("SELECT COUNT(*) AS c FROM creator_video_comments WHERE reply_status = 'skipped_spam'").get() as { c: number })?.c || 0
  );
  const failedCount = Number(
    (db.prepare("SELECT COUNT(*) AS c FROM creator_video_comments WHERE reply_status = 'failed'").get() as { c: number })?.c || 0
  );
  const todayWarmupSent = Number(
    (
      db
        .prepare("SELECT COALESCE(SUM(sent_count), 0) AS s FROM comment_warmup_jobs WHERE updated_at LIKE ? AND sent_count > 0")
        .get(today) as { s: number }
    )?.s || 0
  );
  const activeWarmupJobs = Number(
    (
      db
        .prepare("SELECT COUNT(*) AS c FROM comment_warmup_jobs WHERE status IN ('queued', 'pending_approval', 'running')")
        .get() as { c: number }
    )?.c || 0
  );
  const syncedVideoCount = Number(
    (db.prepare('SELECT COUNT(*) AS c FROM creator_published_videos').get() as { c: number })?.c || 0
  );
  const lastPatrolRow = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(LAST_PATROL_KEY) as
    | { value?: string }
    | undefined;
  const lastPatrolAt = lastPatrolRow?.value || null;
  const nextPatrolAt =
    settings.enabled && lastPatrolAt
      ? new Date(Date.parse(lastPatrolAt) + settings.patrolIntervalMinutes * 60_000).toISOString()
      : null;

  return {
    settings,
    capabilities,
    runtime: {
      patrolRunning,
      warmupRunning,
      lastPatrolAt,
      nextPatrolAt,
    },
    stats: {
      todayReplied,
      totalReplied,
      pendingCount,
      spamBlockedCount,
      failedCount,
      todayWarmupSent,
      activeWarmupJobs,
      syncedVideoCount,
    },
  };
}
