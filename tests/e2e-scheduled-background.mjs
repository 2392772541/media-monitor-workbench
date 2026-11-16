import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const ROOT = path.resolve(import.meta.dirname, '..');
const ARTIFACTS = path.join(ROOT, 'tests', 'artifacts');
const PORT = 18916;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mmw-sched-'));
const DB_FILE = path.join(TMP_DIR, 'sched.db');

function resolveChromium() {
  const exe = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1254', 'chrome-win64', 'chrome.exe');
  return fs.existsSync(exe) ? exe : undefined;
}

async function waitForHealth() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE_URL}/api/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Server did not start in time');
}

async function main() {
  let publishSecondItem = false;
  const feedServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8' });
    const item2 = publishSecondItem
      ? `<item><title>定时后台新发现文章 V2</title><link>http://127.0.0.1:${feedServer.address().port}/post-2</link><description>关闭前端页面后由后台定时调度自动发现的新文章。</description><pubDate>Sat, 15 Nov 2026 02:00:00 GMT</pubDate></item>`
      : '';
    res.end(`<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0"><channel><title>后台定时测试订阅</title>
        <item><title>初始文章 V1</title><link>http://127.0.0.1:${feedServer.address().port}/post-1</link><description>初始已有文章内容。</description><pubDate>Sat, 15 Nov 2026 01:00:00 GMT</pubDate></item>
        ${item2}
      </channel></rss>`);
  });
  await new Promise((r) => feedServer.listen(0, '127.0.0.1', r));
  const feedUrl = `http://127.0.0.1:${feedServer.address().port}/feed.xml`;

  const child = spawn('node', ['dist/server.js'], {
    cwd: ROOT,
    env: { ...process.env, MMW_PORT: String(PORT), MMW_DB_PATH: DB_FILE },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let browser;
  try {
    await waitForHealth();
    const execPath = resolveChromium();
    browser = await chromium.launch({ executablePath: execPath, headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

    // 1. Add source through UI (first run fetches V1)
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.getByTestId('nav-sources').click();
    await page.getByTestId('btn-open-add-source').click();
    await page.getByTestId('input-source-url').fill(feedUrl);
    await page.getByRole('button', { name: '自动识别与检测' }).click();
    await page.waitForTimeout(800);
    await page.getByTestId('btn-save-source').click();
    await page.waitForTimeout(1500);

    // Verify V1 is present
    await page.getByTestId('nav-contents').click();
    await page.waitForTimeout(800);
    assert.equal(await page.locator('[data-testid^="content-card-"]').count(), 1);

    // 2. Close frontend completely
    await page.close();
    await browser.close();
    browser = null;
    console.log('[SCHED-E2E] 前端页面已完全关闭，发布新文章 V2 并模拟定时周期到期...');

    // 3. Publish V2 and backdate last_checked_at in SQLite so next 30s scheduler tick triggers automatically
    publishSecondItem = true;
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(DB_FILE);
    db.prepare('UPDATE sources SET last_checked_at = ?').run(new Date(Date.now() - 2 * 3600 * 1000).toISOString());
    db.close();

    // 4. Wait for the 30s scheduler tick to execute 'scheduled' task while UI is closed
    let scheduledDone = false;
    for (let i = 0; i < 45; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const tasks = await (await fetch(`${BASE_URL}/api/tasks`)).json();
      if (tasks.some((t) => t.trigger_type === 'scheduled' && t.status === 'success' && t.items_new === 1)) {
        scheduledDone = true;
        break;
      }
    }
    assert.equal(scheduledDone, true, 'Background scheduler did not trigger and capture V2 in time');

    // 5. Reopen frontend UI and verify V2 appeared, V1 not duplicated, and Tasks page shows scheduled run
    browser = await chromium.launch({ executablePath: execPath, headless: true });
    const page2 = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page2.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page2.getByTestId('nav-contents').click();
    await page2.waitForTimeout(800);
    const totalCards = await page2.locator('[data-testid^="content-card-"]').count();
    assert.equal(totalCards, 2, `Expected 2 items (V1 + V2) without duplicate, got ${totalCards}`);
    const v2Visible = await page2.locator('text=定时后台新发现文章 V2').count();
    assert.ok(v2Visible >= 1, 'V2 title not found in reopened UI');

    await page2.getByTestId('nav-tasks').click();
    await page2.waitForTimeout(500);
    const schedTaskVisible = await page2.locator('td:text-is("定时")').count();
    assert.ok(schedTaskVisible >= 1, 'Scheduled task row not shown in UI');
    await page2.screenshot({ path: path.join(ARTIFACTS, 'e2e-08-scheduled-task.png') });
    console.log('[PASS] 关闭前端后后台定时调度自动触发、发现新文章 V2 且未重复采集 V1！');
  } finally {
    await browser?.close().catch(() => {});
    await fetch(`${BASE_URL}/api/system/shutdown`, { method: 'POST' }).catch(() => {});
    await new Promise((r) => setTimeout(r, 800));
    try { child.kill('SIGKILL'); } catch {}
    feedServer.close();
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
