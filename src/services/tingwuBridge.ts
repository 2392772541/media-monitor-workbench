import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { PATHS, PROJECT_ROOT } from '../config.js';
import { getDb } from '../db/database.js';
import { log } from '../utils/logger.js';

export interface TingwuStatus {
  installed: boolean;
  engine: 'faster-whisper';
  pythonExe: string;
  model: string;
  gpuReady: boolean;
  dir: string;
  scriptPath: string;
  profileExists: boolean;
  ytDlpAvailable: boolean;
  ffmpegAvailable: boolean;
  running: boolean;
  currentJob: string | null;
  lastLogs: string[];
}

const MOBILE_IOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

let asrRunning = false;
let currentJobLabel: string | null = null;
let asrLogs: string[] = [];
let cachedPythonProbe: { pythonExe: string; ready: boolean; gpuReady: boolean; checkedAt: number } | null = null;

function addLog(msg: string) {
  const line = `[${new Date().toLocaleTimeString('zh-CN')}] ${msg}`;
  asrLogs.push(line);
  if (asrLogs.length > 60) asrLogs = asrLogs.slice(-60);
  log('INFO', 'local-asr', msg);
}

function hasExecutable(name: string): boolean {
  try {
    execFileSync('where', [name], { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

// 自动探测已安装 faster-whisper 的本机 Python 解释器（优先环境变量 -> Miniconda -> PATH）
export function resolveAsrPython(): { pythonExe: string; ready: boolean; gpuReady: boolean } {
  if (cachedPythonProbe && Date.now() - cachedPythonProbe.checkedAt < 60000) {
    return cachedPythonProbe;
  }
  const candidates = [
    process.env.MMW_PYTHON_PATH,
    'E:\\app\\Miniconda\\python.exe',
    'C:\\Users\\win10\\miniconda3\\python.exe',
    'python',
  ].filter(Boolean) as string[];

  for (const exe of candidates) {
    if (exe.includes('\\') && !fs.existsSync(exe)) continue;
    try {
      const out = execFileSync(
        exe,
        ['-c', 'import faster_whisper, ctranslate2; print("OK:" + str(ctranslate2.get_cuda_device_count()))'],
        { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim();
      if (out.startsWith('OK:')) {
        const gpuCount = Number(out.slice(3)) || 0;
        cachedPythonProbe = { pythonExe: exe, ready: true, gpuReady: gpuCount > 0, checkedAt: Date.now() };
        return cachedPythonProbe;
      }
    } catch {
      // 尝试下一个 Python
    }
  }
  cachedPythonProbe = { pythonExe: '', ready: false, gpuReady: false, checkedAt: Date.now() };
  return cachedPythonProbe;
}

export function getAsrScriptPath(): string {
  return path.join(PROJECT_ROOT, 'scripts', 'local_asr.py');
}

export function getTingwuStatus(): TingwuStatus {
  const scriptPath = getAsrScriptPath();
  const py = resolveAsrPython();
  const model = process.env.MMW_WHISPER_MODEL || 'medium';
  const installed = fs.existsSync(scriptPath) && py.ready;
  return {
    installed,
    engine: 'faster-whisper',
    pythonExe: py.pythonExe,
    model,
    gpuReady: py.gpuReady,
    dir: path.dirname(scriptPath),
    scriptPath,
    // 免登录本地引擎，不再欺骗性依赖浏览器目录
    profileExists: installed,
    ytDlpAvailable: hasExecutable('yt-dlp'),
    ffmpegAvailable: hasExecutable('ffmpeg'),
    running: asrRunning,
    currentJob: currentJobLabel,
    lastLogs: asrLogs.slice(-20),
  };
}

// 兼容旧路由：已切换本机显卡免登录转写，无需扫码登录
export function launchTingwuLogin(): { started: boolean; message: string } {
  return {
    started: true,
    message: '已切换为本机 RTX 显卡开源语音转写（faster-whisper），完全免登录、永不掉线，直接点视频转写即可！',
  };
}

function runCommandAsync(
  exe: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  onOutput?: (line: string) => void
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, {
      cwd,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`命令执行超时（${Math.round(timeoutMs / 1000)} 秒）`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      const s = chunk.toString('utf8');
      stdout += s;
      for (const l of s.split(/\r?\n/).filter(Boolean)) onOutput?.(l);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const s = chunk.toString('utf8');
      stderr += s;
      for (const l of s.split(/\r?\n/).filter(Boolean)) onOutput?.(l);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

// 抖音免 Cookie 音频提取：走 iesdouyin 移动端分享页 _ROUTER_DATA 取直链并用 ffmpeg 压缩为 16kHz 单声道 MP3
async function extractDouyinAudioToMp3(videoUrl: string, outMp3Path: string): Promise<boolean> {
  const idMatch = videoUrl.match(/(\d{15,22})/);
  if (!idMatch) return false;
  const videoId = idMatch[1];
  const shareUrl = `https://www.iesdouyin.com/share/video/${videoId}/`;

  const cookies = new Map<string, string>();
  const mergeCookies = (res: Response) => {
    const hdrs = res.headers as unknown as { getSetCookie?: () => string[] };
    const list = typeof hdrs.getSetCookie === 'function' ? hdrs.getSetCookie() : [];
    for (const c of list) {
      const kv = c.split(';')[0];
      const eq = kv.indexOf('=');
      if (eq > 0) cookies.set(kv.slice(0, eq).trim(), kv.slice(eq + 1).trim());
    }
  };
  const cookieHeader = () =>
    Array.from(cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');

  interface DouyinShareItem {
    video?: { play_addr?: { url_list?: string[] } };
    music?: { play_url?: { url_list?: string[] } };
  }
  let item: DouyinShareItem | null = null;

  for (let hop = 0; hop < 4; hop++) {
    try {
      const res = await fetch(shareUrl, {
        headers: {
          'User-Agent': MOBILE_IOS_UA,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          ...(cookies.size > 0 ? { Cookie: cookieHeader() } : {}),
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
      });
      mergeCookies(res);
      if (!res.ok) continue;
      const html = await res.text();
      const m = html.match(/window\._ROUTER_DATA\s*=\s*(\{.*?\})\s*(?:;|<\/script>)/s);
      if (!m) continue;
      const parsed = JSON.parse(m[1]) as { loaderData?: Record<string, { videoInfoRes?: { item_list?: unknown[] } }> };
      const ld = parsed.loaderData || {};
      const pageObj = ld['video_(id)/page'] || Object.values(ld).find((v) => v && typeof v === 'object' && v.videoInfoRes);
      const list = pageObj?.videoInfoRes?.item_list;
      if (Array.isArray(list) && list.length > 0 && list[0] && typeof list[0] === 'object') {
        item = list[0] as DouyinShareItem;
        break;
      }
    } catch {
      // 预热重试
    }
  }

  if (!item) return false;

  const rawUrls: string[] = [];
  // 仅用于抽取纯音频，优先直接走原始高速 CDN 链接，避免替换 /play/ 导致个别节点卡死超时
  for (const u of item.video?.play_addr?.url_list || []) {
    if (!u) continue;
    rawUrls.push(u);
    if (u.includes('/playwm/')) rawUrls.push(u.replace('/playwm/', '/play/'));
  }
  if (rawUrls.length === 0) {
    for (const u of item.music?.play_url?.url_list || []) {
      if (u) rawUrls.push(u);
    }
  }

  const tmpRaw = `${outMp3Path}.raw.mp4`;
  let downloaded = false;
  for (const mediaUrl of rawUrls) {
    const ac = new AbortController();
    const connectTimer = setTimeout(() => ac.abort(), 15000);
    let bodyTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      const mr = await fetch(mediaUrl, {
        headers: { 'User-Agent': MOBILE_IOS_UA, Referer: 'https://www.iesdouyin.com/' },
        redirect: 'follow',
        signal: ac.signal,
      });
      clearTimeout(connectTimer);
      const ct = (mr.headers.get('content-type') || '').toLowerCase();
      if (!mr.ok || ct.includes('text/html')) continue;
      // 响应头正常后放宽正文下载至 180 秒，确保 10~30 分钟长视频绝不被中途掐断
      bodyTimer = setTimeout(() => ac.abort(), 180000);
      const buf = Buffer.from(await mr.arrayBuffer());
      clearTimeout(bodyTimer);
      if (buf.length < 8192) continue;
      fs.writeFileSync(tmpRaw, buf);
      downloaded = true;
      break;
    } catch {
      clearTimeout(connectTimer);
      if (bodyTimer) clearTimeout(bodyTimer);
      continue;
    }
  }

  if (!downloaded) return false;

  try {
    const ffRes = await runCommandAsync(
      'ffmpeg',
      ['-y', '-i', tmpRaw, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', outMp3Path],
      path.dirname(outMp3Path),
      120000
    );
    return ffRes.code === 0 && fs.existsSync(outMp3Path) && fs.statSync(outMp3Path).size > 2048;
  } finally {
    fs.rmSync(tmpRaw, { force: true });
  }
}

/**
 * 单端口一键「免 Cookie 抽纯音频 → 本机 RTX 4070 显卡 faster-whisper 转写 → 干净口播全文自动回库」。
 * 彻底免登录、不掉线、不耗网页免费额度、通常 10～25 秒出稿。
 */
export function startTingwuTranscription(contentId: number): {
  started: boolean;
  jobId?: number;
  message: string;
} {
  const st = getTingwuStatus();
  if (!st.installed) {
    return {
      started: false,
      message: '未检测到本机 faster-whisper 环境（请确认已安装 faster-whisper 或配置 MMW_PYTHON_PATH）',
    };
  }
  if (!st.ffmpegAvailable) return { started: false, message: '本机未检测到 ffmpeg，无法抽取纯音频' };
  if (asrRunning) return { started: false, message: `本机显卡正在转写另一条视频：${currentJobLabel}` };

  const db = getDb();
  const content = db
    .prepare('SELECT id, platform, canonical_url, title FROM contents WHERE id = ?')
    .get(contentId) as { id: number; platform: string; canonical_url: string; title: string } | undefined;
  if (!content) return { started: false, message: '内容不存在' };
  if (content.platform === 'douyin' && !/\/video\/\d+/.test(content.canonical_url)) {
    return {
      started: false,
      message: '当前条目是抖音热搜词条（非单个视频链接），请点开具体抖音视频作品再转口播稿',
    };
  }

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

  void (async () => {
    asrRunning = true;
    currentJobLabel = `本地显卡转写：${content.title.slice(0, 24)}`;
    try {
      const uniqueStem = `content-${contentId}_${Date.now().toString(36)}`;
      const audioBase = path.join(PATHS.audioDir, uniqueStem);
      const audioMp3 = `${audioBase}.mp3`;
      let finalAudioPath = '';

      if (content.platform === 'douyin') {
        addLog(`步骤 1/2：免 Cookie 提取抖音纯音频 -> ${path.basename(audioMp3)}`);
        const ok = await extractDouyinAudioToMp3(content.canonical_url, audioMp3);
        if (ok) finalAudioPath = audioMp3;
      }

      if (!finalAudioPath) {
        if (!st.ytDlpAvailable) {
          throw new Error('直链提取未命中且本机未安装 yt-dlp');
        }
        addLog(`步骤 1/2：使用 yt-dlp 提取视频纯音频 -> ${path.basename(audioMp3)}`);
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
          .find((f) => f.startsWith(`${uniqueStem}.`) && /\.(mp3|m4a|wav|webm|opus)$/i.test(f));

        if (dlRes.code !== 0 || !candidateAudio) {
          throw new Error('音频抽取失败（若是受限或私密视频，请确认链接可直接播放）');
        }
        finalAudioPath = path.join(PATHS.audioDir, candidateAudio);
      }

      db.prepare("UPDATE tingwu_jobs SET audio_path = ?, status = 'uploading', updated_at = ? WHERE id = ?").run(
        finalAudioPath,
        new Date().toISOString(),
        jobId
      );

      const outputTxt = path.join(outDir, `${uniqueStem}.txt`);
      addLog(`步骤 2/2：本机 ${st.gpuReady ? 'RTX 显卡' : 'CPU'} faster-whisper (${st.model}) 开始离线转写...`);

      const asrRes = await runCommandAsync(
        st.pythonExe,
        [st.scriptPath, finalAudioPath, outputTxt, '--model', st.model, '--lang', 'zh'],
        PROJECT_ROOT,
        10 * 60 * 1000,
        (l) => {
          if (l.startsWith('{') || l.includes('error')) addLog(l.slice(0, 160));
        }
      );

      if (asrRes.code !== 0 || !fs.existsSync(outputTxt)) {
        const detail = (asrRes.stderr || asrRes.stdout || '').trim().slice(-240);
        throw new Error(`本地显卡语音转写失败：${detail || `退出码 ${asrRes.code}`}`);
      }

      const transcriptText = fs.readFileSync(outputTxt, 'utf8').trim();
      if (!transcriptText) {
        throw new Error('视频中未识别到有效人声口播内容');
      }

      let metaNote = '';
      try {
        const lastJson = asrRes.stdout
          .trim()
          .split(/\r?\n/)
          .reverse()
          .find((l) => l.trim().startsWith('{'));
        if (lastJson) {
          const parsed = JSON.parse(lastJson) as { elapsed_sec?: number; device?: string; model?: string };
          metaNote = `（${parsed.device === 'cuda' ? 'RTX 显卡' : 'CPU'} ${parsed.model || st.model}，耗时 ${parsed.elapsed_sec ?? '?'}s）`;
        }
      } catch {
        // ignore
      }

      const doneAt = new Date().toISOString();
      db.prepare(`
        UPDATE contents SET
          transcript = ?,
          transcript_status = 'done',
          transcript_source = 'faster-whisper',
          body = CASE WHEN length(body) < 120 THEN ? ELSE body END
        WHERE id = ?
      `).run(transcriptText, transcriptText.slice(0, 12000), contentId);

      db.prepare(`
        UPDATE tingwu_jobs SET transcript_path = ?, status = 'done', error_message = NULL, updated_at = ? WHERE id = ?
      `).run(outputTxt, doneAt, jobId);

      addLog(`本地转写完成！共 ${transcriptText.length} 字 ${metaNote}`);
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
      asrRunning = false;
      currentJobLabel = null;
    }
  })();

  return {
    started: true,
    jobId,
    message: `已启动本机${st.gpuReady ? ' RTX 显卡' : ''}免费离线转写，通常十几秒内自动出口播全文`,
  };
}

// 补同步已落盘的本地转写文本
export async function syncCompletedTingwuJobs(): Promise<{ synced: number; message: string }> {
  const db = getDb();
  const pendingJobs = db
    .prepare("SELECT id, content_id, output_dir FROM tingwu_jobs WHERE status != 'done'")
    .all() as Array<{ id: number; content_id: number; output_dir: string }>;

  let synced = 0;
  for (const job of pendingJobs) {
    if (!job.output_dir || !fs.existsSync(job.output_dir)) continue;
    const txt = fs
      .readdirSync(job.output_dir)
      .filter((f) => f.toLowerCase().endsWith('.txt'))
      .sort((a, b) => fs.statSync(path.join(job.output_dir, b)).mtimeMs - fs.statSync(path.join(job.output_dir, a)).mtimeMs)[0];
    if (!txt) continue;
    const full = path.join(job.output_dir, txt);
    const text = fs.readFileSync(full, 'utf8').trim();
    if (!text) continue;
    db.prepare(`
      UPDATE contents SET transcript = ?, transcript_status = 'done', transcript_source = 'faster-whisper',
        body = CASE WHEN length(body) < 120 THEN ? ELSE body END
      WHERE id = ?
    `).run(text, text.slice(0, 12000), job.content_id);
    db.prepare("UPDATE tingwu_jobs SET transcript_path = ?, status = 'done', error_message = NULL, updated_at = ? WHERE id = ?").run(
      full,
      new Date().toISOString(),
      job.id
    );
    synced++;
  }
  return { synced, message: synced > 0 ? `已同步回写 ${synced} 条本地转写全文` : '所有本地转写稿均已同步完毕' };
}
