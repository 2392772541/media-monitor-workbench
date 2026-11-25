#!/usr/bin/env node
// 内置通义听悟网页额度转写脚本（自动复用主项目 playwright 或 playwright-core，换电脑开箱即用）
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
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
const DATA = path.join(process.env.LOCALAPPDATA || os.homedir(), 'TingwuWebBatch');
const PROFILE = path.join(DATA, 'browser-profile');
const LOGS = path.join(DATA, 'logs');
const STATE = path.join(DATA, 'jobs.json');
const EXT = new Set(['.mp3', '.mp4', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wma', '.mov', '.mkv', '.avi', '.webm', '.ts', '.mpeg', '.mpg']);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString().replace(/[:.]/g, '-');
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
    args: ['--disable-blink-features=AutomationControlled'],
  });
}
async function debug(page, name) {
  const p = path.join(LOGS, now() + '-' + name);
  await page.screenshot({ path: p + '.png', fullPage: true }).catch(() => {});
  await fs.writeFile(p + '.html', await page.content().catch(() => ''), 'utf8').catch(() => {});
  say('诊断文件：' + p + '.png');
  return p;
}
async function logged(page) {
  await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);
  return !(await page.getByText('立即登录', { exact: true }).isVisible().catch(() => false));
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
      id: now() + '-' + Math.random().toString(16).slice(2, 8),
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

async function login() {
  const c = await open(false);
  const p = c.pages()[0] || (await c.newPage());
  try {
    await p.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 60000 });
    say('请在窗口里登录通义听悟，只需要这一次；成功后窗口会自动关闭。');
    let ok = false;
    for (let i = 0; i < 300; i++) {
      await p.waitForTimeout(2000);
      const loginVisible = await p.getByText('立即登录', { exact: true }).isVisible().catch(() => false);
      const user = await p.evaluate(() => window._USER_ || null).catch(() => null);
      if (!loginVisible && (user?.aliyunUid || user?.nickName || user?.userId)) {
        ok = true;
        break;
      }
      if (!loginVisible && i > 2) {
        ok = true;
        break;
      }
    }
    if (!ok) throw new Error('10分钟内没有检测到登录成功');
    await p.waitForTimeout(1500);
    say('登录状态已保存，以后默认后台运行。');
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
      page.getByRole('button', { name: /上传音视频|上传文件/ }),
    ]);
    if (!up) throw new Error('找不到上传音视频入口');
    await up.click();
    await page.waitForTimeout(1200);
    await chooseFile(page, file);
    await page.waitForTimeout(1200);
    const ok = await visible([
      page.getByRole('button', { name: /开始上传|确认上传|上传并转写|开始转写|立即上传/ }),
      page.getByText(/开始上传|确认上传|上传并转写|开始转写|立即上传/, { exact: false }),
    ]);
    if (ok) await ok.click();
    const start = Date.now();
    let accepted = false;
    while (Date.now() - start < 90000) {
      const t = await page.locator('body').innerText().catch(() => '');
      if (/上传成功|转写中|处理中|排队中|已添加到我的记录/.test(t)) {
        accepted = true;
        break;
      }
      if (/上传失败|格式不支持|时长不足|空间不足/.test(t)) throw new Error('网页报告上传失败');
      await wait(1500);
    }
    if (!accepted) throw new Error('90秒内没有确认上传成功');
    await patch(j.id, { status: 'submitted', submittedAt: new Date().toISOString(), lastUrl: page.url() });
    say('已提交：' + path.basename(file));
  } catch (e) {
    const d = await debug(page, 'upload-failed');
    await patch(j.id, { status: 'failed', error: String(e.message || e), debug: d });
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

async function collectOne(page, j) {
  try {
    await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1800);
    const mine = await visible([page.getByText('我的记录', { exact: true }), page.getByText(/我的记录/, { exact: false })]);
    if (mine) await mine.click();
    await page.waitForTimeout(1800);
    const stem = path.parse(j.file).name;
    const record = await visible([page.getByText(stem, { exact: true }), page.getByText(stem, { exact: false })]);
    if (!record) {
      await patch(j.id, { status: 'waiting', note: '未找到同名记录' });
      return false;
    }
    await record.click();
    await page.waitForTimeout(2200);
    const body = await page.locator('body').innerText();
    if (/失败|转写异常/.test(body)) throw new Error('网页转写任务失败');
    if (/转写中|处理中|排队中|生成中/.test(body) && !/导出/.test(body)) {
      await patch(j.id, { status: 'processing', lastUrl: page.url() });
      return false;
    }
    const exp = await visible([page.getByRole('button', { name: /导出|下载/ }), page.getByText(/导出|下载/, { exact: true })]);
    if (!exp) {
      await patch(j.id, { status: 'ready', lastUrl: page.url(), note: '未识别到导出按钮' });
      return false;
    }
    await exp.click();
    await page.waitForTimeout(700);
    const opt = await visible([
      page.getByText(/纯文本|TXT|文本文件|转写文本/, { exact: false }),
      page.getByRole('menuitem', { name: /纯文本|TXT|文本/ }),
    ]);
    if (opt) await opt.click();
    const dp = page.waitForEvent('download', { timeout: 15000 });
    const fin = await visible([
      page.getByRole('button', { name: /导出|下载|确定/ }),
      page.getByText(/开始导出|确认导出|下载文件/, { exact: false }),
    ]);
    if (fin) await fin.click();
    const dl = await dp;
    await fs.mkdir(j.outputDir, { recursive: true });
    const dest = path.join(j.outputDir, dl.suggestedFilename() || stem + '.txt');
    await dl.saveAs(dest);
    await patch(j.id, { status: 'downloaded', output: dest, lastUrl: page.url() });
    say('已下载：' + dest);
    return true;
  } catch (e) {
    const d = await debug(page, 'collect-failed');
    await patch(j.id, { status: 'failed', error: String(e.message || e), debug: d, lastUrl: page.url() });
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
  say('发现' + files.length + '个文件；结果目录：' + target);
  const c = await open(!show);
  const p = c.pages()[0] || (await c.newPage());
  try {
    if (!(await logged(p))) throw new Error('LOGIN_REQUIRED');
    for (const f of files) {
      try {
        await submit(p, f, target);
      } catch (e) {
        say('提交失败：' + path.basename(f) + '；' + e.message);
      }
      await wait(1200);
    }
    for (let cycle = 0; cycle < 360; cycle++) {
      const s = await readState();
      const pending = s.jobs.filter((j) => ['submitted', 'waiting', 'processing', 'ready'].includes(j.status));
      if (!pending.length) {
        say('全部任务已完成或已记录失败状态。');
        break;
      }
      say('检查转写结果，剩余' + pending.length + '个任务。');
      for (const j of pending) await collectOne(p, j);
      const after = await readState();
      if (!after.jobs.some((j) => ['submitted', 'waiting', 'processing', 'ready'].includes(j.status))) break;
      say('尚未全部完成，2分钟后继续后台检查。');
      await wait(120000);
    }
  } finally {
    await c.close();
  }
}

async function diagnose() {
  const c = await open(false);
  const p = c.pages()[0] || (await c.newPage());
  try {
    await p.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await p.waitForTimeout(2500);
    console.log(
      JSON.stringify(
        {
          loggedIn: await logged(p),
          url: p.url(),
          buttons: await p.locator('button').allInnerTexts(),
        },
        null,
        2
      )
    );
    await debug(p, 'diagnose');
    const rl = readline.createInterface({ input, output });
    await rl.question('检查完成后按回车关闭：');
    rl.close();
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
  if (cmd === 'diagnose') return diagnose();
  console.log('用法: node tingwu.mjs <login|run|collect|diagnose>');
}

main().catch((e) => {
  if (e.message === 'LOGIN_REQUIRED') {
    console.error('通义听悟登录已失效，请在工作台「浏览器与登录」页重新登录。');
    process.exitCode = 2;
  } else {
    console.error('错误：' + (e.stack || e));
    process.exitCode = 1;
  }
});
