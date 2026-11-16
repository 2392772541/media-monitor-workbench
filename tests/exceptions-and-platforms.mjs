import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const ROOT = path.resolve(import.meta.dirname, '..');
const ARTIFACTS = path.join(ROOT, 'tests', 'artifacts');
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mmw-exc-'));
process.env.MMW_DB_PATH = path.join(TMP_DIR, 'exc.db');

const { getDb, closeDb } = await import('../dist/db/database.js');
const { withHeadlessContext, getProfileLockInfo } = await import('../dist/browser/profileManager.js');
const { getAdapter } = await import('../dist/adapters/index.js');
const { fetchText } = await import('../dist/adapters/webUtils.js');

async function startMockTargets() {
  const server = http.createServer((req, res) => {
    if (req.url === '/spa-changed') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>结构变化页</title></head><body><div id="root"></div><script>
        document.getElementById('root').innerHTML = '<h1>动态变更结构标题</h1><p>这是结构调整后由前端脚本渲染出的真实正文内容。</p>';
      </script></body></html>`);
      return;
    }
    if (req.url === '/hang') {
      // intentionally hang until client times out
      return;
    }
    res.writeHead(404);
    res.end('Not Found');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function main() {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  getDb();
  const { server, baseUrl } = await startMockTargets();
  const report = { exceptions: {}, platforms: {} };

  try {
    // 1. Concurrency lock conflict
    let conflictCaught = false;
    await withHeadlessContext('other', 'owner-1', async () => {
      assert.equal(getProfileLockInfo('other').locked, true);
      try {
        await withHeadlessContext('other', 'owner-2', async () => {});
      } catch (err) {
        conflictCaught = String(err.message).includes('PROFILE_LOCKED');
      }
    });
    assert.equal(conflictCaught, true, 'Profile lock conflict was not caught');
    assert.equal(getProfileLockInfo('other').locked, false);
    report.exceptions.taskLockConflict = { pass: true, detail: '同目录并发争抢成功拦截并报错 PROFILE_LOCKED' };
    console.log('[PASS] 1. 任务并发互斥锁验证');

    // 2. Browser crash / forced close recovery
    let crashCaught = false;
    try {
      await withHeadlessContext('other', 'crash-test', async (ctx) => {
        await ctx.close(); // simulate unexpected exit mid-task
        await ctx.newPage(); // should throw target closed
      });
    } catch {
      crashCaught = true;
    }
    assert.equal(crashCaught, true);
    assert.equal(getProfileLockInfo('other').locked, false, 'Lock leaked after crash');
    const recovered = await withHeadlessContext('other', 'recover-test', async (ctx) => {
      const p = await ctx.newPage();
      await p.setContent('<title>Recovered</title>');
      return await p.title();
    });
    assert.equal(recovered, 'Recovered');
    report.exceptions.browserCrashRecovery = { pass: true, detail: '浏览器异常退出后锁自动释放且下一次任务成功恢复' };
    console.log('[PASS] 2. 浏览器异常退出与恢复验证');

    // 3. Page structure change / dynamic SPA fallback
    const webAdapter = getAdapter('website');
    const spaRes = await webAdapter.fetchLatest(
      {
        id: 99,
        name: '结构变化测试页',
        platform: 'website',
        url: `${baseUrl}/spa-changed`,
        source_type: 'website',
        interval_minutes: 60,
        status: 'active',
        config_json: '{}',
      },
      { headless: true }
    );
    assert.equal(spaRes.ok, true);
    assert.ok(spaRes.items.length >= 1 && spaRes.items[0].body.includes('动态变更结构标题'));
    report.exceptions.pageStructureChange = { pass: true, detail: `静态解析不足时自动降级独立浏览器渲染提取: ${spaRes.items[0].title}` };
    console.log('[PASS] 3. 页面结构变化/SPA动态降级验证');

    // 4. Network timeout / unreachable
    const hangRes = await fetchText(`${baseUrl}/hang`, 1200);
    assert.equal(hangRes.ok, false);
    report.exceptions.networkTimeout = { pass: true, detail: `请求超时准确拦截: ${hangRes.error}` };
    console.log('[PASS] 4. 网络超时/中断拦截验证');

    // 5. All 5 social platforms real checkLoginStatus in isolated profiles
    for (const p of ['douyin', 'kuaishou', 'wechat-channels', 'x', 'youtube']) {
      const adapter = getAdapter(p);
      const loginRes = await adapter.checkLoginStatus();
      report.platforms[p] = loginRes;
      console.log(`[PLATFORM] ${p}: loggedIn=${loginRes.loggedIn}, status=${loginRes.status}, cap=${loginRes.capabilityStatus}, msg=${loginRes.message}`);
    }
  } finally {
    server.close();
    closeDb();
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
    fs.writeFileSync(path.join(ARTIFACTS, 'platforms-exceptions-report.json'), JSON.stringify(report, null, 2), 'utf8');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
