#!/usr/bin/env node
/**
 * 视频四平台自动发布 MCP 服务（零外部依赖 stdio JSON-RPC 2.0）
 *
 * 协议：换行分隔 JSON-RPC 2.0（stdin / stdout），诊断日志仅输出到 stderr。
 * 后端：转发至本机媒体工作台 HTTP 接口（默认 http://127.0.0.1:18910）。
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const WORKBENCH_BASE_URL = (process.env.WORKBENCH_BASE_URL || 'http://127.0.0.1:18910').replace(/\/+$/, '');
const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'video_publisher', version: '0.1.0' };

const STATUS_TIMEOUT_MS = 10_000;
const VALIDATE_TIMEOUT_MS = 130_000;
const IMPORT_TIMEOUT_MS = 65_000;
const PUBLISH_TIMEOUT_MS = 320_000;

const SUPPORTED_VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.m4v', '.webm', '.flv', '.wmv']);
const PLATFORM_NAMES = {
  1: '小红书',
  2: '微信视频号',
  3: '抖音',
  4: '快手',
};
const DEFAULT_PLATFORMS = [3, 1, 2, 4];

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const sendResult = (id, result) => send({ jsonrpc: '2.0', id, result });
const sendError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

// 带超时的本地工作台请求封装
async function fetchWorkbench(apiPath, options = {}, timeoutMs = STATUS_TIMEOUT_MS) {
  const signal = options.signal || AbortSignal.timeout(timeoutMs);
  const resp = await fetch(`${WORKBENCH_BASE_URL}${apiPath}`, { ...options, signal });
  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, data };
}

function makeToolSuccess(payload) {
  const structuredContent =
    payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : undefined;
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    ...(structuredContent ? { structuredContent } : {}),
  };
}

function makeToolError(message, extra = undefined) {
  const text = extra ? `${message}\n${JSON.stringify(extra, null, 2)}` : message;
  return {
    isError: true,
    content: [{ type: 'text', text }],
  };
}

// 清洗并去重标签列表，支持数组元素内逗号/空白二次拆分，去除前导 # 与空白
function normalizeTags(rawTags) {
  const list = [];
  if (Array.isArray(rawTags)) {
    for (const elem of rawTags) {
      if (typeof elem === 'string') {
        list.push(...elem.split(/[,，\s]+/));
      } else if (elem !== undefined && elem !== null) {
        list.push(elem);
      }
    }
  } else if (typeof rawTags === 'string') {
    list.push(...rawTags.split(/[,，\s]+/));
  }
  const cleaned = [];
  const seen = new Set();
  for (const item of list) {
    const tag = String(item || '').trim().replace(/^#+/, '').trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    cleaned.push(tag);
  }
  return cleaned;
}

// 从原始文案中提取 #话题 标签并分离正文，同时清除孤立 # 号
function extractTagsFromCopy(rawCopy) {
  const text = String(rawCopy || '');
  const extracted = [];
  const seen = new Set();
  const matches = text.match(/#([^\s#,，。！？；：、]+)/g) || [];
  for (const m of matches) {
    const tag = m.replace(/^#+/, '').trim();
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      extracted.push(tag);
    }
  }
  const cleanText = text
    .replace(/#([^\s#,，。！？；：、]+)/g, ' ')
    .replace(/#+(?=[\s,，。！？；：、]|$)/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { extracted, cleanText };
}

// 生成符合微信视频号短标题规范（6~16字，允许中文/数字/字母及《》“”:+?%°）的短标题
function buildTencentShortTitle(titleText, fallbackText, warnings) {
  const allowedPattern = /[\p{L}\p{N}《》“”:+?%°]/u;
  const filterAllowed = (str) => {
    let out = '';
    for (const ch of String(str || '')) {
      if (ch === ',') {
        out += ' ';
      } else if (allowedPattern.test(ch)) {
        out += ch;
      }
    }
    return out.trim();
  };

  let candidate = filterAllowed(titleText);
  if (candidate.length < 6 && fallbackText) {
    const extra = filterAllowed(fallbackText);
    if (extra) {
      // 避免 fallback 本身已以 candidate 开头时重复拼接前缀（如 "Hi" + "Hi短" -> "HiHi短"）
      candidate = candidate && extra.startsWith(candidate) ? extra : (candidate + extra).trim();
    }
  }

  if (candidate.length > 16) {
    warnings.push(`微信视频号短标题超过 16 字（原 ${candidate.length} 字），已自动截断至 16 字`);
    candidate = candidate.slice(0, 16);
  } else if (candidate.length < 6) {
    warnings.push(`微信视频号短标题不足 6 字（当前 ${candidate.length} 字），已补齐至 6 字`);
    candidate = candidate.padEnd(6, '分享内容').slice(0, 6);
  }
  return candidate;
}

// 按单平台规则裁剪标题、正文简介与标签，并生成校验告警
function formatCopyForPlatform(platformType, candidateTitle, candidateDesc, candidateTags, rawCopy) {
  const warnings = [];
  const tExtracted = extractTagsFromCopy(candidateTitle);
  const dExtracted = extractTagsFromCopy(candidateDesc);
  let tags = normalizeTags(candidateTags);
  if (tags.length === 0 && (tExtracted.extracted.length > 0 || dExtracted.extracted.length > 0)) {
    tags = normalizeTags([...tExtracted.extracted, ...dExtracted.extracted]);
  }
  let title = tExtracted.cleanText || (tExtracted.extracted.length > 0 ? tExtracted.extracted.join(' ').slice(0, 20) : '');
  let description =
    dExtracted.cleanText || (dExtracted.extracted.length > 0 ? dExtracted.extracted.join(' ').slice(0, 100) : '');

  if (!title) {
    const rawClean = extractTagsFromCopy(rawCopy).cleanText;
    const cleanLines = rawClean
      .split(/\r?\n+/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (cleanLines.length > 0) {
      title = cleanLines[0].slice(0, 20);
      warnings.push('未提取到明确标题，已自动截取文案首句作为标题');
    } else if (tags.length > 0) {
      title = tags.join(' ').slice(0, 20) || '精彩视频分享';
      warnings.push('原始文案仅包含话题标签（无正文），已用清洗后的标签词生成兜底标题与简介');
    } else {
      title = '精彩视频分享';
      warnings.push('未提取到明确标题与有效标签，已使用默认兜底标题');
    }
  }
  if (!description) {
    description = title;
  }
  if (tags.length === 0) {
    warnings.push('未检测到话题标签，建议补充 2~5 个标签以提升推荐效果');
  }

  let shortTitle;
  switch (platformType) {
    case 3: // 抖音
      if (title.length > 30) {
        warnings.push(`抖音标题超过 30 字（原 ${title.length} 字），已自动截断至 30 字`);
        title = title.slice(0, 30);
      }
      if (tags.length > 5) {
        warnings.push(`抖音标签超过 5 个（原 ${tags.length} 个），已保留前 5 个`);
        tags = tags.slice(0, 5);
      }
      break;
    case 1: // 小红书
      if (title.length > 20) {
        warnings.push(`小红书标题超过 20 字（原 ${title.length} 字），已自动截断至 20 字`);
        title = title.slice(0, 20);
      }
      if (tags.length > 6) {
        warnings.push(`小红书标签超过 6 个（原 ${tags.length} 个），已保留前 6 个`);
        tags = tags.slice(0, 6);
      }
      break;
    case 2: // 微信视频号
      if (title.length > 30) {
        warnings.push(`微信视频号主标题超过 30 字（原 ${title.length} 字），已自动截断至 30 字`);
        title = title.slice(0, 30);
      }
      if (tags.length > 5) {
        warnings.push(`微信视频号标签超过 5 个（原 ${tags.length} 个），已保留前 5 个`);
        tags = tags.slice(0, 5);
      }
      shortTitle = buildTencentShortTitle(title, description || rawCopy, warnings);
      break;
    case 4: // 快手
      if (title.length > 30) {
        warnings.push(`快手标题超过 30 字（原 ${title.length} 字），已自动截断至 30 字`);
        title = title.slice(0, 30);
      }
      if (tags.length > 3) {
        warnings.push(`快手标签超过 3 个（原 ${tags.length} 个），已保留前 3 个`);
        tags = tags.slice(0, 3);
      }
      // 快手网页端无独立标题框，须将标题与话题前简介合并进 description
      if (description && description !== title && !description.startsWith(title)) {
        description = `${title}\n${description}`;
      }
      break;
    default:
      warnings.push(`未知平台类型 ${platformType}`);
      break;
  }

  return {
    platformType,
    platformName: PLATFORM_NAMES[platformType] || `平台(${platformType})`,
    title,
    description,
    tags,
    ...(platformType === 2 ? { shortTitle } : {}),
    warnings,
  };
}

function splitRawCopyByRules(rawCopy, titleHint, explicitTags) {
  const { extracted, cleanText } = extractTagsFromCopy(rawCopy);
  const hintExtracted = extractTagsFromCopy(titleHint);
  const mergedTags = normalizeTags([
    ...(Array.isArray(explicitTags) ? explicitTags : normalizeTags(explicitTags)),
    ...extracted,
    ...hintExtracted.extracted,
  ]);

  const lines = cleanText
    .split(/\r?\n+/)
    .map((l) => l.trim())
    .filter(Boolean);

  let baseTitle =
    hintExtracted.cleanText ||
    (hintExtracted.extracted.length > 0 ? hintExtracted.extracted.join(' ').slice(0, 20) : '');
  let bodyLines = lines;

  if (!baseTitle && lines.length > 0) {
    const firstLine = lines[0];
    if (lines.length > 1 && firstLine.length <= 45) {
      baseTitle = firstLine.replace(/[。！!？?]+$/, '').trim();
      bodyLines = lines.slice(1);
    } else {
      const sentenceSplit = firstLine.split(/[。！？!?]/).map((s) => s.trim()).filter(Boolean);
      baseTitle = (sentenceSplit[0] || firstLine).slice(0, 28).trim();
      bodyLines = lines;
    }
  }

  let baseDesc = bodyLines.join('\n').trim();
  if (!baseDesc) {
    baseDesc = cleanText || baseTitle;
  }
  return { baseTitle, baseDesc, mergedTags };
}

// 与 workbench_fallback.py 对齐：前置校验定时发布参数与 2 小时最小提前量
function validateTimerSchedule({
  enableTimer,
  videosPerDay,
  rawDailyTimes,
  startDays,
  totalVideos = 1,
  nowDate = new Date(),
}) {
  let dailyTimes;
  if (rawDailyTimes === undefined || rawDailyTimes === null) {
    dailyTimes = ['10:00', '18:00'];
  } else if (Array.isArray(rawDailyTimes)) {
    dailyTimes = rawDailyTimes.map((t) => String(t || '').trim()).filter(Boolean);
  } else if (typeof rawDailyTimes === 'string') {
    dailyTimes = rawDailyTimes.split(/[,，\s]+/).map((t) => t.trim()).filter(Boolean);
  } else {
    dailyTimes = [];
  }

  if (!enableTimer) {
    return {
      dailyTimes: dailyTimes.length > 0 ? dailyTimes : ['10:00', '18:00'],
      videosPerDay: Number.isInteger(videosPerDay) && videosPerDay >= 1 ? videosPerDay : 1,
      startDays: Number.isInteger(startDays) && startDays >= 0 ? startDays : 0,
      earliestSchedule: null,
    };
  }

  if (dailyTimes.length === 0) {
    throw new Error('启用定时发布时，dailyTimes 不能为空，必须提供至少一个 HH:MM 时间点');
  }
  if (!Number.isInteger(videosPerDay) || videosPerDay < 1) {
    throw new Error('启用定时发布时，videosPerDay 必须为大于等于 1 的整数');
  }
  if (videosPerDay > dailyTimes.length) {
    throw new Error(`启用定时发布时，videosPerDay (${videosPerDay}) 不能大于 dailyTimes 数量 (${dailyTimes.length})`);
  }
  if (!Number.isInteger(startDays) || startDays < 0) {
    throw new Error('启用定时发布时，startDays 不能为负数（0 表示明天，1 表示后天）');
  }

  const parsedTimes = [];
  const normalizedTimes = [];
  for (const entry of dailyTimes) {
    const match = entry.match(/^(\d{1,2}):(\d{2})$/);
    if (!match) {
      throw new Error(`定时时间点格式错误: ${entry}，必须为 HH:MM（例如 10:00 或 18:30）`);
    }
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      throw new Error(`定时时间点超出有效范围: ${entry}（小时 0~23，分钟 0~59）`);
    }
    parsedTimes.push([hour, minute]);
    normalizedTimes.push(`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
  }

  const videoCount = Math.max(1, totalVideos);
  let earliestDate = null;
  for (let videoIdx = 0; videoIdx < videoCount; videoIdx++) {
    const day = Math.floor(videoIdx / videosPerDay) + startDays + 1;
    const dailyVideoIndex = videoIdx % videosPerDay;
    const [hour, minute] = parsedTimes[dailyVideoIndex];
    const scheduled = new Date(
      nowDate.getFullYear(),
      nowDate.getMonth(),
      nowDate.getDate() + day,
      hour,
      minute,
      0,
      0
    );
    if (!earliestDate || scheduled.getTime() < earliestDate.getTime()) {
      earliestDate = scheduled;
    }
  }

  const pad2 = (n) => String(n).padStart(2, '0');
  const earliestText = earliestDate
    ? `${earliestDate.getFullYear()}-${pad2(earliestDate.getMonth() + 1)}-${pad2(earliestDate.getDate())} ${pad2(
        earliestDate.getHours()
      )}:${pad2(earliestDate.getMinutes())}`
    : '';
  if (!earliestDate || earliestDate.getTime() <= nowDate.getTime() + 2 * 3600 * 1000) {
    throw new Error(`最早定时时间（${earliestText}）必须晚于当前时间至少 2 小时以上`);
  }

  return {
    dailyTimes: normalizedTimes,
    videosPerDay,
    startDays,
    earliestSchedule: earliestText,
  };
}

function normalizePlatformList(rawPlatforms) {
  if (!Array.isArray(rawPlatforms) || rawPlatforms.length === 0) {
    return [...DEFAULT_PLATFORMS];
  }
  const result = [];
  const seen = new Set();
  for (const item of rawPlatforms) {
    const num = Number(item);
    if ([1, 2, 3, 4].includes(num) && !seen.has(num)) {
      seen.add(num);
      result.push(num);
    }
  }
  return result.length > 0 ? result : [...DEFAULT_PLATFORMS];
}

// 从 SAU 账号列表中解析安全元数据（绝不向外暴露 Cookie 路径）
function parseSafeAccountRows(rawData) {
  if (!Array.isArray(rawData)) return [];
  const rows = [];
  for (const row of rawData) {
    if (Array.isArray(row)) {
      const [id, type, cookieFilePath, userName, status] = row;
      const numType = Number(type);
      rows.push({
        id: Number(id),
        type: numType,
        platformName: PLATFORM_NAMES[numType] || `平台(${numType})`,
        userName: String(userName || ''),
        status: Number(status || 0),
        valid: Number(status) === 1,
        _internalCookieFile: String(cookieFilePath || ''),
      });
    } else if (row && typeof row === 'object') {
      const numType = Number(row.type);
      rows.push({
        id: Number(row.id),
        type: numType,
        platformName: PLATFORM_NAMES[numType] || `平台(${numType})`,
        userName: String(row.userName || row.name || ''),
        status: Number(row.status || 0),
        valid: Number(row.status) === 1,
        _internalCookieFile: String(row.filePath || ''),
      });
    }
  }
  return rows;
}

function toPublicAccountMeta(acc) {
  return {
    id: acc.id,
    type: acc.type,
    platformName: acc.platformName,
    userName: acc.userName,
    status: acc.status,
    valid: acc.valid,
  };
}

// ==================== 5 个 MCP 工具实现 ====================

async function handleCheckWorkbenchStatus() {
  try {
    const [healthRes, sauRes] = await Promise.all([
      fetchWorkbench('/api/health', {}, STATUS_TIMEOUT_MS),
      fetchWorkbench('/api/sau/status', {}, STATUS_TIMEOUT_MS),
    ]);
    if (!healthRes.ok) {
      return makeToolError(`工作台健康检查失败（HTTP ${healthRes.status}）`, healthRes.data);
    }
    return makeToolSuccess({
      ok: Boolean(healthRes.data?.ok),
      workbenchOnline: true,
      baseUrl: WORKBENCH_BASE_URL,
      health: healthRes.data,
      sauStatus: sauRes.ok ? sauRes.data : { available: false, status: sauRes.status },
    });
  } catch (err) {
    return makeToolError(
      `无法连接本地媒体工作台（${WORKBENCH_BASE_URL}）：${err?.message || '连接失败'}。请确认 18910 服务已启动。`
    );
  }
}

async function handleListPublishAccounts(args) {
  const validate = Boolean(args?.validate);
  const platformType = args?.platformType !== undefined && args?.platformType !== null ? Number(args.platformType) : null;
  if (platformType !== null && ![1, 2, 3, 4].includes(platformType)) {
    return makeToolError('platformType 必须是 1（小红书）、2（微信视频号）、3（抖音）或 4（快手）');
  }

  try {
    const res = validate
      ? await fetchWorkbench('/api/sau/accounts/validate', { method: 'POST' }, VALIDATE_TIMEOUT_MS)
      : await fetchWorkbench('/api/sau/accounts', {}, STATUS_TIMEOUT_MS);

    if (!res.ok || (res.data?.code && res.data.code !== 200)) {
      return makeToolError(res.data?.msg || `查询发布账号失败（HTTP ${res.status}）`, res.data);
    }

    const parsed = parseSafeAccountRows(res.data?.data);
    const filtered = platformType ? parsed.filter((a) => a.type === platformType) : parsed;
    const accounts = filtered.map(toPublicAccountMeta);

    return makeToolSuccess({
      count: accounts.length,
      validated: validate,
      accounts,
    });
  } catch (err) {
    return makeToolError(`查询发布账号异常：${err?.message || '请求失败'}`);
  }
}

async function handlePreparePublishCopy(args) {
  const rawCopy = typeof args?.rawCopy === 'string'
    ? args.rawCopy
    : typeof args?.script === 'string'
      ? args.script
      : '';
  const explicitTitle = typeof args?.title === 'string' ? args.title.trim() : '';
  const explicitDescription = typeof args?.description === 'string' ? args.description.trim() : '';
  const titleHint = typeof args?.titleHint === 'string' ? args.titleHint.trim() : '';
  const styleHint = typeof args?.styleHint === 'string' ? args.styleHint.trim() : '';

  if (!rawCopy.trim() && !explicitTitle && !explicitDescription) {
    return makeToolError('rawCopy、script、title、description 不能全部为空');
  }

  const targetPlatforms = normalizePlatformList(args?.platforms);
  const explicitTags = args?.tags;
  const normalizedExplicitTags = normalizeTags(explicitTags);
  const useAi = Boolean(args?.useAi);

  const effectiveRawCopy = rawCopy.trim()
    ? rawCopy
    : [explicitTitle, explicitDescription].filter(Boolean).join('\n');

  let ruleParts;
  if (rawCopy.trim()) {
    const tExtracted = extractTagsFromCopy(explicitTitle);
    const dExtracted = extractTagsFromCopy(explicitDescription);
    const cleanExplicitTitle =
      tExtracted.cleanText || (tExtracted.extracted.length > 0 ? tExtracted.extracted.join(' ').slice(0, 20) : '');
    const cleanExplicitDesc =
      dExtracted.cleanText || (dExtracted.extracted.length > 0 ? dExtracted.extracted.join(' ').slice(0, 100) : '');
    ruleParts = splitRawCopyByRules(rawCopy, cleanExplicitTitle || titleHint, explicitTags);
    ruleParts.mergedTags = normalizeTags([
      ...ruleParts.mergedTags,
      ...tExtracted.extracted,
      ...dExtracted.extracted,
    ]);
    if (cleanExplicitDesc) {
      ruleParts.baseDesc = cleanExplicitDesc;
    }
  } else if (explicitTitle) {
    const titleExtracted = extractTagsFromCopy(explicitTitle);
    const descExtracted = extractTagsFromCopy(explicitDescription);
    const mergedTags = normalizeTags([
      ...normalizedExplicitTags,
      ...titleExtracted.extracted,
      ...descExtracted.extracted,
    ]);
    const baseTitle =
      titleExtracted.cleanText || (titleExtracted.extracted.length > 0 ? titleExtracted.extracted.join(' ').slice(0, 20) : explicitTitle);
    const baseDesc =
      descExtracted.cleanText || (descExtracted.extracted.length > 0 ? descExtracted.extracted.join(' ').slice(0, 100) : '') || baseTitle;
    ruleParts = { baseTitle, baseDesc, mergedTags };
  } else {
    ruleParts = splitRawCopyByRules(explicitDescription, titleHint, explicitTags);
  }

  let aiByPlatform = null;
  let usedAi = false;
  let aiFallbackReason = '';

  if (useAi && effectiveRawCopy.trim().length >= 8) {
    try {
      const effectiveStyleHint = styleHint || titleHint;
      const res = await fetchWorkbench(
        '/api/publish/ai-generate',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            script: effectiveRawCopy,
            platforms: targetPlatforms,
            ...(effectiveStyleHint ? { styleHint: effectiveStyleHint } : {}),
          }),
        },
        60_000
      );
      if (res.ok && res.data?.ok && res.data?.byPlatform) {
        aiByPlatform = res.data.byPlatform;
        usedAi = true;
      } else {
        aiFallbackReason = res.data?.message || res.data?.msg || `AI 接口返回 HTTP ${res.status}，已回退规则拆分`;
      }
    } catch (err) {
      aiFallbackReason = `AI 接口不可用（${err?.message || '请求失败'}），已回退规则拆分`;
    }
  }

  const platformsResult = {};
  for (const p of targetPlatforms) {
    const aiEntry = aiByPlatform ? aiByPlatform[String(p)] || aiByPlatform[p] : null;
    const candidateTitle = aiEntry?.title || ruleParts.baseTitle;
    const candidateDesc = aiEntry?.description || ruleParts.baseDesc;
    // 仅当显式传入有效标签时才覆盖提取/AI 标签，避免 [" ", "# "] 误清空自动提取的 #话题
    const candidateTags =
      normalizedExplicitTags.length > 0
        ? normalizedExplicitTags
        : aiEntry?.tags && normalizeTags(aiEntry.tags).length > 0
          ? aiEntry.tags
          : ruleParts.mergedTags;

    platformsResult[String(p)] = formatCopyForPlatform(
      p,
      candidateTitle,
      candidateDesc,
      candidateTags,
      effectiveRawCopy
    );
  }

  return makeToolSuccess({
    mode: usedAi ? 'ai' : 'rule',
    ...(aiFallbackReason ? { aiFallbackReason } : {}),
    platforms: platformsResult,
  });
}

async function handlePublishVideoToPlatforms(args) {
  const filePath = typeof args?.filePath === 'string' ? args.filePath.trim().replace(/^['"]|['"]$/g, '') : '';
  const inputFileList = Array.isArray(args?.fileList)
    ? args.fileList.map((f) => String(f || '').trim()).filter(Boolean)
    : [];

  if (!filePath && inputFileList.length === 0) {
    return makeToolError('必须提供本地视频路径 filePath 或已导入素材文件名列表 fileList');
  }

  if (!Array.isArray(args?.platforms) || args.platforms.length === 0) {
    return makeToolError('必须指定目标平台列表 platforms（如 [3, 1, 2, 4]）');
  }
  const targetPlatforms = [];
  const seenPlat = new Set();
  for (const p of args.platforms) {
    const num = Number(p);
    if (![1, 2, 3, 4].includes(num)) {
      return makeToolError(`不支持的平台编号: ${p}，仅支持 1/2/3/4`);
    }
    if (!seenPlat.has(num)) {
      seenPlat.add(num);
      targetPlatforms.push(num);
    }
  }

  const isDraft = Boolean(args?.isDraft);
  const dryRun = Boolean(args?.dryRun);
  const accountIds = [];
  if (args?.accountIds !== undefined) {
    if (!Array.isArray(args.accountIds) || args.accountIds.length === 0) {
      return makeToolError('accountIds 必须为非空正整数数组');
    }
    for (const rawId of args.accountIds) {
      if (rawId === null || rawId === undefined || typeof rawId === 'boolean' || typeof rawId === 'object') {
        return makeToolError(`accountIds 包含无效账号 ID: ${String(rawId)}`);
      }
      const trimmed = String(rawId).trim();
      const num = Number(trimmed);
      if (!trimmed || !Number.isInteger(num) || num <= 0) {
        return makeToolError(`accountIds 包含无效账号 ID: ${String(rawId)}`);
      }
      accountIds.push(num);
    }
  }
  const copies = args?.copies && typeof args.copies === 'object' ? args.copies : {};
  const defaultTitle = typeof args?.title === 'string' ? args.title.trim() : '';
  const defaultDescription = typeof args?.description === 'string' ? args.description : '';
  const defaultTags = normalizeTags(args?.tags);

  // 校验至少有可用标题（全局或每个待发布平台覆盖）
  for (const p of targetPlatforms) {
    if (isDraft && p !== 2) continue;
    const platCopy = copies[String(p)] || copies[p] || {};
    const platTitle = String(platCopy.title || defaultTitle || '').trim();
    if (!platTitle) {
      return makeToolError(`平台 ${PLATFORM_NAMES[p]} 缺少发布标题 title`);
    }
  }

  // 定时发布参数前置校验（必须在 dryRun 返回与 /api/sau/import-local-file 之前拦截非法参数）
  const enableTimer = Boolean(args?.enableTimer);
  const rawVideosPerDay =
    args?.videosPerDay !== undefined && args?.videosPerDay !== null ? Number(args.videosPerDay) : 1;
  const rawStartDays =
    args?.startDays !== undefined && args?.startDays !== null ? Number(args.startDays) : 0;
  let timerConfig;
  try {
    timerConfig = validateTimerSchedule({
      enableTimer,
      videosPerDay: rawVideosPerDay,
      rawDailyTimes: args?.dailyTimes,
      startDays: rawStartDays,
      totalVideos: inputFileList.length > 0 ? inputFileList.length : 1,
    });
  } catch (err) {
    return makeToolError(err?.message || '定时发布参数校验失败', {
      timerValidation: { ok: false, enableTimer },
    });
  }

  // 防误发硬守卫：非 dryRun 实际导入/发布前必须显式传入 confirmed: true
  if (!dryRun && args?.confirmed !== true) {
    const guardPayload = {
      ok: false,
      requiresConfirmation: true,
      message:
        '发布保护：实际导入与发布前必须先展示标题/简介/标签并获得用户确认，确认后请传入 confirmed: true（或先用 dryRun: true 预演）。',
      platforms: targetPlatforms,
    };
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify(guardPayload, null, 2) }],
      structuredContent: guardPayload,
    };
  }

  // 查询当前账号池（内部匹配 cookie 文件名，不输出到工具响应）
  let allAccounts = [];
  try {
    const accRes = await fetchWorkbench('/api/sau/accounts', {}, STATUS_TIMEOUT_MS);
    if (!accRes.ok || (accRes.data?.code && accRes.data.code !== 200)) {
      return makeToolError(accRes.data?.msg || `读取账号列表失败（HTTP ${accRes.status}）`, accRes.data);
    }
    allAccounts = parseSafeAccountRows(accRes.data?.data);
  } catch (err) {
    return makeToolError(`读取账号列表失败：${err?.message || '连接异常'}`);
  }

  // dryRun 时先本地只读校验视频文件，不做任何复制或入库
  let fileValidation = null;
  if (dryRun && filePath) {
    const isAbs = path.isAbsolute(filePath);
    const exists = isAbs && fs.existsSync(filePath);
    const isFile = exists && fs.statSync(filePath).isFile();
    const ext = path.extname(filePath).toLowerCase();
    const extSupported = SUPPORTED_VIDEO_EXTS.has(ext);
    fileValidation = {
      filePath,
      isAbsolute: isAbs,
      exists,
      isFile,
      extension: ext,
      supported: extSupported,
      ok: Boolean(isAbs && exists && isFile && extSupported),
    };
    if (!fileValidation.ok) {
      return makeToolError('本地视频文件校验未通过（dryRun 未执行导入或发布）', fileValidation);
    }
  }

  // 解析各平台匹配账号与草稿拦截
  const platformPlans = [];
  for (const p of targetPlatforms) {
    const platformName = PLATFORM_NAMES[p];
    if (isDraft && p !== 2) {
      platformPlans.push({
        type: p,
        platformName,
        blocked: true,
        status: 'blocked_draft_unsupported',
        message: `${platformName} 不支持草稿模式（SAU 会直接公开发布），为防止误发已拦截`,
      });
      continue;
    }

    const candidates = allAccounts.filter((a) => a.type === p);
    let matched = [];
    if (accountIds.length > 0) {
      matched = candidates.filter((a) => accountIds.includes(a.id) && a._internalCookieFile);
    } else {
      matched = candidates.filter((a) => a.valid && a._internalCookieFile);
    }

    if (matched.length === 0) {
      platformPlans.push({
        type: p,
        platformName,
        blocked: true,
        status: 'no_valid_account',
        message:
          accountIds.length > 0
            ? `${platformName} 未找到指定 accountIds 对应的可用账号`
            : `${platformName} 暂无有效登录账号，请先扫码登录或校验账号`,
      });
      continue;
    }

    const platCopy = copies[String(p)] || copies[p] || {};
    const platTitle = String(platCopy.title || defaultTitle).trim();
    let platDesc =
      typeof platCopy.description === 'string' ? platCopy.description : defaultDescription;
    // 快手网页端无独立标题框，有简介时须将标题与简介合并进 description
    if (p === 4 && platDesc && platDesc !== platTitle && !platDesc.startsWith(platTitle)) {
      platDesc = `${platTitle}\n${platDesc}`;
    }
    const rawPlatTags = platCopy.tags;
    const platTags =
      Array.isArray(rawPlatTags) || (typeof rawPlatTags === 'string' && rawPlatTags.trim())
        ? normalizeTags(rawPlatTags)
        : defaultTags;

    platformPlans.push({
      type: p,
      platformName,
      blocked: false,
      matchedAccounts: matched,
      payloadCore: {
        type: p,
        title: platTitle,
        description: platDesc,
        tags: platTags,
        enableTimer: enableTimer ? 1 : 0,
        videosPerDay: timerConfig.videosPerDay,
        dailyTimes: timerConfig.dailyTimes,
        startDays: timerConfig.startDays,
        category: Number(args?.category || 0) || 0,
        isDraft: p === 2 ? isDraft : false,
        productLink: p === 3 ? String(args?.productLink || '') : '',
        productTitle: p === 3 ? String(args?.productTitle || '') : '',
      },
    });
  }

  if (dryRun) {
    const dryResults = platformPlans.map((plan) => {
      if (plan.blocked) {
        return {
          type: plan.type,
          platformName: plan.platformName,
          status: plan.status,
          message: plan.message,
        };
      }
      return {
        type: plan.type,
        platformName: plan.platformName,
        status: 'dry_run_ready',
        accountIds: plan.matchedAccounts.map((a) => a.id),
        accountNames: plan.matchedAccounts.map((a) => a.userName),
        plannedPayload: {
          ...plan.payloadCore,
          fileList: inputFileList.length > 0 ? inputFileList : ['<will_import_from_filePath>'],
          accountCount: plan.matchedAccounts.length,
        },
      };
    });
    return makeToolSuccess({
      dryRun: true,
      fileValidation,
      results: dryResults,
    });
  }

  // 非 dryRun：若有可提交平台且未直接传入 fileList，则先调用免拖拽本地导入接口
  const hasRunnable = platformPlans.some((p) => !p.blocked);
  let resolvedFileList = [...inputFileList];
  let importedFile = null;

  if (hasRunnable && resolvedFileList.length === 0) {
    try {
      const importRes = await fetchWorkbench(
        '/api/sau/import-local-file',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath }),
        },
        IMPORT_TIMEOUT_MS
      );
      if (!importRes.ok || importRes.data?.code !== 200 || !importRes.data?.data?.filepath) {
        return makeToolError(
          importRes.data?.msg || `本地视频导入失败（HTTP ${importRes.status}）`,
          importRes.data
        );
      }
      importedFile = importRes.data.data;
      resolvedFileList = [importedFile.filepath];
    } catch (err) {
      return makeToolError(`本地视频导入请求异常：${err?.message || '连接失败'}`);
    }
  }

  const results = [];
  for (const plan of platformPlans) {
    if (plan.blocked) {
      results.push({
        type: plan.type,
        platformName: plan.platformName,
        status: plan.status,
        message: plan.message,
      });
      continue;
    }

    const safeAccountIds = plan.matchedAccounts.map((a) => a.id);
    const safeAccountNames = plan.matchedAccounts.map((a) => a.userName);
    const internalAccountList = plan.matchedAccounts.map((a) => a._internalCookieFile);

    try {
      const postRes = await fetchWorkbench(
        '/api/sau/post-video',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...plan.payloadCore,
            fileList: resolvedFileList,
            accountList: internalAccountList,
          }),
        },
        PUBLISH_TIMEOUT_MS
      );
      const ok = postRes.ok && postRes.data?.code === 200;
      results.push({
        type: plan.type,
        platformName: plan.platformName,
        status: ok ? 'submitted' : 'failed',
        code: postRes.data?.code ?? postRes.status,
        message: postRes.data?.msg || (ok ? '发布任务已提交' : `HTTP ${postRes.status}`),
        accountIds: safeAccountIds,
        accountNames: safeAccountNames,
        isDraft: plan.payloadCore.isDraft,
      });
    } catch (err) {
      results.push({
        type: plan.type,
        platformName: plan.platformName,
        status: 'failed',
        code: 500,
        message: `提交发布异常：${err?.message || '请求超时或中断'}`,
        accountIds: safeAccountIds,
        accountNames: safeAccountNames,
        isDraft: plan.payloadCore.isDraft,
      });
    }
  }

  return makeToolSuccess({
    dryRun: false,
    importedFile,
    results,
  });
}

async function handleGetPublishHistory(args) {
  const rawLimit = Number(args?.limit ?? 50);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 200) : 50;

  try {
    const res = await fetchWorkbench(`/api/sau/publish-history?limit=${limit}`, {}, STATUS_TIMEOUT_MS);
    if (!res.ok || (res.data?.code && res.data.code !== 200)) {
      return makeToolError(res.data?.msg || `查询发布历史失败（HTTP ${res.status}）`, res.data);
    }

    const rawRecords = Array.isArray(res.data?.data) ? res.data.data : [];
    // 剔除 account_list 中的 Cookie 文件名，避免凭证路径暴露
    const records = rawRecords.map((rec) => {
      const { account_list: accountList, ...safeRec } = rec || {};
      return {
        ...safeRec,
        accountCount: Array.isArray(accountList) ? accountList.length : 0,
      };
    });

    return makeToolSuccess({
      count: records.length,
      limit,
      records,
    });
  } catch (err) {
    return makeToolError(`查询发布历史异常：${err?.message || '连接失败'}`);
  }
}

const TOOLS = [
  {
    name: 'check_workbench_status',
    description: '检查本地 18910 媒体工作台与内置 SAU 发布引擎运行状态。',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'list_publish_accounts',
    description: '查询四平台（1小红书/2微信视频号/3抖音/4快手）已登录账号状态，不返回任何 Cookie 文件路径或密钥。',
    inputSchema: {
      type: 'object',
      properties: {
        validate: {
          type: 'boolean',
          description: '是否触发真浏览器实时校验账号登录态（耗时较长）',
        },
        platformType: {
          type: 'integer',
          enum: [1, 2, 3, 4],
          description: '按平台过滤：1小红书，2微信视频号，3抖音，4快手',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'prepare_publish_copy',
    description:
      '按抖音/小红书/微信视频号/快手各平台字数与标签上限，将原始文案（rawCopy/script）或结构化标题简介（title/description/tags）拆分为标题、话题前简介与标签，并输出规范校验告警。',
    inputSchema: {
      type: 'object',
      properties: {
        rawCopy: {
          type: 'string',
          description: '原始口播或待发布文案（rawCopy/script 与 title/description 至少提供一项）',
        },
        script: {
          type: 'string',
          description: 'rawCopy 的别名，原始口播或待发布文案',
        },
        title: {
          type: 'string',
          description: '可选主标题（未传 rawCopy/script 时可与 description/tags 配合使用）',
        },
        description: {
          type: 'string',
          description: '可选话题前简介文字（未传 rawCopy/script 时可与 title/tags 配合使用）',
        },
        platforms: {
          type: 'array',
          items: { type: 'integer', enum: [1, 2, 3, 4] },
          description: '目标平台编号列表，默认 [3, 1, 2, 4]',
        },
        titleHint: {
          type: 'string',
          description: '可选标题偏好或主标题提示',
        },
        styleHint: {
          type: 'string',
          description: '可选风格提示（useAi 为 true 时透传给工作台 AI）',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '可选指定话题标签列表',
        },
        useAi: {
          type: 'boolean',
          description: '是否优先调用工作台 AI 生成四平台差异化文案（失败自动回退规则拆分）',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'publish_video_to_platforms',
    description:
      '免拖拽导入本机视频并向指定平台提交发布（默认开启防误发保护，非 dryRun 须先向用户展示文案并传入 confirmed: true；支持仅微信视频号的 isDraft 草稿保护）。',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: '本机待发布视频绝对路径',
        },
        fileList: {
          type: 'array',
          items: { type: 'string' },
          description: '可选已导入素材库的文件名列表（跳过重复导入）',
        },
        platforms: {
          type: 'array',
          items: { type: 'integer', enum: [1, 2, 3, 4] },
          description: '目标平台编号列表（1小红书/2微信视频号/3抖音/4快手）',
        },
        accountIds: {
          type: 'array',
          items: { type: 'integer' },
          description: '可选指定使用的账号 ID 列表',
        },
        title: {
          type: 'string',
          description: '默认视频标题',
        },
        description: {
          type: 'string',
          description: '话题前的一小段简介文字',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '默认话题标签列表',
        },
        copies: {
          type: 'object',
          description: '按平台编号（"1"/"2"/"3"/"4"）覆盖 { title, description, tags }',
        },
        isDraft: {
          type: 'boolean',
          description: '是否保存为草稿（仅平台 2 微信视频号支持，其余平台将安全拦截）',
        },
        enableTimer: {
          type: 'boolean',
          description: '是否启用定时发布',
        },
        videosPerDay: {
          type: 'integer',
          description: '定时发布每天条数',
        },
        dailyTimes: {
          type: 'array',
          items: { type: 'string' },
          description: '定时发布时间点列表，如 ["10:00", "18:00"]',
        },
        startDays: {
          type: 'integer',
          description: '定时发布起始偏移天数（0表示明天）',
        },
        category: {
          type: 'integer',
          description: '分类/原创声明标记（0默认，1声明原创）',
        },
        productLink: {
          type: 'string',
          description: '抖音商品链接（可选）',
        },
        productTitle: {
          type: 'string',
          description: '抖音商品短标题（可选）',
        },
        dryRun: {
          type: 'boolean',
          description: '仅校验与预览发布计划，不复制文件也不提交发布',
        },
        confirmed: {
          type: 'boolean',
          description: '防误发确认开关：实际导入与发布（dryRun 非 true）前必须先展示文案给用户确认后传入 true',
        },
      },
      required: ['platforms', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_publish_history',
    description: '获取近期多平台视频发布历史记录（已自动脱敏账号凭证路径）。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          description: '返回记录条数上限（1~200，默认 50）',
        },
      },
      additionalProperties: false,
    },
  },
];

async function callTool(name, args) {
  const toolName = typeof name === 'string' ? name.trim() : '';
  if (!toolName) {
    return makeToolError('工具名称不能为空');
  }
  const normalizedArgs = args == null ? {} : args;
  if (typeof normalizedArgs !== 'object' || Array.isArray(normalizedArgs)) {
    return makeToolError('工具参数 arguments 必须是 JSON 对象');
  }

  switch (toolName) {
    case 'check_workbench_status':
      return handleCheckWorkbenchStatus();
    case 'list_publish_accounts':
      return handleListPublishAccounts(normalizedArgs);
    case 'prepare_publish_copy':
      return handlePreparePublishCopy(normalizedArgs);
    case 'publish_video_to_platforms':
      return handlePublishVideoToPlatforms(normalizedArgs);
    case 'get_publish_history':
      return handleGetPublishHistory(normalizedArgs);
    default:
      return makeToolError(`未知工具: ${toolName}`);
  }
}

async function handleRequest(message) {
  const { id, method, params } = message;
  switch (method) {
    case 'initialize':
      return sendResult(id, {
        protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
    case 'ping':
      return sendResult(id, {});
    case 'tools/list':
      return sendResult(id, { tools: TOOLS });
    case 'tools/call':
      return sendResult(id, await callTool(params?.name, params?.arguments));
    default:
      return sendError(id, -32601, `Method not found: ${method}`);
  }
}

let lineQueue = Promise.resolve();

async function processLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    sendError(null, -32700, 'Parse error');
    return;
  }
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    sendError(null, -32600, 'Invalid Request');
    return;
  }
  if (typeof message.method !== 'string' || !message.method) {
    if (message.id !== undefined && message.id !== null) {
      sendError(message.id, -32600, 'Invalid Request');
    }
    return;
  }
  // 通知消息（如 notifications/initialized）不回包
  if (message.id === undefined || message.id === null) {
    return;
  }
  try {
    await handleRequest(message);
  } catch (err) {
    sendError(message.id, -32603, err?.message || '内部错误');
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  lineQueue = lineQueue.then(() => processLine(line)).catch((err) => {
    process.stderr.write(`[video_publisher-mcp] line error: ${err?.message || err}\n`);
  });
});

process.stderr.write(`[video_publisher-mcp] stdio ready, workbench: ${WORKBENCH_BASE_URL}\n`);
