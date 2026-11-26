#!/usr/bin/env node
// 内置通义听悟网页额度转写脚本（适配 2026 新版界面：自动上传 -> 轮询 -> 导出 SRT / 原文直采 -> 去时间轴与零宽水印 -> 输出纯文本）
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
function loadChromium() {
  for (const mod of ['playwright', 'playwright-core']) {
    try {
      const m = require(mod);
      if (m?.chromium) return m.chromium;
    } catch {
      // try next
    }
  }
  throw new Error('未找到 playwright，请先在项目根目录运行 npm install');
}
const chromium = loadChromium();

const HOME = 'https://tingwu.aliyun.com/home';
const FOLDERS = 'https://tingwu.aliyun.com/folders/0';
const DATA = path.join(process.env.LOCALAPPDATA || os.homedir(), 'TingwuWebBatch');
const PROFILE = path.join(DATA, 'browser-profile');
const LOGS = path.join(DATA, 'logs');
const STATE = path.join(DATA, 'jobs.json');
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
const EXT = new Set(['.mp3', '.mp4', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wma', '.mov', '.mkv', '.avi', '.webm', '.ts', '.mpeg', '.mpg']);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const nowTag = () => new Date().toISOString().replace(/[:.]/g, '-');
const say = (s) => console.log('[' + new Date().toLocaleString('zh-CN') + '] ' + s);

function chromePath() {
  const candidates = [
    process.env.TINGWU_CHROME_PATH,
    process.env.MMW_CHROMIUM_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  for (const p of candidates) if (fsSync.existsSync(p)) return p;
  return undefined;
}

async function dirs() {
  await fs.mkdir(PROFILE, { recursive: true });
  await fs.mkdir(LOGS, { recursive: true });
}

async function open(headless) {
  await dirs();
  return chromium.launchPersistentContext(PROFILE, {
    executablePath: chromePath(),
    headless,
    acceptDownloads: true,
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    userAgent: DESKTOP_UA,
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'],
  });
}

async function debug(page, name) {
  const p = path.join(LOGS, nowTag() + '-' + name);
  await page.screenshot({ path: p + '.png', fullPage: true }).catch(() => {});
  say('诊断截图：' + p + '.png');
  return p;
}

async function logged(page) {
  await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);
  const loginVisible = await page.getByText('立即登录', { exact: true }).isVisible().catch(() => false);
  if (loginVisible) return false;
  const url = page.url();
  if (/login\.aliyun|passport|signin/i.test(url)) return false;
  return true;
}

async function visible(list) {
  for (const l of list) {
    for (let i = 0, n = await l.count().catch(() => 0); i < n; i++) {
      const x = l.nth(i);
      if (await x.isVisible().catch(() => false)) return x;
    }
  }
  return null;
}

async function readState() {
  try {
    return JSON.parse(await fs.readFile(STATE, 'utf8'));
  } catch {
    return { version: 1, jobs: [] };
  }
}

async function writeState(s) {
  await dirs();
  await fs.writeFile(STATE + '.tmp', JSON.stringify(s, null, 2), 'utf8');
  await fs.rename(STATE + '.tmp', STATE);
}

async function patch(id, data) {
  const s = await readState();
  const j = s.jobs.find((x) => x.id === id);
  if (j) Object.assign(j, data, { updatedAt: new Date().toISOString() });
  await writeState(s);
}

async function jobFor(file, out) {
  const s = await readState();
  const f = path.resolve(file);
  let j = s.jobs.find((x) => x.file === f && !['failed', 'downloaded'].includes(x.status));
  if (!j) {
    j = {
      id: nowTag() + '-' + Math.random().toString(16).slice(2, 8),
      file: f,
      outputDir: out,
      status: 'queued',
      createdAt: new Date().toISOString(),
    };
    s.jobs.push(j);
    await writeState(s);
  }
  return j;
}

// 清洗通义听悟 SRT / 原文区文本：去 BOM、去 Unicode Cf 零宽水印、去序号/时间轴/发言人前缀、自然合并成段
function cleanTranscriptText(raw) {
  if (!raw) return '';
  const stripped = String(raw)
    .replace(/^\uFEFF/, '')
    .replace(/\p{Cf}/gu, '')
    .replace(/\r\n?/g, '\n');

  const lines = stripped.split('\n');
  const sentences = [];
  for (const rawLine of lines) {
    let line = rawLine.trim();
    if (!line) continue;
    if (/^WEBVTT(?:\s.*)?$/i.test(line)) continue;
    if (/^(?:Kind|Language|Style)\s*:/i.test(line)) continue;
    if (/^\d+$/.test(line)) continue;
    if (/^(?:\d{1,2}:)?\d{2}:\d{2}(?:[.,]\d{1,3})?\s*-->\s*(?:\d{1,2}:)?\d{2}:\d{2}(?:[.,]\d{1,3})?/.test(line)) continue;
    if (/^[\[(]?(?:\d{1,2}:)?\d{2}:\d{2}(?:[.,]\d{1,3})?[\])]?$/.test(line)) continue;
    if (/^(?:说话人|发言人|讲话人|Speaker)\s*[A-Za-z0-9一二三四五六七八九十甲乙丙丁_-]*\s*[:：]?\s*[\[(]?(?:\d{1,2}:)?\d{2}:\d{2}(?:[.,]\d{1,3})?[\])]?\s*[:：]?$/i.test(line)) {
      continue;
    }

    // 剥离行首说话人与时间戳前缀
    line = line
      .replace(/^(?:说话人|发言人|讲话人|Speaker)\s*[A-Za-z0-9一二三四五六七八九十甲乙丙丁_-]*\s*(?:[:：]\s*)?[\[(]?(?:\d{1,2}:)?\d{2}:\d{2}(?:[.,]\d{1,3})?[\])]?\s*[:：]?\s*/i, '')
      .replace(/^(?:说话人|发言人|讲话人|Speaker)\s*[A-Za-z0-9一二三四五六七八九十甲乙丙丁_-]*\s*[:：]\s*/i, '')
      .replace(/^[\[(](?:\d{1,2}:)?\d{2}:\d{2}(?:[.,]\d{1,3})?[\])]\s*/, '')
      .replace(/^(?:\d{1,2}:)?\d{2}:\d{2}(?:[.,]\d{1,3})?\s+(?=\S)/, '')
      .trim();

    if (!line) continue;
    sentences.push(line);
  }

  // 自然合段：每积累 ~220 字且以句末标点收尾时换行，易读易复制
  const paragraphs = [];
  let buf = '';
  for (const seg of sentences) {
    const needSpace = buf && /[A-Za-z0-9]$/.test(buf) && /^[A-Za-z0-9]/.test(seg);
    buf = buf ? (needSpace ? `${buf} ${seg}` : `${buf}${seg}`) : seg;
    if (buf.length >= 220 && /[。！？!?…]$/.test(buf)) {
      paragraphs.push(buf);
      buf = '';
    }
  }
  if (buf) paragraphs.push(buf);
  return paragraphs.join('\n\n').trim();
}

async function login() {
  const c = await open(false);
  const p = c.pages()[0] || (await c.newPage());
  try {
    await p.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 60000 });
    say('请在窗口里登录通义听悟，只需登录这一次；登录成功后窗口会自动关闭。');
    let ok = false;
    for (let i = 0; i < 300; i++) {
      await p.waitForTimeout(2000);
      const loginVisible = await p.getByText('立即登录', { exact: true }).isVisible().catch(() => false);
      const user = await p.evaluate(() => window._USER_ || null).catch(() => null);
      if (!loginVisible && (user?.aliyunUid || user?.nickName || user?.userId)) {
        ok = true;
        break;
      }
      if (!loginVisible && i > 2 && !/login\.aliyun|passport|signin/i.test(p.url())) {
        ok = true;
        break;
      }
    }
    if (!ok) throw new Error('10分钟内没有检测到登录成功');
    await p.waitForTimeout(1500);
    say('通义听悟登录状态已保存，以后全自动后台运行。');
  } finally {
    await c.close();
  }
}

async function chooseFile(page, file) {
  const inputs = page.locator('input[type=file]');
  if (await inputs.count()) {
    await inputs.last().setInputFiles(file);
    return;
  }
  const b = await visible([
    page.getByRole('button', { name: /选择文件|点击上传|添加文件|本地上传|上传文件/ }),
    page.getByText(/选择文件|点击上传|添加文件|本地上传|上传文件/, { exact: false }),
  ]);
  if (!b) throw new Error('没有找到文件选择控件');
  const event = page.waitForEvent('filechooser', { timeout: 10000 });
  await b.click();
  await (await event).setFiles(file);
}

async function submit(page, file, out) {
  const j = await jobFor(file, out);
  await patch(j.id, { status: 'uploading', error: null });
  try {
    if (!(await logged(page))) throw new Error('LOGIN_REQUIRED');
    const up = await visible([
      page.getByText('上传音视频', { exact: true }),
      page.getByRole('button', { name: /上传音视频|上传文件|上传本地音视频/ }),
    ]);
    if (!up) throw new Error('找不到「上传音视频」入口');
    await up.click();
    await page.waitForTimeout(1200);
    await chooseFile(page, file);
    await page.waitForTimeout(1500);

    // 在弹窗点击「开始转写」等确认按钮
    const ok = await visible([
      page.getByRole('button', { name: /开始转写|开始上传|确认上传|上传并转写|立即上传/ }),
      page.getByText(/开始转写|开始上传|确认上传|上传并转写|立即上传/, { exact: false }),
    ]);
    if (ok) await ok.click();

    const stem = path.parse(file).name;
    const start = Date.now();
    let accepted = false;
    while (Date.now() - start < 90000) {
      const t = await page.locator('body').innerText().catch(() => '');
      if (/免费.*时长.*不足|额度不足|上传失败|格式不支持|空间不足/.test(t)) {
        throw new Error('通义听悟提示上传失败或免费转写时长不足');
      }
      if (/上传成功|转写中|处理中|排队中|已添加到我的记录|进入记录/.test(t) || page.url().includes('/folders/')) {
        accepted = true;
        break;
      }
      // 约 10 秒后顺便查一下默认文件夹是否已经出现新记录
      if (Date.now() - start > 10000 && (await page.getByText(stem, { exact: false }).first().isVisible().catch(() => false))) {
        accepted = true;
        break;
      }
      await wait(1500);
    }
    if (!accepted) throw new Error('90秒内没有确认上传成功');
    await patch(j.id, { status: 'submitted', submittedAt: new Date().toISOString(), lastUrl: page.url() });
    say('已提交通义听悟转写：' + path.basename(file));
  } catch (e) {
    await debug(page, 'upload-failed');
    await patch(j.id, { status: 'failed', error: String(e.message || e) });
    throw e;
  }
}

async function media(inputPath) {
  const a = path.resolve(inputPath);
  const s = await fs.stat(a);
  if (s.isFile()) return EXT.has(path.extname(a).toLowerCase()) ? [a] : [];
  return (await fs.readdir(a, { withFileTypes: true }))
    .filter((e) => e.isFile() && EXT.has(path.extname(e.name).toLowerCase()))
    .map((e) => path.join(a, e.name))
    .sort((x, y) => x.localeCompare(y, 'zh-CN'));
}

// 方式 B 兜底：直接从通义听悟详情页「原文」区提取文本
async function scrapeDetailTranscript(page) {
  const origTab = await visible([
    page.getByRole('tab', { name: /原文/ }),
    page.getByText('原文', { exact: true }),
  ]);
  if (origTab) {
    await origTab.click().catch(() => {});
    await page.waitForTimeout(1000);
  }
  const rawText = await page.evaluate(() => {
    const selectors = [
      '[class*="transcript"]',
      '[class*="paragraph"]',
      '[class*="sentence"]',
      '[class*="content-list"]',
      '[class*="detail-content"]',
    ];
    for (const sel of selectors) {
      const nodes = Array.from(document.querySelectorAll(sel));
      const joined = nodes
        .map((n) => (n.innerText || '').trim())
        .filter((t) => t.length >= 6)
        .join('\n');
      if (joined.length >= 60) return joined;
    }
    return '';
  });
  return cleanTranscriptText(rawText);
}

async function collectOne(page, j) {
  try {
    await page.goto(FOLDERS, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2200);
    const stem = path.parse(j.file).name;
    let record = await visible([
      page.getByText(stem, { exact: true }),
      page.getByText(stem, { exact: false }),
    ]);
    if (!record) {
      // 回首页再找一次「我的记录」
      await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(1800);
      const mine = await visible([page.getByText('我的记录', { exact: true }), page.getByText(/我的记录/, { exact: false })]);
      if (mine) {
        await mine.click();
        await page.waitForTimeout(1800);
      }
      record = await visible([page.getByText(stem, { exact: true }), page.getByText(stem, { exact: false })]);
    }
    if (!record) {
      await patch(j.id, { status: 'waiting', note: '暂未在记录列表中看到该任务' });
      return false;
    }

    // 检查该行是否仍在转写中
    await record.click();
    await page.waitForTimeout(2500);
    const body = await page.locator('body').innerText().catch(() => '');
    if (/转写失败|处理失败|转写异常/.test(body)) throw new Error('通义听悟网页提示转写失败');

    const expBtn = await visible([
      page.getByRole('button', { name: /导出/ }),
      page.getByText('导出', { exact: true }),
      page.locator('[title*="导出"], [aria-label*="导出"]'),
    ]);

    if (/转写中|处理中|排队中|生成中/.test(body) && !expBtn) {
      await patch(j.id, { status: 'processing', lastUrl: page.url() });
      return false;
    }

    await fs.mkdir(j.outputDir, { recursive: true });
    const finalTxtPath = path.join(j.outputDir, `${stem}.txt`);
    let cleanedText = '';

    // 方式 A（优先）：导出 .srt 字幕文件并自动去时间轴和零宽水印
    if (expBtn) {
      try {
        await expBtn.click();
        await page.waitForTimeout(900);
        const srtOpt = await visible([
          page.getByText(/\.srt|SRT|字幕文件|字幕/i, { exact: false }),
          page.getByRole('menuitem', { name: /SRT|字幕/i }),
          page.getByText(/纯文本|TXT/i, { exact: false }),
        ]);
        if (srtOpt) {
          await srtOpt.click();
          await page.waitForTimeout(500);
        }
        const dp = page.waitForEvent('download', { timeout: 15000 });
        const confirmBtn = await visible([
          page.getByRole('button', { name: /导出|下载|确定|开始导出|确认导出/ }),
          page.getByText(/开始导出|确认导出|导出本地/i, { exact: false }),
        ]);
        if (confirmBtn) await confirmBtn.click();
        const dl = await dp;
        const rawDest = path.join(j.outputDir, dl.suggestedFilename() || `${stem}.srt`);
        await dl.saveAs(rawDest);
        const rawStr = await fs.readFile(rawDest, 'utf8');
        cleanedText = cleanTranscriptText(rawStr);
        // 清理中间 srt，保留干净纯文本 txt（严禁删除通义听悟网页原记录！）
        if (rawDest !== finalTxtPath) {
          await fs.unlink(rawDest).catch(() => {});
        }
      } catch {
        // 回退到方式 B 直接采集详情页原文区
      }
    }

    if (!cleanedText || cleanedText.length < 20) {
      cleanedText = await scrapeDetailTranscript(page);
    }

    if (!cleanedText || cleanedText.length < 10) {
      if (/转写中|处理中|排队中|生成中/.test(body)) {
        await patch(j.id, { status: 'processing', lastUrl: page.url() });
        return false;
      }
      await debug(page, 'collect-empty');
      await patch(j.id, { status: 'waiting', note: '暂未获取到正文，稍后重试', lastUrl: page.url() });
      return false;
    }

    await fs.writeFile(finalTxtPath, cleanedText, 'utf8');
    await patch(j.id, { status: 'downloaded', output: finalTxtPath, lastUrl: page.url() });
    say(`已获取干净口播逐字稿（${cleanedText.length} 字）：${finalTxtPath}`);
    return true;
  } catch (e) {
    await debug(page, 'collect-failed');
    await patch(j.id, { status: 'failed', error: String(e.message || e), lastUrl: page.url() });
    return false;
  }
}

async function collect(show = false) {
  const c = await open(!show);
  const p = c.pages()[0] || (await c.newPage());
  try {
    if (!(await logged(p))) throw new Error('LOGIN_REQUIRED');
    const s = await readState();
    const jobs = s.jobs.filter((j) => ['submitted', 'waiting', 'processing', 'ready'].includes(j.status));
    say('待检查任务：' + jobs.length);
    for (const j of jobs) await collectOne(p, j);
  } finally {
    await c.close();
  }
}

async function run(inputPath, out, show = false) {
  const files = await media(inputPath);
  if (!files.length) throw new Error('没有找到支持的音视频文件');
  const target = path.resolve(out || path.join(path.dirname(path.resolve(inputPath)), '听悟转写结果'));
  say('准备转写文件：' + path.basename(files[0]));
  const c = await open(!show);
  const p = c.pages()[0] || (await c.newPage());
  try {
    if (!(await logged(p))) throw new Error('LOGIN_REQUIRED');
    for (const f of files) {
      await submit(p, f, target);
      await wait(1200);
    }
    // 短间隔快速轮询（每 8 秒查一次，最多约 12 分钟），转完秒级取回
    for (let cycle = 0; cycle < 90; cycle++) {
      const s = await readState();
      const pending = s.jobs.filter((j) => ['submitted', 'waiting', 'processing', 'ready'].includes(j.status));
      if (!pending.length) {
        say('全部转写任务已完成。');
        break;
      }
      await wait(8000);
      say(`轮询检查通义听悟转写进度（第 ${cycle + 1} 次）...`);
      for (const j of pending) await collectOne(p, j);
    }
  } finally {
    await c.close();
  }
}

async function main() {
  const [, , cmd, ...args] = process.argv;
  const show = args.includes('--visible');
  const a = args.filter((x) => x !== '--visible');
  if (cmd === 'login') return login();
  if (cmd === 'run' && a[0]) return run(a[0], a[1], show);
  if (cmd === 'collect') return collect(show);
  console.log('用法: node tingwu.mjs <login|run|collect>');
}

main().catch((e) => {
  if (e.message === 'LOGIN_REQUIRED') {
    console.error('LOGIN_REQUIRED: 通义听悟尚未登录或登录态已过期');
    process.exitCode = 2;
  } else {
    console.error('错误：' + (e.stack || e));
    process.exitCode = 1;
  }
});
