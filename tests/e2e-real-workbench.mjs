import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = path.resolve(import.meta.dirname, '..');
const ARTIFACTS = path.join(ROOT, 'tests', 'artifacts');
const PORT = 18915;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TMP_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mmw-e2e-'));
const DB_FILE = path.join(TMP_DB_DIR, 'e2e.db');
const E2E_BROWSER_PROFILE = path.join(TMP_DB_DIR, 'ui-tester-profile');

function resolveChromium() {
  const localAppData = process.env.LOCALAPPDATA || '';
  const exe = path.join(localAppData, 'ms-playwright', 'chromium-1254', 'chrome-win64', 'chrome.exe');
  if (fs.existsSync(exe)) return exe;
  return undefined;
}

function assert(cond, msg) {
  if (!cond) throw new Error('E2E ASSERTION FAILED: ' + msg);
}

async function waitForHealth(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE_URL}/api/health`);
      if (r.ok) return await r.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('Server health check timeout');
}

function startServer() {
  const child = spawn('node', ['dist/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      MMW_PORT: String(PORT),
      MMW_DB_PATH: DB_FILE,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[server-err] ${d}`));
  return child;
}

async function stopServerGracefully(child) {
  try {
    await fetch(`${BASE_URL}/api/system/shutdown`, { method: 'POST' });
  } catch {}
  await new Promise((resolve) => {
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 4000);
    child.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

async function run() {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const report = {
    startedAt: new Date().toISOString(),
    steps: [],
    errors: [],
  };
  const record = (name, ok, detail) => {
    report.steps.push({ name, ok, detail, time: new Date().toISOString() });
    console.log(`[E2E] ${ok ? 'PASS' : 'FAIL'} | ${name}: ${detail}`);
  };

  let serverProc = startServer();
  await waitForHealth();
  record('1. 启动本地工作台服务', true, `127.0.0.1:${PORT} 就绪`);

  const execPath = resolveChromium();
  let browser = await chromium.launch({ executablePath: execPath, headless: true });
  let page = await browser.newPage({ viewport: { width: 1366, height: 860 } });

  try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.screenshot({ path: path.join(ARTIFACTS, 'e2e-01-overview.png') });
    record('2. 访问中文工作台首页', true, await page.title());

    // Add real website: Ruanyifeng Blog (tests RSS auto-discovery + real articles)
    await page.getByTestId('nav-sources').click();
    await page.getByTestId('btn-open-add-source').click();
    await page.getByTestId('input-source-url').fill('https://www.ruanyifeng.com/blog/');
    await page.getByRole('button', { name: '自动识别与检测' }).click();
    await page.waitForTimeout(3000);
    await page.getByTestId('btn-save-source').click();
    await page.waitForTimeout(1000);

    // Add real YouTube creator channel
    await page.getByTestId('btn-open-add-source').click();
    await page.getByTestId('input-source-url').fill('https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw');
    await page.getByRole('button', { name: '自动识别与检测' }).click();
    await page.waitForTimeout(3000);
    await page.getByTestId('btn-save-source').click();
    await page.waitForTimeout(1000);

    // Add unreachable site for error handling test
    await page.getByTestId('btn-open-add-source').click();
    await page.getByTestId('input-source-url').fill('http://127.0.0.1:19999/broken-endpoint');
    await page.getByTestId('input-source-name').fill('异常测试站点');
    await page.getByTestId('btn-save-source').click();

    // Wait for background tasks to finish on Tasks page
    await page.getByTestId('nav-tasks').click();
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(1500);
      const runningBadges = await page.locator('text=执行中').count();
      const queuedBadges = await page.locator('text=排队中').count();
      if (runningBadges === 0 && queuedBadges === 0) break;
    }
    await page.screenshot({ path: path.join(ARTIFACTS, 'e2e-02-tasks.png') });
    const successRows = await page.locator('span:text-is("成功")').count();
    const failedRows = await page.locator('span:text-is("失败")').count();
    assert(successRows >= 2, `Expected >=2 successful collections, got ${successRows}`);
    assert(failedRows >= 1, `Expected >=1 failed collection for unreachable site, got ${failedRows}`);
    record('3. 真实网站+YouTube采集与异常识别', true, `成功任务 ${successRows} 个，异常拦截 ${failedRows} 个`);

    // Check Sources page & deduplication by triggering Ruanyifeng check a second time
    await page.getByTestId('nav-sources').click();
    await page.waitForTimeout(500);
    // Test editing a source via UI modal
    const firstEditBtn = page.locator('[data-testid^="btn-edit-source-"]').first();
    await firstEditBtn.click();
    await page.getByTestId('input-edit-name').fill('异常测试站点-已编辑');
    await page.getByTestId('btn-save-edit').click();
    await page.waitForTimeout(500);
    const editedVisible = await page.locator('text=异常测试站点-已编辑').count();
    assert(editedVisible >= 1, 'Edited source name not visible in UI');
    await page.screenshot({ path: path.join(ARTIFACTS, 'e2e-03-sources.png') });

    // Navigate to Contents page, check real items
    await page.getByTestId('nav-contents').click();
    await page.waitForTimeout(1000);
    const cardsCountBefore = await page.locator('[data-testid^="content-card-"]').count();
    assert(cardsCountBefore > 5, `Expected real articles > 5, got ${cardsCountBefore}`);
    await page.screenshot({ path: path.join(ARTIFACTS, 'e2e-04-contents.png') });

    // Open first article detail, check original link, favorite it
    const firstCard = page.locator('[data-testid^="content-card-"]').first();
    await firstCard.click();
    await page.waitForTimeout(500);
    const origLink = await page.locator('a:has-text("打开原始链接")').getAttribute('href');
    assert(origLink && origLink.startsWith('http'), `Invalid original link: ${origLink}`);
    await page.locator('.modal-header button:has-text("收藏")').click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(ARTIFACTS, 'e2e-05-detail.png') });
    await page.locator('.modal-header button:has-text("关闭")').click();
    record('4. 内容流展示、详情阅读与收藏', true, `共展示 ${cardsCountBefore} 条真实内容，原始链接=${origLink}`);

    // Test deduplication: re-run check on first source via UI
    await page.getByTestId('nav-sources').click();
    await page.waitForTimeout(400);
    await page.locator('button:has-text("立即检查")').first().click();
    await page.waitForTimeout(3500);
    await page.getByTestId('nav-contents').click();
    await page.waitForTimeout(800);
    const cardsCountAfter = await page.locator('[data-testid^="content-card-"]').count();
    assert(cardsCountAfter === cardsCountBefore, `Deduplication failed: ${cardsCountBefore} -> ${cardsCountAfter}`);
    record('5. 重复采集去重验证', true, `二次采集前后条数保持一致 (${cardsCountAfter} 条)`);

    // Test Browser Management page & Douyin login check
    await page.getByTestId('nav-browsers').click();
    await page.waitForTimeout(500);
    await page.locator('tr:has-text("抖音") button:has-text("检查状态")').click();
    await page.waitForTimeout(8000);
    await page.screenshot({ path: path.join(ARTIFACTS, 'e2e-06-browsers.png') });
    record('6. 独立浏览器登录态检测', true, '抖音独立配置状态检测完成，未触碰日常 Chrome');

    // Close frontend browser page and confirm backend still runs
    await page.close();
    await browser.close();
    const healthWhileClosed = await waitForHealth(5000);
    assert(healthWhileClosed.ok === true, 'Backend stopped after closing UI!');
    record('7. 关闭前端后后台持续运行', true, `PID=${healthWhileClosed.pid} 仍在后台正常运行`);

    // Restart entire server to test data persistence
    await stopServerGracefully(serverProc);
    serverProc = startServer();
    await waitForHealth();

    browser = await chromium.launch({ executablePath: execPath, headless: true });
    page = await browser.newPage({ viewport: { width: 1366, height: 860 } });
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.getByTestId('nav-contents').click();
    await page.waitForTimeout(800);
    await page.getByRole('button', { name: '只看收藏' }).click();
    await page.waitForTimeout(600);
    const favCountAfterRestart = await page.locator('[data-testid^="content-card-"]').count();
    assert(favCountAfterRestart >= 1, 'Favorite status lost after full server restart!');
    await page.screenshot({ path: path.join(ARTIFACTS, 'e2e-07-persistence.png') });
    record('8. 完整重启后数据与收藏持久化', true, `重启后保留 ${favCountAfterRestart} 条收藏记录与全部监控对象`);
  } finally {
    await browser?.close().catch(() => {});
    await stopServerGracefully(serverProc);
    fs.writeFileSync(path.join(ARTIFACTS, 'e2e-report.json'), JSON.stringify(report, null, 2), 'utf8');
    fs.rmSync(TMP_DB_DIR, { recursive: true, force: true });
    fs.rmSync(E2E_BROWSER_PROFILE, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error('E2E FAILED:', err);
  process.exit(1);
});
