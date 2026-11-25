import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { PATHS } from '../config.js';
import { getDb } from '../db/database.js';
import { log } from '../utils/logger.js';

export interface TingwuStatus {
  installed: boolean;
  dir: string;
  scriptPath: string;
  profileExists: boolean;
  ytDlpAvailable: boolean;
  ffmpegAvailable: boolean;
  running: boolean;
  currentJob: string | null;
  lastLogs: string[];
}

let tingwuRunning = false;
let currentJobLabel: string | null = null;
let tingwuLogs: string[] = [];

function addLog(msg: string) {
  const line = `[${new Date().toLocaleTimeString('zh-CN')}] ${msg}`;
  tingwuLogs.push(line);
  if (tingwuLogs.length > 60) tingwuLogs = tingwuLogs.slice(-60);
  log('INFO', 'tingwu', msg);
}

export function getConfiguredTingwuDir(): string {
  const db = getDb();
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'tingwu_dir'").get() as { value: string } | undefined;
  return (row?.value || PATHS.defaultTingwuDir).trim();
}

function hasExecutable(name: string): boolean {
  try {
    execFileSync('where', [name], { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

export function getTingwuStatus(): TingwuStatus {
  const dir = getConfiguredTingwuDir();
  const scriptPath = path.join(dir, 'src', 'tingwu.mjs');
  const installed = fs.existsSync(scriptPath);
  const profileDir = path.join(process.env.LOCALAPPDATA || os.homedir(), 'TingwuWebBatch', 'browser-profile');
  return {
    installed,
    dir,
    scriptPath,
    profileExists: fs.existsSync(profileDir),
    ytDlpAvailable: hasExecutable('yt-dlp'),
    ffmpegAvailable: hasExecutable('ffmpeg'),
    running: tingwuRunning,
    currentJob: currentJobLabel,
    lastLogs: tingwuLogs.slice(-20),
  };
}

// 弹出通义听悟登录窗口（复用用户本机已验证的 tingwu.mjs login）
export function launchTingwuLogin(): { started: boolean; message: string } {
  const st = getTingwuStatus();
  if (!st.installed) {
    return { started: false, message: `未找到通义听悟转写工具：${st.scriptPath}` };
  }
  const child = spawn(process.execPath, [st.scriptPath, 'login'], {
    cwd: st.dir,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  addLog('已弹出通义听悟登录窗口，登录完成后窗口将自动关闭');
  return { started: true, message: '已打开通义听悟登录窗口，请在窗口中完成登录（只需登录一次）' };
}

function runCommandAsync(
  exe: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  onOutput?: (line: string) => void
): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, {
      cwd,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
    });
    let output = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`命令执行超时（${Math.round(timeoutMs / 1000)} 秒）`));
    }, timeoutMs);

    const handle = (chunk: Buffer) => {
      const s = chunk.toString('utf8');
      output += s;
      for (const l of s.split(/\r?\n/).filter(Boolean)) {
        onOutput?.(l);
      }
    };
    child.stdout.on('data', handle);
    child.stderr.on('data', handle);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output });
    });
  });
}

/**
 * 单端口一键「视频抽音频 → 通义听悟网页额度转写 → 口播逐字稿自动回库」。
 * 后台异步执行，立即返回 jobId 便于界面追踪状态，绝不阻塞主工作台。
 */
export function startTingwuTranscription(contentId: number): {
  started: boolean;
  jobId?: number;
  message: string;
} {
  const st = getTingwuStatus();
  if (!st.installed) return { started: false, message: `未找到通义听悟脚本：${st.scriptPath}` };
  if (!st.ytDlpAvailable) return { started: false, message: '本机未检测到 yt-dlp，无法抽取视频音频' };
  if (tingwuRunning) return { started: false, message: `通义听悟正在处理其他任务：${currentJobLabel}` };

  const db = getDb();
  const content = db
    .prepare('SELECT id, platform, canonical_url, title FROM contents WHERE id = ?')
    .get(contentId) as { id: number; platform: string; canonical_url: string; title: string } | undefined;
  if (!content) return { started: false, message: '内容不存在' };

  const now = new Date().toISOString();
  fs.mkdirSync(PATHS.audioDir, { recursive: true });
  const outDir = path.join(PATHS.transcriptsDir, `content-${contentId}`);
  fs.mkdirSync(outDir, { recursive: true });

  const jobRes = db
    .prepare(`
      INSERT INTO tingwu_jobs (content_id, output_dir, status, created_at, updated_at)
      VALUES (?, ?, 'downloading', ?, ?)
    `)
    .run(contentId, outDir, now, now);
  const jobId = Number(jobRes.lastInsertRowid);

  db.prepare("UPDATE contents SET transcript_status = 'transcribing' WHERE id = ?").run(contentId);

  // 后台异步跑完整链路（抽音频 -> 通义听悟上传与等待 -> 自动回写 contents.transcript）
  void (async () => {
    tingwuRunning = true;
    currentJobLabel = `听悟转录：${content.title.slice(0, 24)}`;
    try {
      const audioBase = path.join(PATHS.audioDir, `content-${contentId}`);
      const audioMp3 = `${audioBase}.mp3`;
      addLog(`步骤 1/2：使用 yt-dlp 抽取音频 -> ${path.basename(audioMp3)}`);

      const ytArgs = [
        '-x',
        '--audio-format',
        'mp3',
        '--audio-quality',
        '6',
        '--no-playlist',
        '-o',
        `${audioBase}.%(ext)s`,
        content.canonical_url,
      ];
      const dlRes = await runCommandAsync('yt-dlp', ytArgs, PATHS.audioDir, 180000, (l) => {
        if (l.includes('[download]') || l.includes('ERROR')) addLog(l.slice(0, 140));
      });

      const candidateAudio = fs
        .readdirSync(PATHS.audioDir)
        .find((f) => f.startsWith(`content-${contentId}.`) && /\.(mp3|m4a|wav|webm|opus)$/i.test(f));

      if (dlRes.code !== 0 || !candidateAudio) {
        throw new Error('音频抽取失败（若是抖音受限视频，请先确认链接可访问或本机代理/登录态正常）');
      }

      const finalAudioPath = path.join(PATHS.audioDir, candidateAudio);
      db.prepare("UPDATE tingwu_jobs SET audio_path = ?, status = 'uploading', updated_at = ? WHERE id = ?").run(
        finalAudioPath,
        new Date().toISOString(),
        jobId
      );

      addLog(`步骤 2/2：送入通义听悟网页额度自动转写（文件：${candidateAudio}）`);
      const twRes = await runCommandAsync(
        process.execPath,
        [st.scriptPath, 'run', finalAudioPath, outDir],
        st.dir,
        15 * 60 * 1000,
        (l) => addLog(l.slice(0, 160))
      );

      if (twRes.code === 2 || twRes.output.includes('LOGIN_REQUIRED')) {
        throw new Error('通义听悟登录已失效，请在「浏览器与登录」页点击“登录通义听悟”重新登录后重试');
      }

      // 查找导出的 txt 纯文本
      const txtFile = fs
        .readdirSync(outDir)
        .find((f) => f.toLowerCase().endsWith('.txt'));

      if (!txtFile) {
        throw new Error('通义听悟任务已提交但暂未导出纯文本，可稍后点击“拉取听悟已完成结果”同步');
      }

      const transcriptPath = path.join(outDir, txtFile);
      const transcriptText = fs.readFileSync(transcriptPath, 'utf8').trim();
      const doneAt = new Date().toISOString();

      db.prepare(`
        UPDATE contents SET
          transcript = ?,
          transcript_status = 'done',
          transcript_source = 'tingwu',
          body = CASE WHEN length(body) < 120 THEN ? ELSE body END
        WHERE id = ?
      `).run(transcriptText, transcriptText.slice(0, 12000), contentId);

      db.prepare(`
        UPDATE tingwu_jobs SET transcript_path = ?, status = 'done', error_message = NULL, updated_at = ? WHERE id = ?
      `).run(transcriptPath, doneAt, jobId);

      addLog(`通义听悟转写完成！共 ${transcriptText.length} 字，已自动回写内容库`);
    } catch (err) {
      const msg = (err as Error).message;
      addLog(`转写中断：${msg}`);
      db.prepare("UPDATE contents SET transcript_status = 'failed' WHERE id = ?").run(contentId);
      db.prepare("UPDATE tingwu_jobs SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?").run(
        msg,
        new Date().toISOString(),
        jobId
      );
    } finally {
      tingwuRunning = false;
      currentJobLabel = null;
    }
  })();

  return { started: true, jobId, message: '已开始后台抽音频并送入通义听悟转写，完成后会自动回写口播全文' };
}

// 补拉尚未同步回来的通义听悟结果
export async function syncCompletedTingwuJobs(): Promise<{ synced: number; message: string }> {
  const st = getTingwuStatus();
  if (!st.installed) return { synced: 0, message: '未找到通义听悟工具' };
  const res = await runCommandAsync(process.execPath, [st.scriptPath, 'collect'], st.dir, 120000, (l) => addLog(l));
  if (res.code === 2) {
    return { synced: 0, message: '通义听悟登录已失效，请先重新登录' };
  }

  const db = getDb();
  const pendingJobs = db
    .prepare("SELECT id, content_id, output_dir FROM tingwu_jobs WHERE status != 'done'")
    .all() as Array<{ id: number; content_id: number; output_dir: string }>;

  let synced = 0;
  for (const job of pendingJobs) {
    if (!job.output_dir || !fs.existsSync(job.output_dir)) continue;
    const txt = fs.readdirSync(job.output_dir).find((f) => f.toLowerCase().endsWith('.txt'));
    if (!txt) continue;
    const full = path.join(job.output_dir, txt);
    const text = fs.readFileSync(full, 'utf8').trim();
    if (!text) continue;
    db.prepare(`
      UPDATE contents SET transcript = ?, transcript_status = 'done', transcript_source = 'tingwu',
        body = CASE WHEN length(body) < 120 THEN ? ELSE body END
      WHERE id = ?
    `).run(text, text.slice(0, 12000), job.content_id);
    db.prepare("UPDATE tingwu_jobs SET transcript_path = ?, status = 'done', updated_at = ? WHERE id = ?").run(
      full,
      new Date().toISOString(),
      job.id
    );
    synced++;
  }
  return { synced, message: synced > 0 ? `已同步回写 ${synced} 条听悟转写全文` : '暂无新完成的听悟文本' };
}
