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

const MOBILE_IOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

let tingwuRunning = false;
let currentJobLabel: string | null = null;
let tingwuLogs: string[] = [];

function addLog(msg: string) {
  const line = `[${new Date().toLocaleTimeString('zh-CN')}] ${msg}`;
  tingwuLogs.push(line);
  if (tingwuLogs.length > 60) tingwuLogs = tingwuLogs.slice(-60);
  log('INFO', 'tingwu', msg);
}

// 优先使用工作台仓库内置的最新适配版 tingwu.mjs（确保新版通义听悟 .srt/原文提取始终生效）
export function getConfiguredTingwuDir(): string {
  const bundled = PATHS.defaultTingwuDir;
  if (fs.existsSync(path.join(bundled, 'src', 'tingwu.mjs'))) {
    return bundled;
  }
  const db = getDb();
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'tingwu_dir'").get() as { value: string } | undefined;
  const configured = (row?.value || '').trim();
  if (configured && fs.existsSync(path.join(configured, 'src', 'tingwu.mjs'))) {
    return configured;
  }
  return bundled;
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

// 弹出通义听悟扫码登录窗口（只需登一次，登录态持久存在本机独立配置）
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
  addLog('已弹出通义听悟扫码登录窗口，扫码完成后窗口将自动关闭');
  return { started: true, message: '已弹出通义听悟登录窗口，扫码登录后窗口会自动关闭，然后点「通义听悟转口播稿」即可' };
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

// 抖音免 Cookie 音频提取：走 iesdouyin 移动端分享页 _ROUTER_DATA 取无水印流并用 ffmpeg 压缩为 16kHz 单声道 MP3
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
      // 继续下一跳预热
    }
  }

  if (!item) return false;

  const rawUrls: string[] = [];
  for (const u of item.video?.play_addr?.url_list || []) {
    if (!u) continue;
    if (u.includes('/playwm/')) rawUrls.push(u.replace('/playwm/', '/play/'));
    rawUrls.push(u);
  }
  if (rawUrls.length === 0) {
    for (const u of item.music?.play_url?.url_list || []) {
      if (u) rawUrls.push(u);
    }
  }

  const tmpRaw = `${outMp3Path}.raw.mp4`;
  let downloaded = false;
  for (const mediaUrl of rawUrls) {
    try {
      const mr = await fetch(mediaUrl, {
        headers: { 'User-Agent': MOBILE_IOS_UA, Referer: 'https://www.iesdouyin.com/' },
        redirect: 'follow',
        signal: AbortSignal.timeout(60000),
      });
      const ct = (mr.headers.get('content-type') || '').toLowerCase();
      if (!mr.ok || ct.includes('text/html')) continue;
      const buf = Buffer.from(await mr.arrayBuffer());
      if (buf.length < 8192) continue;
      fs.writeFileSync(tmpRaw, buf);
      downloaded = true;
      break;
    } catch {
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
 * 单端口一键「免 Cookie 抖音/全平台抽纯音频 → 通义听悟网页额度转写 → 去时间轴口播逐字稿自动回库」。
 */
export function startTingwuTranscription(contentId: number): {
  started: boolean;
  jobId?: number;
  message: string;
} {
  const st = getTingwuStatus();
  if (!st.installed) return { started: false, message: `未找到通义听悟脚本：${st.scriptPath}` };
  if (!st.ffmpegAvailable) return { started: false, message: '本机未检测到 ffmpeg，无法抽取纯音频' };
  if (tingwuRunning) return { started: false, message: `通义听悟正在处理其他任务：${currentJobLabel}` };

  const db = getDb();
  const content = db
    .prepare('SELECT id, platform, canonical_url, title FROM contents WHERE id = ?')
    .get(contentId) as { id: number; platform: string; canonical_url: string; title: string } | undefined;
  if (!content) return { started: false, message: '内容不存在' };
  if (content.platform === 'douyin' && !/\/video\/\d+/.test(content.canonical_url)) {
    return {
      started: false,
      message: '当前条目是抖音热搜词条（非单个视频链接），请打开具体抖音视频作品再转口播稿',
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

  // 后台异步跑完整链路（抽轻量化 MP3 -> 通义听悟转写 -> 自动去水印回写 contents.transcript）
  void (async () => {
    tingwuRunning = true;
    currentJobLabel = `听悟转录：${content.title.slice(0, 24)}`;
    try {
      const uniqueStem = `content-${contentId}_${Date.now().toString(36)}`;
      const audioBase = path.join(PATHS.audioDir, uniqueStem);
      const audioMp3 = `${audioBase}.mp3`;
      let finalAudioPath = '';

      if (content.platform === 'douyin') {
        addLog(`步骤 1/2：正在免 Cookie 提取抖音纯音频 -> ${path.basename(audioMp3)}`);
        const ok = await extractDouyinAudioToMp3(content.canonical_url, audioMp3);
        if (ok) {
          finalAudioPath = audioMp3;
        }
      }

      if (!finalAudioPath) {
        if (!st.ytDlpAvailable) {
          throw new Error('抖音直链提取未命中且本机未安装 yt-dlp');
        }
        addLog(`步骤 1/2：使用 yt-dlp 抽取纯音频 -> ${path.basename(audioMp3)}`);
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

      addLog(`步骤 2/2：送入通义听悟网页额度自动转写（${path.basename(finalAudioPath)}）`);
      const twRes = await runCommandAsync(
        process.execPath,
        [st.scriptPath, 'run', finalAudioPath, outDir],
        st.dir,
        15 * 60 * 1000,
        (l) => addLog(l.slice(0, 160))
      );

      if (twRes.code === 2 || twRes.output.includes('LOGIN_REQUIRED')) {
        throw new Error('LOGIN_REQUIRED: 通义听悟尚未登录，请先点下方「扫码登录通义听悟」完成一次登录后再点转写');
      }

      // 优先读取对应本次唯一 stem 的纯文本文件，再回退目录最新 txt
      const expectedTxt = `${uniqueStem}.txt`;
      const txtFile =
        (fs.existsSync(path.join(outDir, expectedTxt)) ? expectedTxt : null) ||
        fs
          .readdirSync(outDir)
          .filter((f) => f.toLowerCase().endsWith('.txt'))
          .sort((a, b) => fs.statSync(path.join(outDir, b)).mtimeMs - fs.statSync(path.join(outDir, a)).mtimeMs)[0];

      if (!txtFile) {
        throw new Error('通义听悟任务已提交但暂未取回文本，可稍候几秒点击「同步」拉回口播稿');
      }

      const transcriptPath = path.join(outDir, txtFile);
      const transcriptText = fs.readFileSync(transcriptPath, 'utf8').trim();
      if (!transcriptText) {
        throw new Error('听悟返回文本为空，请稍后重试');
      }
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

      addLog(`通义听悟转写完成！共 ${transcriptText.length} 字，已自动回写口播全文`);
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

  return { started: true, jobId, message: '已开始抽取纯音频并提交至通义听悟，转完会自动把口播稿显示在这里' };
}

// 补拉尚未同步回来的通义听悟结果
export async function syncCompletedTingwuJobs(): Promise<{ synced: number; message: string }> {
  const st = getTingwuStatus();
  if (!st.installed) return { synced: 0, message: '未找到通义听悟工具' };
  const res = await runCommandAsync(process.execPath, [st.scriptPath, 'collect'], st.dir, 120000, (l) => addLog(l));
  if (res.code === 2 || res.output.includes('LOGIN_REQUIRED')) {
    return { synced: 0, message: '通义听悟尚未登录，请先点「扫码登录通义听悟」' };
  }

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
      UPDATE contents SET transcript = ?, transcript_status = 'done', transcript_source = 'tingwu',
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
  return { synced, message: synced > 0 ? `已同步回写 ${synced} 条口播逐字稿` : '暂无新完成的听悟转写结果' };
}
