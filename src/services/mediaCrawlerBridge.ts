import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { PATHS } from '../config.js';
import { getDb, upsertContentWithMetrics } from '../db/database.js';
import { escapeLikeTerm } from '../utils/sqlValidation.js';
import { withHeadlessContext } from '../browser/profileManager.js';
import { extractUrlFromShareText, resolveShortSourceUrl } from '../adapters/urlRecognizer.js';
import { callAiJsonWithCache } from './aiRadarService.js';
import { loadLatestSauPlatformCookies } from './sauCookieSync.js';
import { log } from '../utils/logger.js';

export interface MediaCrawlerStatus {
  installed: boolean;
  dir: string;
  pythonExe: string;
  gitCommit: string;
  running: boolean;
  currentTask: string | null;
  lastLog: string[];
  lastError: string | null;
}

export interface CrawledCommentRow {
  id: string;
  author: string;
  text: string;
  likes: number;
  publishedAt: string | null;
  postTitle?: string;
  postUrl?: string;
}

export interface CommentCrawlJob {
  id: string;
  platform: string;
  mode: 'detail' | 'search' | 'creator';
  input: string;
  status: 'running' | 'done' | 'failed';
  message: string;
  logs: string[];
  comments: CrawledCommentRow[];
  aiSummary?: {
    topQuestions: string[];
    painPoints: string[];
    topicAngles: string[];
    oneLineTakeaway: string;
    analyzedAt: string;
  } | null;
  createdAt: string;
  finishedAt?: string | null;
}

const SESSIONS_FILE = path.join(PATHS.dataDir, 'comment_crawl_jobs.json');

let runningCrawler = false;
let currentTaskDesc: string | null = null;
let lastLogs: string[] = [];
let lastErrorMsg: string | null = null;

function pushLog(msg: string, job?: CommentCrawlJob) {
  const line = `[${new Date().toLocaleTimeString('zh-CN')}] ${msg}`;
  lastLogs.push(line);
  if (lastLogs.length > 80) lastLogs = lastLogs.slice(-80);
  if (job) {
    job.logs.push(line);
    if (job.logs.length > 80) job.logs = job.logs.slice(-80);
  }
  log('INFO', 'comments', msg);
}

function readJobs(): CommentCrawlJob[] {
  try {
    if (!fs.existsSync(SESSIONS_FILE)) return [];
    const parsed = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    return Array.isArray(parsed) ? (parsed as CommentCrawlJob[]) : [];
  } catch {
    return [];
  }
}

function saveJobs(jobs: CommentCrawlJob[]) {
  fs.mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true });
  const trimmed = jobs.slice(0, 30);
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(trimmed, null, 2), 'utf8');
}

function upsertJob(job: CommentCrawlJob) {
  const list = readJobs();
  const idx = list.findIndex((x) => x.id === job.id);
  if (idx >= 0) list[idx] = job;
  else list.unshift(job);
  saveJobs(list);
}

export function listCommentCrawlJobs(): Array<Omit<CommentCrawlJob, 'comments'> & { commentCount: number }> {
  return readJobs().map((j) => ({
    id: j.id,
    platform: j.platform,
    mode: j.mode,
    input: j.input,
    status: j.status,
    message: j.message,
    logs: j.logs.slice(-15),
    aiSummary: j.aiSummary || null,
    createdAt: j.createdAt,
    finishedAt: j.finishedAt || null,
    commentCount: j.comments.length,
  }));
}

export function getCommentCrawlJob(id: string): CommentCrawlJob | null {
  return readJobs().find((j) => j.id === id) || null;
}

export function deleteCommentCrawlJob(id: string): boolean {
  const list = readJobs();
  const next = list.filter((j) => j.id !== id);
  if (next.length === list.length) return false;
  saveJobs(next);
  return true;
}

export function getConfiguredMediaCrawlerDir(): string {
  const db = getDb();
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'media_crawler_dir'").get() as { value: string } | undefined;
  const configured = (row?.value || '').trim();
  if (configured && fs.existsSync(path.join(configured, 'main.py'))) {
    return configured;
  }
  return PATHS.defaultMediaCrawlerDir;
}

export function getMediaCrawlerStatus(): MediaCrawlerStatus {
  const dir = getConfiguredMediaCrawlerDir();
  const pythonExe = path.join(dir, '.venv', 'Scripts', 'python.exe');
  const mainPy = path.join(dir, 'main.py');
  const installed = fs.existsSync(pythonExe) && fs.existsSync(mainPy);
  let gitCommit = 'unknown';
  if (installed) {
    try {
      gitCommit = execFileSync('git', ['-C', dir, 'log', '-1', '--format=%h (%cs)'], {
        encoding: 'utf8',
        timeout: 4000,
      }).trim();
    } catch {
      gitCommit = 'unknown';
    }
  }
  return {
    installed,
    dir,
    pythonExe,
    gitCommit,
    running: runningCrawler,
    currentTask: currentTaskDesc,
    lastLog: lastLogs.slice(-25),
    lastError: lastErrorMsg,
  };
}

function mapToCrawlerPlatform(platform: string): 'dy' | 'bili' | 'xhs' | 'ks' | 'wb' | 'zhihu' | null {
  if (platform === 'douyin' || platform === 'dy') return 'dy';
  if (platform === 'bilibili' || platform === 'bili') return 'bili';
  if (platform === 'kuaishou' || platform === 'ks') return 'ks';
  if (platform === 'xiaohongshu' || platform === 'xhs') return 'xhs';
  return null;
}

function findRecentJsonFiles(dir: string, sinceMs: number, pattern: RegExp): string[] {
  if (!fs.existsSync(dir)) return [];
  const matched: Array<{ file: string; mtime: number }> = [];
  const walk = (d: string, depth: number) => {
    if (depth > 3) return;
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) walk(full, depth + 1);
      else if (ent.isFile() && /\.(json|jsonl)$/i.test(ent.name) && pattern.test(ent.name)) {
        const st = fs.statSync(full);
        if (st.mtimeMs >= sinceMs - 5000) matched.push({ file: full, mtime: st.mtimeMs });
      }
    }
  };
  walk(dir, 0);
  return matched.sort((a, b) => b.mtime - a.mtime).map((m) => m.file);
}

function parseJsonOrJsonl(filePath: string): Array<Record<string, unknown>> {
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) return [];
  if (filePath.toLowerCase().endsWith('.jsonl') || !raw.startsWith('[')) {
    const out: Array<Record<string, unknown>> = [];
    for (const line of raw.split(/\r?\n/)) {
      const s = line.trim();
      if (!s) continue;
      try {
        const obj = JSON.parse(s);
        if (obj && typeof obj === 'object') out.push(obj as Record<string, unknown>);
      } catch {
        // ignore bad line
      }
    }
    return out;
  }
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [];
}

function toIntOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  if (typeof v === 'string') {
    const cleaned = v.replace(/,/g, '').trim();
    if (!cleaned) return null;
    const n = Number(cleaned);
    if (Number.isFinite(n)) return Math.round(n);
  }
  return null;
}

// 从 B站 reply 响应结构中提取评论条目（兼容 /x/v2/reply、/x/v2/reply/main 与 /x/v2/reply/wbi/main）
function collectBilibiliRepliesFromPayload(
  payload: unknown,
  postTitle: string,
  postUrl: string,
  map: Map<string, CrawledCommentRow>
): number {
  if (!payload || typeof payload !== 'object') return 0;
  const data = (payload as { data?: Record<string, unknown> }).data;
  if (!data || typeof data !== 'object') return 0;

  type BiliReplyNode = {
    rpid_str?: string;
    rpid?: number;
    like?: number;
    ctime?: number;
    member?: { uname?: string };
    content?: { message?: string };
    replies?: BiliReplyNode[];
  };

  const buckets: BiliReplyNode[] = [];
  const topUpper = (data.top as { upper?: BiliReplyNode } | undefined)?.upper;
  if (topUpper) buckets.push(topUpper);
  if (Array.isArray(data.top_replies)) buckets.push(...(data.top_replies as BiliReplyNode[]));
  if (Array.isArray(data.hots)) buckets.push(...(data.hots as BiliReplyNode[]));
  if (Array.isArray(data.replies)) buckets.push(...(data.replies as BiliReplyNode[]));

  let added = 0;
  const addNode = (r: BiliReplyNode) => {
    const id = String(r?.rpid_str || r?.rpid || '').trim();
    const text = String(r?.content?.message || '').trim();
    if (!id || !text || map.has(id)) return;
    map.set(id, {
      id,
      author: String(r?.member?.uname || 'B站用户').trim(),
      text: text.slice(0, 1000),
      likes: Number(r?.like || 0),
      publishedAt: r?.ctime ? new Date(r.ctime * 1000).toISOString() : null,
      postTitle,
      postUrl,
    });
    added++;
  };

  for (const r of buckets) {
    addNode(r);
    if (Array.isArray(r?.replies)) {
      for (const sub of r.replies.slice(0, 2)) {
        if (Number(sub?.like || 0) >= 3) addNode(sub);
      }
    }
  }
  return added;
}

// ===== 直采通道 1：B站高赞热评抓取（优先复用登录态拉全量，未登录自动走独立浏览器真签名 WBI 突破 3 条限制） =====
async function fetchBilibiliCommentsDirect(urlOrBvid: string, maxComments = 30, job?: CommentCrawlJob): Promise<{
  comments: CrawledCommentRow[];
  postTitle: string;
  postUrl: string;
}> {
  let cleanUrl = extractUrlFromShareText(urlOrBvid);
  if (cleanUrl.includes('b23.tv')) {
    const r = await resolveShortSourceUrl(cleanUrl);
    cleanUrl = r.resolvedUrl;
  }
  const bvMatch = cleanUrl.match(/(BV[a-zA-Z0-9]+)/i);
  if (!bvMatch) {
    throw new Error('未识别到 B 站视频 BV 号（请粘贴 B 站视频链接或 BV 号）');
  }
  const bvid = bvMatch[1];
  const postUrl = `https://www.bilibili.com/video/${bvid}`;
  pushLog(`B站读取视频信息与高赞热评：${bvid}`, job);

  const baseHeaders: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/134.0.0.0 Safari/537.36',
    Referer: postUrl,
  };
  const sauBili = loadLatestSauPlatformCookies('bilibili');
  if (sauBili.found && sauBili.cookies.length > 0) {
    baseHeaders.Cookie = sauBili.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  const viewRes = (await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, {
    headers: baseHeaders,
    signal: AbortSignal.timeout(12000),
  }).then((r) => r.json())) as { code?: number; data?: { aid?: number; title?: string } };

  const aid = viewRes?.data?.aid;
  const postTitle = (viewRes?.data?.title || bvid).trim();
  if (!aid) throw new Error('未能获取到该 B 站视频的 AID');

  const map = new Map<string, CrawledCommentRow>();

  // 1) 若已带 B站登录 Cookie，优先走官方 cursor 接口毫秒级拉取 20~30+ 热评
  if (baseHeaders.Cookie) {
    let nextCursor = 0;
    for (let pageNo = 0; pageNo < 3 && map.size < maxComments; pageNo++) {
      try {
        const rep = (await fetch(
          `https://api.bilibili.com/x/v2/reply/main?type=1&oid=${aid}&mode=3&next=${nextCursor}&ps=20`,
          { headers: baseHeaders, signal: AbortSignal.timeout(12000) }
        ).then((r) => r.json())) as { code?: number; data?: { cursor?: { next?: number; is_end?: boolean } } };
        if (rep?.code !== 0) break;
        const added = collectBilibiliRepliesFromPayload(rep, postTitle, postUrl, map);
        const cursor = rep?.data?.cursor;
        if (!added || cursor?.is_end || cursor?.next == null || cursor.next === nextCursor) break;
        nextCursor = cursor.next;
      } catch {
        break;
      }
    }
  }

  // 2) 若接口受匿名限制仅返回 <= 6 条，启动独立 B站浏览器让页面原生 WBI 签名拉出完整高赞热评
  if (map.size < Math.min(12, maxComments)) {
    try {
      pushLog(`B站接口仅返回 ${map.size} 条，启动独立浏览器拦截完整热评区...`, job);
      await withHeadlessContext(
        'bilibili',
        `comments:${bvid}`,
        async (ctx) => {
          const page = ctx.pages()[0] || (await ctx.newPage());
          page.on('response', async (resp) => {
            const u = resp.url();
            if (!/api\.bilibili\.com\/x\/v2\/reply/i.test(u)) return;
            try {
              const txt = await resp.text();
              if (!txt || !txt.startsWith('{')) return;
              const j = JSON.parse(txt);
              collectBilibiliRepliesFromPayload(j, postTitle, postUrl, map);
            } catch {
              // ignore non-json
            }
          });

          await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.waitForTimeout(1800);

          let staleRounds = 0;
          for (let round = 0; round < 5 && map.size < maxComments; round++) {
            const before = map.size;
            await page
              .evaluate((r) => {
                window.scrollBy(0, r === 0 ? 1100 : 1400);
              }, round)
              .catch(() => {});
            await page.waitForTimeout(1500);
            if (map.size > before) {
              staleRounds = 0;
            } else {
              staleRounds++;
              if (staleRounds >= 2 && map.size >= 8) break;
            }
          }
        },
        { headless: true }
      );
    } catch (err) {
      pushLog(`B站浏览器拦截热评降级提示：${(err as Error).message}`, job);
    }
  }

  // 3) 兜底再补一次公开 /x/v2/reply，保证至少能拿到基础热评
  if (map.size < 3) {
    try {
      const rep = await fetch(`https://api.bilibili.com/x/v2/reply?type=1&oid=${aid}&sort=2&ps=20&pn=1`, {
        headers: baseHeaders,
        signal: AbortSignal.timeout(12000),
      }).then((r) => r.json());
      collectBilibiliRepliesFromPayload(rep, postTitle, postUrl, map);
    } catch {
      // ignore
    }
  }

  const out = Array.from(map.values())
    .sort((a, b) => b.likes - a.likes)
    .slice(0, maxComments);

  pushLog(`B站热评抓取完成：拉回 ${out.length} 条真实高赞评论`, job);
  return { comments: out, postTitle, postUrl };
}

// 解析抖音视频短链（v.douyin.com）为标准 https://www.douyin.com/video/<id>
async function resolveDouyinVideoUrl(raw: string): Promise<{ videoId: string; videoUrl: string }> {
  let clean = extractUrlFromShareText(raw);
  const direct = clean.match(/\/video\/(\d{15,22})/) || clean.match(/\b(\d{18,22})\b/);
  if (direct) {
    return { videoId: direct[1], videoUrl: `https://www.douyin.com/video/${direct[1]}` };
  }
  if (/v\.douyin\.com|iesdouyin\.com/i.test(clean)) {
    let cur = clean;
    for (let i = 0; i < 4; i++) {
      const res = await fetch(cur, {
        redirect: 'manual',
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
        },
        signal: AbortSignal.timeout(10000),
      });
      const loc = res.headers.get('location');
      if (!loc) break;
      cur = new URL(loc, cur).toString();
      const m = cur.match(/\/(?:share\/)?video\/(\d{15,22})/);
      if (m) return { videoId: m[1], videoUrl: `https://www.douyin.com/video/${m[1]}` };
    }
  }
  throw new Error('未识别到抖音视频 ID，请粘贴抖音单条视频链接或分享口令');
}

// ===== 直采通道 2：抖音独立浏览器拦截 /aweme/v1/web/comment/list/（免接管日常 Chrome，稳定秒抓） =====
async function fetchDouyinCommentsDirect(rawInput: string, maxComments = 30, job?: CommentCrawlJob): Promise<{
  comments: CrawledCommentRow[];
  postTitle: string;
  postUrl: string;
}> {
  const { videoId, videoUrl } = await resolveDouyinVideoUrl(rawInput);
  pushLog(`抖音独立浏览器直采评论：${videoUrl}`, job);

  const res = await withHeadlessContext(
    'douyin',
    `comments:${videoId}`,
    async (ctx) => {
      const page = ctx.pages()[0] || (await ctx.newPage());
      const map = new Map<string, CrawledCommentRow>();
      let title = `抖音视频 ${videoId}`;

      page.on('response', async (resp) => {
        const u = resp.url();
        if (!u.includes('/aweme/v1/web/comment/list')) return;
        try {
          const txt = await resp.text();
          if (!txt || !txt.startsWith('{')) return;
          const j = JSON.parse(txt) as {
            comments?: Array<{
              cid?: string;
              text?: string;
              digg_count?: number;
              create_time?: number;
              user?: { nickname?: string };
              reply_comment?: Array<{
                cid?: string;
                text?: string;
                digg_count?: number;
                create_time?: number;
                user?: { nickname?: string };
              }>;
            }>;
          };
          for (const c of j.comments || []) {
            const id = String(c.cid || '').trim();
            const text = (c.text || '').trim();
            if (id && text && !map.has(id)) {
              map.set(id, {
                id,
                author: (c.user?.nickname || '抖音观众').trim(),
                text: text.slice(0, 1000),
                likes: Number(c.digg_count || 0),
                publishedAt: c.create_time ? new Date(c.create_time * 1000).toISOString() : null,
                postUrl: videoUrl,
              });
            }
            for (const rc of c.reply_comment || []) {
              const rid = String(rc.cid || '').trim();
              const rtext = (rc.text || '').trim();
              if (rid && rtext && !map.has(rid)) {
                map.set(rid, {
                  id: rid,
                  author: (rc.user?.nickname || '抖音观众').trim(),
                  text: rtext.slice(0, 1000),
                  likes: Number(rc.digg_count || 0),
                  publishedAt: rc.create_time ? new Date(rc.create_time * 1000).toISOString() : null,
                  postUrl: videoUrl,
                });
              }
            }
          }
        } catch {
          // ignore
        }
      });

      await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      for (let i = 0; i < 12; i++) {
        await page.waitForTimeout(500);
        if (map.size >= 10) break;
        // 若进入页面后评论区被折叠，第 3 秒尝试轻点一次评论按钮展开
        if (i === 5 && map.size === 0) {
          await page
            .evaluate(() => {
              const btn = document.querySelector(
                '[data-e2e="feed-comment-icon"], [data-e2e="video-player-comment-btn"]'
              ) as HTMLElement | null;
              if (btn) btn.click();
            })
            .catch(() => {});
        }
      }

      // 多轮滚动真实评论容器与页面主体，拉足 20~35 条高赞评论（连续 2 轮无新增自动收尾）
      let staleRounds = 0;
      for (let round = 0; round < 5 && map.size < maxComments; round++) {
        const before = map.size;
        await page
          .evaluate(() => {
            window.scrollBy(0, 1200);
            const list = document.querySelector('[data-e2e="comment-list"]') as HTMLElement | null;
            if (list) {
              list.scrollTop += 1600;
              let parent = list.parentElement;
              for (let depth = 0; depth < 5 && parent; depth++) {
                if (parent.scrollHeight > parent.clientHeight + 40) {
                  parent.scrollTop += 1600;
                }
                parent = parent.parentElement;
              }
            }
          })
          .catch(() => {});
        await page.waitForTimeout(1400);
        if (map.size > before) {
          staleRounds = 0;
        } else {
          staleRounds++;
          if (staleRounds >= 2) break;
        }
      }

      const pageTitle = await page.title().catch(() => '');
      if (pageTitle) title = pageTitle.replace(/\s*-\s*抖音.*$/, '').trim() || title;

      const list = Array.from(map.values())
        .map((c) => ({ ...c, postTitle: title }))
        .sort((a, b) => b.likes - a.likes)
        .slice(0, maxComments);

      return { comments: list, postTitle: title };
    },
    { headless: true }
  );

  pushLog(`抖音直采完成：拉回 ${res.comments.length} 条真实热评`, job);
  return { comments: res.comments, postTitle: res.postTitle, postUrl: videoUrl };
}

// ===== 通用通道 3：调用本机最新版 MediaCrawler 子进程（支持关键词批量搜索、小红书、快手与博主深度采集） =====
async function runMediaCrawlerCli(params: {
  platform: 'dy' | 'bili' | 'xhs' | 'ks' | 'wb' | 'zhihu';
  type: 'detail' | 'search' | 'creator';
  input: string;
  maxComments: number;
  maxPosts?: number;
  headless: boolean;
  job?: CommentCrawlJob;
}): Promise<{ comments: CrawledCommentRow[]; exitCode: number; contentFiles: string[] }> {
  const status = getMediaCrawlerStatus();
  if (!status.installed) {
    throw new Error(`未检测到本机评论采集核心目录（${status.dir}）`);
  }

  const startedMs = Date.now();
  const args = [
    'main.py',
    '--platform',
    params.platform,
    '--type',
    params.type,
    '--lt',
    'qrcode',
    '--get_comment',
    'true',
    '--get_sub_comment',
    'false',
    '--max_comments_count_singlenotes',
    String(Math.max(5, Math.min(params.maxComments || 25, 100))),
    '--save_data_option',
    'json',
    '--headless',
    params.headless ? 'true' : 'false',
  ];

  if (params.type === 'detail') {
    args.push('--specified_id', extractUrlFromShareText(params.input));
  } else if (params.type === 'search') {
    args.push('--keywords', params.input.trim());
  } else if (params.type === 'creator') {
    args.push('--creator_id', extractUrlFromShareText(params.input));
  }

  pushLog(`启动 MediaCrawler [${params.platform}/${params.type}]（${params.headless ? '后台无头' : '可视化窗口便于扫码'}）`, params.job);

  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(status.pythonExe, args, {
      cwd: status.dir,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      windowsHide: params.headless,
    });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('采集执行超过 180 秒超时（若是首次采集小红书/快手，请勾选“弹出扫码窗口”先扫码登录一次）'));
    }, 180000);

    child.stdout.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/).filter(Boolean).slice(-4)) {
        pushLog(line.slice(0, 180), params.job);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/).filter(Boolean).slice(-3)) {
        pushLog(`[stderr] ${line.slice(0, 180)}`, params.job);
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });

  const dataRoot = path.join(status.dir, 'data');
  const commentFiles = findRecentJsonFiles(dataRoot, startedMs, /comment/i);
  const contentFiles = findRecentJsonFiles(dataRoot, startedMs, /content/i);

  const postTitleMap = new Map<string, { title: string; url: string }>();
  for (const cf of contentFiles.slice(0, 3)) {
    try {
      for (const item of parseJsonOrJsonl(cf)) {
        const pid = String(item.aweme_id || item.note_id || item.video_id || item.bvid || item.id || '').trim();
        const title = String(item.title || item.desc || '').trim();
        const url = String(item.note_url || item.aweme_url || item.video_url || '').trim();
        if (pid) postTitleMap.set(pid, { title: title.slice(0, 100), url });
      }
    } catch {
      // ignore
    }
  }

  const out: CrawledCommentRow[] = [];
  const seen = new Set<string>();
  for (const file of commentFiles.slice(0, 3)) {
    try {
      for (const obj of parseJsonOrJsonl(file)) {
        const cid = String(obj.comment_id || obj.rpid || obj.id || '').trim();
        const text = String(obj.content || obj.text || obj.message || '').trim();
        if (!cid || !text || seen.has(cid)) continue;
        seen.add(cid);
        const pid = String(obj.aweme_id || obj.note_id || obj.video_id || '').trim();
        const meta = postTitleMap.get(pid);
        const createTs = toIntOrNull(obj.create_time ?? obj.ctime);
        out.push({
          id: cid,
          author: String(obj.nickname || obj.uname || obj.author || '匿名观众').trim(),
          text: text.slice(0, 1000),
          likes: toIntOrNull(obj.like_count ?? obj.comment_like_count ?? obj.likes) || 0,
          publishedAt: createTs ? new Date(createTs > 1e12 ? createTs : createTs * 1000).toISOString() : null,
          postTitle: meta?.title || undefined,
          postUrl: meta?.url || undefined,
        });
      }
    } catch {
      // skip
    }
  }

  out.sort((a, b) => b.likes - a.likes);
  return { comments: out, exitCode, contentFiles };
}

/**
 * 抽屉内「抓取真实热评」入口：优先用 B站公开接口 / 抖音独立浏览器直采（零配置秒级返回），
 * 仅在快手/小红书或直采为空时自动回退到 MediaCrawler 子进程。
 */
export async function fetchCommentsWithMediaCrawler(contentId: number): Promise<{
  ok: boolean;
  commentsImported: number;
  metricsUpdated: boolean;
  message: string;
}> {
  if (runningCrawler) {
    return { ok: false, commentsImported: 0, metricsUpdated: false, message: `评论采集正在忙：${currentTaskDesc}` };
  }

  const db = getDb();
  const content = db
    .prepare('SELECT id, source_id, platform, platform_item_id, canonical_url, title FROM contents WHERE id = ?')
    .get(contentId) as
    | { id: number; source_id: number; platform: string; platform_item_id: string | null; canonical_url: string; title: string }
    | undefined;
  if (!content) {
    return { ok: false, commentsImported: 0, metricsUpdated: false, message: '内容不存在' };
  }

  const crawlerPlatform = mapToCrawlerPlatform(content.platform);
  if (!crawlerPlatform) {
    return {
      ok: false,
      commentsImported: 0,
      metricsUpdated: false,
      message: `平台「${content.platform}」暂不支持自动抓取评论`,
    };
  }

  const targetUrl = content.canonical_url || content.platform_item_id || '';
  if (!targetUrl) {
    return { ok: false, commentsImported: 0, metricsUpdated: false, message: '缺少作品链接' };
  }

  runningCrawler = true;
  currentTaskDesc = `[${content.platform}] 抓热评：${content.title.slice(0, 24)}`;
  lastErrorMsg = null;

  try {
    let fetched: CrawledCommentRow[] = [];
    let contentFiles: string[] = [];

    if (content.platform === 'bilibili') {
      const r = await fetchBilibiliCommentsDirect(targetUrl, 30);
      fetched = r.comments;
    } else if (content.platform === 'douyin') {
      if (!/\/video\/\d+/.test(targetUrl)) {
        return {
          ok: false,
          commentsImported: 0,
          metricsUpdated: false,
          message: '该条目是抖音热搜词条（非单条视频），请到左侧「评论采集」页用“关键词模式”批量抓评论',
        };
      }
      const r = await fetchDouyinCommentsDirect(targetUrl, 30);
      fetched = r.comments;
    }

    // 直采未命中或是快手/小红书时，回退至 MediaCrawler
    if (fetched.length === 0 && getMediaCrawlerStatus().installed) {
      const cliRes = await runMediaCrawlerCli({
        platform: crawlerPlatform,
        type: 'detail',
        input: targetUrl,
        maxComments: 30,
        headless: true,
      });
      fetched = cliRes.comments;
      contentFiles = cliRes.contentFiles;
    }

    const now = new Date().toISOString();
    const insertComment = db.prepare(`
      INSERT INTO content_comments (content_id, platform, platform_comment_id, author, text, likes, published_at, captured_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(content_id, platform_comment_id) DO UPDATE SET
        likes = COALESCE(excluded.likes, content_comments.likes),
        captured_at = excluded.captured_at
    `);

    let imported = 0;
    for (const cm of fetched) {
      insertComment.run(contentId, content.platform, cm.id, cm.author, cm.text, cm.likes, cm.publishedAt, now);
      imported++;
    }

    let metricsUpdated = false;
    for (const file of contentFiles.slice(0, 2)) {
      try {
        for (const obj of parseJsonOrJsonl(file)) {
          const likes = toIntOrNull(obj.liked_count ?? obj.like_count ?? obj.digg_count);
          const comments = toIntOrNull(obj.comment_count ?? obj.comments_count);
          const favorites = toIntOrNull(obj.collected_count ?? obj.collect_count ?? obj.favorite_count);
          const shares = toIntOrNull(obj.share_count ?? obj.shared_count);
          const views = toIntOrNull(obj.play_count ?? obj.view_count ?? obj.video_play_count);
          if ([likes, comments, favorites, shares, views].some((x) => x !== null)) {
            const res = upsertContentWithMetrics({
              sourceId: content.source_id,
              platform: content.platform,
              platformItemId: content.platform_item_id,
              url: content.canonical_url,
              title: content.title,
              metrics: { views, likes, comments, favorites, shares },
            });
            if (res.metricsUpdated) metricsUpdated = true;
            break;
          }
        }
      } catch {
        // ignore
      }
    }

    if (imported === 0) {
      const msg = '暂未抓到公开评论（可能是该作品评论区已关闭，或需要去「评论采集」勾选扫码窗口登录一次）';
      lastErrorMsg = msg;
      return { ok: false, commentsImported: 0, metricsUpdated, message: msg };
    }
    return {
      ok: true,
      commentsImported: imported,
      metricsUpdated,
      message: `已成功拉回 ${imported} 条真实高赞热评！`,
    };
  } catch (err) {
    const msg = (err as Error).message;
    lastErrorMsg = msg;
    pushLog(`热评采集失败: ${msg}`);
    return { ok: false, commentsImported: 0, metricsUpdated: false, message: msg };
  } finally {
    runningCrawler = false;
    currentTaskDesc = null;
  }
}

/**
 * 独立「评论采集」工作台任务入口：支持贴链接 / 关键词批量搜 / 抓博主 3 种模式。
 */
export function startStandaloneCommentCrawl(params: {
  platform: 'douyin' | 'bilibili' | 'xiaohongshu' | 'kuaishou';
  mode: 'detail' | 'search' | 'creator';
  input: string;
  maxComments?: number;
  showBrowser?: boolean;
}): { started: boolean; job?: CommentCrawlJob; message: string } {
  if (!['douyin', 'bilibili', 'xiaohongshu', 'kuaishou'].includes(String(params.platform || ''))) {
    return { started: false, message: '不支持的评论采集平台，仅支持 douyin/bilibili/xiaohongshu/kuaishou' };
  }
  if (!['detail', 'search', 'creator'].includes(String(params.mode || ''))) {
    return { started: false, message: '不支持的采集模式，仅支持 detail/search/creator' };
  }
  if (
    params.maxComments !== undefined &&
    (typeof params.maxComments !== 'number' || !Number.isInteger(params.maxComments) || params.maxComments <= 0)
  ) {
    return { started: false, message: 'maxComments 必须为有效正整数' };
  }
  if (runningCrawler) {
    return { started: false, message: `当前已有评论采集任务在运行：${currentTaskDesc}` };
  }
  const cleanInput = (params.input || '').trim();
  if (!cleanInput) {
    return { started: false, message: '请输入视频链接、关键词或博主主页链接' };
  }

  const job: CommentCrawlJob = {
    id: `cm_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 6)}`,
    platform: params.platform,
    mode: params.mode,
    input: cleanInput,
    status: 'running',
    message: '正在启动评论采集...',
    logs: [],
    comments: [],
    aiSummary: null,
    createdAt: new Date().toISOString(),
  };
  upsertJob(job);

  const maxComments = Math.max(10, Math.min(Number(params.maxComments || 30), 100));

  void (async () => {
    runningCrawler = true;
    currentTaskDesc = `[${params.platform}/${params.mode}] ${cleanInput.slice(0, 26)}`;
    lastErrorMsg = null;
    try {
      let comments: CrawledCommentRow[] = [];

      // 优先走稳定高速的直采通道（单链接 B站/抖音），其余或失败再走 MediaCrawler
      if (params.mode === 'detail' && params.platform === 'bilibili') {
        const r = await fetchBilibiliCommentsDirect(cleanInput, maxComments, job);
        comments = r.comments;
      } else if (params.mode === 'detail' && params.platform === 'douyin') {
        const r = await fetchDouyinCommentsDirect(cleanInput, maxComments, job);
        comments = r.comments;
      } else if (params.mode === 'creator' && (params.platform === 'douyin' || params.platform === 'bilibili')) {
        // 先检查是否已在本机对标博主里，直接取该博主最热 3 条作品并发串行拉热评（极速免风控！）
        const db = getDb();
        const urlCandidate = extractUrlFromShareText(cleanInput);
        const resolved = urlCandidate.startsWith('http') ? (await resolveShortSourceUrl(urlCandidate)).resolvedUrl : cleanInput;
        const matchedSource = db
          .prepare("SELECT id, name FROM sources WHERE platform = ? AND (url = ? OR name LIKE ? ESCAPE '\\') LIMIT 1")
          .get(params.platform, resolved, `%${escapeLikeTerm(cleanInput)}%`) as { id: number; name: string } | undefined;

        if (matchedSource) {
          pushLog(`命中已盯博主「${matchedSource.name}」，直采其最热 3 条作品评论`, job);
          const topWorks = db
            .prepare(`
              SELECT canonical_url, title FROM contents
              WHERE source_id = ?
              ORDER BY COALESCE(breakout_ratio, 0) DESC, discovered_at DESC
              LIMIT 3
            `)
            .all(matchedSource.id) as Array<{ canonical_url: string; title: string }>;
          const perWork = Math.max(10, Math.ceil(maxComments / Math.max(1, topWorks.length)));
          for (const w of topWorks) {
            try {
              const r =
                params.platform === 'bilibili'
                  ? await fetchBilibiliCommentsDirect(w.canonical_url, perWork, job)
                  : await fetchDouyinCommentsDirect(w.canonical_url, perWork, job);
              comments.push(...r.comments);
            } catch (e) {
              pushLog(`跳过一条异常作品：${(e as Error).message}`, job);
            }
          }
          comments.sort((a, b) => b.likes - a.likes);
        }
      }

      if (comments.length === 0) {
        const mp = mapToCrawlerPlatform(params.platform);
        if (!mp) throw new Error(`暂不支持平台：${params.platform}`);
        const cliRes = await runMediaCrawlerCli({
          platform: mp,
          type: params.mode,
          input: cleanInput,
          maxComments,
          headless: !params.showBrowser,
          job,
        });
        comments = cliRes.comments;
      }

      job.comments = comments;
      job.status = comments.length > 0 ? 'done' : 'failed';
      job.message =
        comments.length > 0
          ? `采集完成，共抓到 ${comments.length} 条真实评论`
          : '未抓到评论（若是小红书/快手或关键词搜索，请勾选「需要扫码时弹出浏览器窗口」后再试一次）';
      job.finishedAt = new Date().toISOString();
      upsertJob(job);
    } catch (err) {
      const msg = (err as Error).message;
      lastErrorMsg = msg;
      pushLog(`采集出错: ${msg}`, job);
      job.status = 'failed';
      job.message = msg;
      job.finishedAt = new Date().toISOString();
      upsertJob(job);
    } finally {
      runningCrawler = false;
      currentTaskDesc = null;
    }
  })();

  return { started: true, job, message: '评论采集任务已启动，下方实时更新进度' };
}

// 用本机 8317 大模型一键提炼评论区高频痛点、观众提问与可拍选题
export async function analyzeCommentCrawlJob(jobId: string): Promise<CommentCrawlJob['aiSummary']> {
  const job = getCommentCrawlJob(jobId);
  if (!job) throw new Error('采集任务不存在');
  if (job.comments.length === 0) throw new Error('该任务暂无评论可供分析');

  const topLines = job.comments
    .slice(0, 45)
    .map((c, idx) => `${idx + 1}. [👍${c.likes}] ${c.text}`)
    .join('\n');

  const { data } = await callAiJsonWithCache<{
    topQuestions?: string[];
    painPoints?: string[];
    topicAngles?: string[];
    oneLineTakeaway?: string;
  }>({
    purpose: 'comment_pain_analysis',
    system:
      '你是资深自媒体选题与评论区洞察专家。根据真实高赞评论，提炼观众最关心的具体问题、核心吐槽痛点，以及创作者可以直接拍的新选题角度。只输出严格 JSON，严禁编造评论中没有的内容。',
    user: `请分析以下来自「${job.platform}」（主题：${job.input}）的真实高赞评论，输出 JSON：
{
  "oneLineTakeaway": "一句话总结评论区最大情绪或共识（<=45字）",
  "topQuestions": ["观众问得最多的3-4个具体问题"],
  "painPoints": ["观众吐槽或纠结的3-4个核心痛点"],
  "topicAngles": ["创作者可以直接回应或开拍的3个爆款视频切入角度"]
}

真实评论列表：
${topLines}`,
    temperature: 0.25,
    maxTokens: 1000,
  });

  const summary = {
    oneLineTakeaway: String(data.oneLineTakeaway || '').trim() || '评论区讨论高度集中在实操与避坑问题。',
    topQuestions: Array.isArray(data.topQuestions) ? data.topQuestions.map(String).filter(Boolean).slice(0, 5) : [],
    painPoints: Array.isArray(data.painPoints) ? data.painPoints.map(String).filter(Boolean).slice(0, 5) : [],
    topicAngles: Array.isArray(data.topicAngles) ? data.topicAngles.map(String).filter(Boolean).slice(0, 4) : [],
    analyzedAt: new Date().toISOString(),
  };

  job.aiSummary = summary;
  upsertJob(job);
  return summary;
}
