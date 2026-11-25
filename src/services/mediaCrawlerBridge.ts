import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { PATHS } from '../config.js';
import { getDb, upsertContentWithMetrics } from '../db/database.js';
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

let runningCrawler = false;
let currentTaskDesc: string | null = null;
let lastLogs: string[] = [];
let lastErrorMsg: string | null = null;

function pushLog(msg: string) {
  const line = `[${new Date().toLocaleTimeString('zh-CN')}] ${msg}`;
  lastLogs.push(line);
  if (lastLogs.length > 80) lastLogs = lastLogs.slice(-80);
  log('INFO', 'mediacrawler', msg);
}

export function getConfiguredMediaCrawlerDir(): string {
  const db = getDb();
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'media_crawler_dir'").get() as { value: string } | undefined;
  return (row?.value || PATHS.defaultMediaCrawlerDir).trim();
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
  if (platform === 'douyin') return 'dy';
  if (platform === 'bilibili') return 'bili';
  if (platform === 'kuaishou') return 'ks';
  if (platform === 'xiaohongshu') return 'xhs';
  return null;
}

function findRecentJsonFiles(dir: string, sinceMs: number, pattern: RegExp): string[] {
  if (!fs.existsSync(dir)) return [];
  const matched: Array<{ file: string; mtime: number }> = [];
  const walk = (d: string, depth: number) => {
    if (depth > 3) return;
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) {
        walk(full, depth + 1);
      } else if (ent.isFile() && ent.name.endsWith('.json') && pattern.test(ent.name)) {
        const st = fs.statSync(full);
        if (st.mtimeMs >= sinceMs - 5000) {
          matched.push({ file: full, mtime: st.mtimeMs });
        }
      }
    }
  };
  walk(dir, 0);
  return matched.sort((a, b) => b.mtime - a.mtime).map((m) => m.file);
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

/**
 * 无端口集成最新版 MediaCrawler：按需以子进程方式抓取指定作品的真实评论和详细互动指标。
 * 绝不另起 8089 WebUI 服务，抓完自动落库并退出子进程。
 */
export async function fetchCommentsWithMediaCrawler(contentId: number): Promise<{
  ok: boolean;
  commentsImported: number;
  metricsUpdated: boolean;
  message: string;
}> {
  if (runningCrawler) {
    return { ok: false, commentsImported: 0, metricsUpdated: false, message: `采集中心正在忙：${currentTaskDesc}` };
  }

  const status = getMediaCrawlerStatus();
  if (!status.installed) {
    return {
      ok: false,
      commentsImported: 0,
      metricsUpdated: false,
      message: `未找到 MediaCrawler（检查路径: ${status.dir}）`,
    };
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
      message: `平台「${content.platform}」暂不需要通过 MediaCrawler 抓评论`,
    };
  }

  const targetId = content.canonical_url || content.platform_item_id || '';
  if (!targetId) {
    return { ok: false, commentsImported: 0, metricsUpdated: false, message: '缺少作品链接或作品 ID' };
  }

  runningCrawler = true;
  currentTaskDesc = `[${crawlerPlatform}] 评论深采：${content.title.slice(0, 26)}`;
  lastErrorMsg = null;
  const startedMs = Date.now();
  pushLog(`启动无端口 MediaCrawler 子进程：${currentTaskDesc}`);

  try {
    const args = [
      'main.py',
      '--platform',
      crawlerPlatform,
      '--type',
      'detail',
      '--specified_id',
      targetId,
      '--get_comment',
      'true',
      '--get_sub_comment',
      'false',
      '--max_comments_count_singlenotes',
      '30',
      '--save_data_option',
      'json',
      '--headless',
      'true',
    ];

    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(status.pythonExe, args, {
        cwd: status.dir,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        windowsHide: true,
      });

      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('MediaCrawler 执行超时（超过 150 秒），可能需要扫码登录或遇到平台验证码'));
      }, 150000);

      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8').trim();
        for (const line of text.split(/\r?\n/).filter(Boolean).slice(-4)) {
          pushLog(line.slice(0, 180));
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8').trim();
        for (const line of text.split(/\r?\n/).filter(Boolean).slice(-3)) {
          pushLog(`[stderr] ${line.slice(0, 180)}`);
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

    // 扫描本次落盘的评论与内容 JSON
    const dataRoot = path.join(status.dir, 'data');
    const commentFiles = findRecentJsonFiles(dataRoot, startedMs, /comment/i);
    const contentFiles = findRecentJsonFiles(dataRoot, startedMs, /content/i);

    let commentsImported = 0;
    const now = new Date().toISOString();
    const insertComment = db.prepare(`
      INSERT INTO content_comments (content_id, platform, platform_comment_id, author, text, likes, published_at, captured_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(content_id, platform_comment_id) DO UPDATE SET
        likes = COALESCE(excluded.likes, content_comments.likes),
        captured_at = excluded.captured_at
    `);

    for (const file of commentFiles.slice(0, 2)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        const list = Array.isArray(parsed) ? parsed : [];
        for (const c of list) {
          if (!c || typeof c !== 'object') continue;
          const obj = c as Record<string, unknown>;
          const cid = String(obj.comment_id || obj.rpid || obj.id || '').trim();
          const text = String(obj.content || obj.text || obj.message || '').trim();
          if (!cid || !text) continue;
          const author = String(obj.nickname || obj.uname || obj.author || '').trim();
          const likes = toIntOrNull(obj.like_count ?? obj.comment_like_count ?? obj.likes);
          const createTs = toIntOrNull(obj.create_time ?? obj.ctime);
          const pubIso = createTs ? new Date(createTs > 1e12 ? createTs : createTs * 1000).toISOString() : null;
          insertComment.run(contentId, content.platform, cid, author, text.slice(0, 1000), likes, pubIso, now);
          commentsImported++;
        }
      } catch {
        // 跳过损坏文件
      }
    }

    // 顺手用本次 detail 结果补齐作品互动指标（如抖音评论数/收藏数/转发数）
    let metricsUpdated = false;
    for (const file of contentFiles.slice(0, 2)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        const list = Array.isArray(parsed) ? parsed : [];
        for (const item of list) {
          if (!item || typeof item !== 'object') continue;
          const obj = item as Record<string, unknown>;
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

    pushLog(`评论采集完成 (exit=${exitCode})：入库 ${commentsImported} 条真实评论`);
    if (commentsImported === 0 && exitCode !== 0) {
      const msg = 'MediaCrawler 未采到评论（可能是平台需要扫码更新登录态，请先在「浏览器与登录」中检查）';
      lastErrorMsg = msg;
      return { ok: false, commentsImported: 0, metricsUpdated, message: msg };
    }
    return {
      ok: true,
      commentsImported,
      metricsUpdated,
      message:
        commentsImported > 0
          ? `已通过最新版 MediaCrawler 采回 ${commentsImported} 条真实评论${metricsUpdated ? '并刷新互动数据' : ''}`
          : '任务执行结束但该作品暂未返回公开评论（可能需要先更新平台登录态）',
    };
  } catch (err) {
    const msg = (err as Error).message;
    lastErrorMsg = msg;
    pushLog(`失败: ${msg}`);
    return { ok: false, commentsImported: 0, metricsUpdated: false, message: msg };
  } finally {
    runningCrawler = false;
    currentTaskDesc = null;
  }
}
