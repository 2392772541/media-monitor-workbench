import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const FALLBACK_SCRIPT = 'C:\\Users\\win10\\.gemini\\config\\skills\\video-auto-publisher\\scripts\\workbench_fallback.py';
const PYTHON_EXE = 'E:\\app\\Miniconda\\python.exe';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmw-tier5-test-'));
process.env.MMW_DB_PATH = path.join(tmpDir, 'tier5-test.db');

const mockSauServer = http.createServer((req, res) => {
  if (req.url === '/getAccounts') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 200, msg: null, data: [] }));
    return;
  }
  if (req.url === '/getValidAccounts') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 200, msg: null, data: [[1, 3, 'dy.json', '抖音号', 1]] }));
    return;
  }
  if (req.url?.startsWith('/getPublishHistory')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 200, msg: 'success', data: [] }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ code: 404, msg: 'not found', data: null }));
});
await new Promise((resolve) => mockSauServer.listen(0, '127.0.0.1', resolve));
process.env.MMW_SAU_PORT = String(mockSauServer.address().port);

const { getDb, closeDb } = await import('../dist/db/database.js');
const { registerRoutes } = await import('../dist/api/routes.js');

const app = Fastify({ logger: false });
registerRoutes(app, async () => {});

// 准备隔离测试数据（含 % 与 _ 特殊字符用于 SQL LIKE 转义测试）
const db = getDb();
const now = new Date().toISOString();
const s1 = db
  .prepare(
    `INSERT INTO sources (name, platform, url, source_type, priority, interval_minutes, status, created_at, updated_at)
     VALUES (?, 'bilibili', 'https://space.bilibili.com/1001', 'creator', 1, 30, 'active', ?, ?)`
  )
  .run('普通博主A', now, now);
const s2 = db
  .prepare(
    `INSERT INTO sources (name, platform, url, source_type, priority, interval_minutes, status, created_at, updated_at)
     VALUES (?, 'douyin', 'https://www.douyin.com/user/1002', 'creator', 1, 30, 'active', ?, ?)`
  )
  .run('包含_下划线的博主', now, now);
const sid1 = Number(s1.lastInsertRowid);
const sid2 = Number(s2.lastInsertRowid);

db.prepare(
  `INSERT INTO contents (source_id, platform, platform_item_id, canonical_url, content_hash, title, summary, body, discovered_at, published_at)
   VALUES (?, 'bilibili', 'v1', 'https://example.com/v1', 'h1', ?, ?, ?, ?, ?)`
).run(sid1, '普通视频标题一', '普通简介', '普通正文', now, now);

db.prepare(
  `INSERT INTO contents (source_id, platform, platform_item_id, canonical_url, content_hash, title, summary, body, discovered_at, published_at)
   VALUES (?, 'bilibili', 'v2', 'https://example.com/v2', 'h2', ?, ?, ?, ?, ?)`
).run(sid1, '实测涨幅100%的农资方案', '带百分号测试', '正文内容', now, now);

db.prepare(
  `INSERT INTO contents (source_id, platform, platform_item_id, canonical_url, content_hash, title, summary, body, discovered_at, published_at)
   VALUES (?, 'douyin', 'v3', 'https://example.com/v3', 'h3', ?, ?, ?, ?, ?)`
).run(sid2, '下划线_专属标题', '无百分号', '正文', now, now);

const boardIns = db
  .prepare(
    `INSERT INTO topic_board (account_id, title, core_angle, notes, priority, status, created_at, updated_at)
     VALUES (1, ?, ?, ?, 'medium', 'to_research', ?, ?)`
  )
  .run('100%实操复盘选题', '常规角度', '备注内容', now, now);
const boardId = Number(boardIns.lastInsertRowid);

db.prepare(
  `INSERT INTO topic_board (account_id, title, core_angle, notes, priority, status, created_at, updated_at)
   VALUES (1, ?, ?, ?, 'low', 'to_research', ?, ?)`
).run('普通选题记录', '普通角度', '无特殊字符', now, now);

test('GAP-1: PublishPage 与构建产物使用 POST /api/sau/accounts/validate，后端仅响应 POST', async () => {
  const getRes = await app.inject({ method: 'GET', url: '/api/sau/accounts/validate' });
  assert.equal(getRes.statusCode, 404);
  const postRes = await app.inject({ method: 'POST', url: '/api/sau/accounts/validate' });
  assert.equal(postRes.statusCode, 200);
  assert.equal(postRes.json().code, 200);

  const publishTsx = fs.readFileSync(path.join(PROJECT_ROOT, 'frontend', 'src', 'pages', 'PublishPage.tsx'), 'utf8');
  assert.match(publishTsx, /\/api\/sau\/accounts\/validate['"],\s*\{\s*method:\s*['"]POST['"]\s*\}/);

  const distHtml = fs.readFileSync(path.join(PROJECT_ROOT, 'frontend', 'dist', 'index.html'), 'utf8');
  const scriptMatch = distHtml.match(/src="\/assets\/(index-[^"]+\.js)"/);
  assert.ok(scriptMatch, 'frontend/dist/index.html 必须引用构建后的 JS bundle');
  const bundleJs = fs.readFileSync(path.join(PROJECT_ROOT, 'frontend', 'dist', 'assets', scriptMatch[1]), 'utf8');
  assert.match(bundleJs, /\/api\/sau\/accounts\/validate['"`],\s*\{\s*method:\s*['"`]POST['"`]\s*\}/);
});

test('GAP-2: CreatorsPage 与 ContentDrawer 包含请求序号与 AbortController 竞态防护', () => {
  const creatorsTsx = fs.readFileSync(path.join(PROJECT_ROOT, 'frontend', 'src', 'pages', 'CreatorsPage.tsx'), 'utf8');
  const drawerTsx = fs.readFileSync(path.join(PROJECT_ROOT, 'frontend', 'src', 'components', 'ContentDrawer.tsx'), 'utf8');
  const apiTs = fs.readFileSync(path.join(PROJECT_ROOT, 'frontend', 'src', 'api.ts'), 'utf8');

  assert.match(apiTs, /fetchCreatorsFeed\([\s\S]*init\?:\s*RequestInit/);
  assert.match(creatorsTsx, /requestSeqRef/);
  assert.match(creatorsTsx, /new AbortController\(\)/);
  assert.match(creatorsTsx, /seq !== requestSeqRef\.current \|\| controller\.signal\.aborted/);
  assert.match(drawerTsx, /drawerSeqRef/);
  assert.match(drawerTsx, /new AbortController\(\)/);
  assert.match(drawerTsx, /seq !== drawerSeqRef\.current \|\| controller\.signal\.aborted/);
});

test('GAP-5: SQLite LIKE 通配符 (%, _, \\) 在全部检索接口中按字面量精准转义', async () => {
  // 1. /api/radar/creators/feed search
  const feedPct = await app.inject({
    method: 'GET',
    url: `/api/radar/creators/feed?creatorId=${sid1}&days=0&search=%25`,
  });
  assert.equal(feedPct.statusCode, 200);
  assert.equal(feedPct.json().total, 1);
  assert.equal(feedPct.json().items[0].title, '实测涨幅100%的农资方案');

  const feedUnderscore = await app.inject({
    method: 'GET',
    url: `/api/radar/creators/feed?creatorId=${sid1}&days=0&search=_`,
  });
  assert.equal(feedUnderscore.statusCode, 200);
  assert.equal(feedUnderscore.json().total, 0);

  // 2. /api/radar/creators q
  const creatorsUnderscore = await app.inject({ method: 'GET', url: '/api/radar/creators?q=_' });
  assert.equal(creatorsUnderscore.statusCode, 200);
  assert.equal(creatorsUnderscore.json().length, 1);
  assert.equal(creatorsUnderscore.json()[0].name, '包含_下划线的博主');

  const creatorsPct = await app.inject({ method: 'GET', url: '/api/radar/creators?q=%25' });
  assert.equal(creatorsPct.statusCode, 200);
  assert.equal(creatorsPct.json().length, 0);

  // 3. /api/contents q
  const contentsPct = await app.inject({ method: 'GET', url: '/api/contents?q=%25' });
  assert.equal(contentsPct.statusCode, 200);
  assert.equal(contentsPct.json().total, 1);

  const contentsUnderscore = await app.inject({ method: 'GET', url: '/api/contents?q=_' });
  assert.equal(contentsUnderscore.statusCode, 200);
  assert.equal(contentsUnderscore.json().total, 1);
  assert.equal(contentsUnderscore.json().items[0].title, '下划线_专属标题');

  // 4. /api/radar/intel q
  const intelPct = await app.inject({ method: 'GET', url: '/api/radar/intel?q=%25' });
  assert.equal(intelPct.statusCode, 200);
  assert.equal(intelPct.json().items.length, 1);

  // 5. /api/radar/board q
  const boardPct = await app.inject({ method: 'GET', url: '/api/radar/board?q=%25' });
  assert.equal(boardPct.statusCode, 200);
  assert.equal(boardPct.json().items.length, 1);
  assert.equal(boardPct.json().items[0].title, '100%实操复盘选题');

  const boardUnderscore = await app.inject({ method: 'GET', url: '/api/radar/board?q=_' });
  assert.equal(boardUnderscore.statusCode, 200);
  assert.equal(boardUnderscore.json().items.length, 0);
});

test('GAP-6: 非法数字/NaN/无效 ID 与无效状态优先级枚举统一返回 400 且不污染数据库', async () => {
  const badGetRoutes = [
    '/api/contents?limit=abc',
    '/api/contents?offset=abc',
    '/api/contents?sourceId=abc',
    '/api/contents?categoryId=abc',
    '/api/contents?days=abc',
    '/api/contents/abc',
    '/api/radar/intel?limit=abc',
    '/api/radar/intel?sourceId=abc',
    '/api/radar/intel?accountId=abc',
    '/api/radar/creators/feed?creatorId=abc',
    '/api/radar/creators/feed?days=abc',
    '/api/radar/creators/feed?limit=abc',
    '/api/radar/creators/feed?offset=abc',
    '/api/radar/creators/leaderboard?limit=abc',
    '/api/radar/intel/abc/remix',
    '/api/sau/publish-history?limit=abc',
  ];
  for (const url of badGetRoutes) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 400, `Expected 400 for GET ${url}, got ${res.statusCode}`);
  }

  // PUT /api/radar/creators/interval 拒绝 NaN 并保护 app_settings
  const badInterval = await app.inject({
    method: 'PUT',
    url: '/api/radar/creators/interval',
    payload: { intervalMinutes: 'abc' },
  });
  assert.equal(badInterval.statusCode, 400);
  const badIntervalZero = await app.inject({
    method: 'PUT',
    url: '/api/radar/creators/interval',
    payload: { intervalMinutes: 0 },
  });
  assert.equal(badIntervalZero.statusCode, 400);
  const settingRow = db.prepare("SELECT value FROM app_settings WHERE key = 'default_creator_interval'").get();
  assert.notEqual(settingRow?.value, 'NaN');

  // PATCH /api/radar/accounts/:id 拒绝 NaN/负数权重及非法 ID
  const badAccId = await app.inject({
    method: 'PATCH',
    url: '/api/radar/accounts/abc',
    payload: { weight_match: 30 },
  });
  assert.equal(badAccId.statusCode, 400);
  const badWeight = await app.inject({
    method: 'PATCH',
    url: '/api/radar/accounts/1',
    payload: { weight_match: 'abc' },
  });
  assert.equal(badWeight.statusCode, 400);

  // PATCH /api/radar/board/:id 拒绝非法枚举与非法复盘数值
  const badStatus = await app.inject({
    method: 'PATCH',
    url: `/api/radar/board/${boardId}`,
    payload: { status: 'hacked_status' },
  });
  assert.equal(badStatus.statusCode, 400);
  const badPrio = await app.inject({
    method: 'PATCH',
    url: `/api/radar/board/${boardId}`,
    payload: { priority: 'invalid_prio' },
  });
  assert.equal(badPrio.statusCode, 400);
  const badReview = await app.inject({
    method: 'PATCH',
    url: `/api/radar/board/${boardId}`,
    payload: { review_views: 'abc' },
  });
  assert.equal(badReview.statusCode, 400);
  const badBoardId = await app.inject({
    method: 'PATCH',
    url: '/api/radar/board/abc',
    payload: { status: 'to_create' },
  });
  assert.equal(badBoardId.statusCode, 400);

  const boardAfter = db.prepare('SELECT status, priority FROM topic_board WHERE id = ?').get(boardId);
  assert.equal(boardAfter.status, 'to_research');
  assert.equal(boardAfter.priority, 'medium');

  // POST /api/radar/intel/:id/remix & fetch-history & sources/:id
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/radar/intel/abc/remix', payload: { mode: 'breakdown' } })).statusCode,
    400
  );
  assert.equal(
    (await app.inject({ method: 'POST', url: `/api/radar/creators/${sid1}/fetch-history`, payload: { maxPages: 'abc' } })).statusCode,
    400
  );
  assert.equal(
    (await app.inject({ method: 'PATCH', url: '/api/sources/abc', payload: { name: 'x' } })).statusCode,
    400
  );
  assert.equal(
    (await app.inject({ method: 'PATCH', url: `/api/sources/${sid1}`, payload: { interval_minutes: 'abc' } })).statusCode,
    400
  );
});

test('GAP-3 & GAP-7: MCP 与 workbench_fallback.py 规则对齐（快手合并/定时校验/内联#标签/字符串tags）', async () => {
  const workbenchCalls = [];
  const mockWb = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    const urlObj = new URL(req.url, 'http://127.0.0.1');
    workbenchCalls.push({ pathname: urlObj.pathname, body });

    if (urlObj.pathname === '/api/sau/accounts') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          code: 200,
          msg: null,
          data: [
            [1, 1, 'xhs.json', '小红书号', 1],
            [4, 4, 'ks.json', '快手号', 1],
          ],
        })
      );
      return;
    }
    if (urlObj.pathname === '/api/sau/import-local-file') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 200, data: { filepath: 'u_test.mp4' } }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 404 }));
  });
  await new Promise((resolve) => mockWb.listen(0, '127.0.0.1', resolve));
  const wbUrl = `http://127.0.0.1:${mockWb.address().port}`;

  const videoFile = path.join(tmpDir, 'parity.mp4');
  fs.writeFileSync(videoFile, Buffer.from('mp4'));

  const child = spawn(process.execPath, [path.join(PROJECT_ROOT, 'mcp', 'video-publisher-mcp.mjs')], {
    env: { ...process.env, WORKBENCH_BASE_URL: wbUrl },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  const rlOut = readline.createInterface({ input: child.stdout });
  rlOut.on('line', (line) => {
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  });
  let seq = 1;
  const rpc = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = seq++;
      const timer = setTimeout(() => reject(new Error(`RPC timeout ${method}`)), 10000);
      pending.set(id, {
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  try {
    await rpc('initialize', { protocolVersion: '2025-06-18' });

    // 1. 快手 prepare_publish_copy 合并与 workbench_fallback.py 对齐
    const mcpPrepKs = await rpc('tools/call', {
      name: 'prepare_publish_copy',
      arguments: {
        rawCopy: '这是快手主标题\n这是话题前简介正文\n#农资 #科普',
        platforms: [4],
      },
    });
    const mcpKs = mcpPrepKs.result.structuredContent.platforms['4'];
    assert.equal(mcpKs.description, '这是快手主标题\n这是话题前简介正文');

    if (fs.existsSync(PYTHON_EXE) && fs.existsSync(FALLBACK_SCRIPT)) {
      const fbPrep = spawnSync(
        PYTHON_EXE,
        [
          FALLBACK_SCRIPT,
          'prepare-copy',
          '--raw-copy',
          '这是快手主标题\n这是话题前简介正文\n#农资 #科普',
          '--platforms',
          '4',
        ],
        { encoding: 'utf8' }
      );
      assert.equal(fbPrep.status, 0, fbPrep.stderr);
      const fbKs = JSON.parse(fbPrep.stdout).platforms['4'];
      assert.equal(mcpKs.title, fbKs.title);
      assert.equal(mcpKs.description, fbKs.description);
      assert.deepEqual(mcpKs.tags, fbKs.tags);
    }

    // 2. rawCopy 与显式 title/description 共存时，剥离内联 #标签并合并进 tags
    const inlineTagsRes = await rpc('tools/call', {
      name: 'prepare_publish_copy',
      arguments: {
        rawCopy: '原始文本第一行\n原始正文内容',
        title: '显式标题 #隐藏标签',
        description: '显式简介 #简介标签',
        platforms: [3],
      },
    });
    const dyEntry = inlineTagsRes.result.structuredContent.platforms['3'];
    assert.equal(dyEntry.title, '显式标题');
    assert.equal(dyEntry.description, '显式简介');
    assert.deepEqual(dyEntry.tags, ['隐藏标签', '简介标签']);

    // 3. publish_video_to_platforms (dryRun) 快手合并 + 字符串 copies[p].tags
    const dryPublishRes = await rpc('tools/call', {
      name: 'publish_video_to_platforms',
      arguments: {
        filePath: videoFile,
        platforms: [1, 4],
        title: '全局标题',
        description: '全局简介',
        tags: ['默认标签'],
        copies: {
          '1': { title: '小红书标题', tags: '自定义A, 自定义B' },
          '4': { title: '快手标题A', description: '快手话题前简介B' },
        },
        dryRun: true,
      },
    });
    const dryByType = Object.fromEntries(
      dryPublishRes.result.structuredContent.results.map((r) => [r.type, r.plannedPayload])
    );
    assert.deepEqual(dryByType[1].tags, ['自定义A', '自定义B']);
    assert.equal(dryByType[4].description, '快手标题A\n快手话题前简介B');

    // 4. enableTimer 前置校验：非法定时参数在 dryRun 与 live(import之前) 均被拦截
    workbenchCalls.length = 0;
    const badTimerDry = await rpc('tools/call', {
      name: 'publish_video_to_platforms',
      arguments: {
        filePath: videoFile,
        platforms: [4],
        title: '定时非法测试',
        enableTimer: true,
        videosPerDay: 5,
        dailyTimes: ['10:00'],
        startDays: -2,
        dryRun: true,
      },
    });
    assert.equal(badTimerDry.result.isError, true);
    assert.match(badTimerDry.result.content[0].text, /videosPerDay/);

    const badTimerLive = await rpc('tools/call', {
      name: 'publish_video_to_platforms',
      arguments: {
        filePath: videoFile,
        platforms: [4],
        title: '定时非法live测试',
        enableTimer: true,
        videosPerDay: 0,
        dailyTimes: ['bad-time'],
        startDays: 0,
        confirmed: true,
      },
    });
    assert.equal(badTimerLive.result.isError, true);
    assert.equal(workbenchCalls.some((c) => c.pathname === '/api/sau/import-local-file'), false);

    // 5. NEW-GAP-3: 非法 accountIds（如 ["abc"]、[]、[0]、[1.5]、[null]）必须返回 isError，绝不静默退化为全量有效账号
    for (const badAccountIds of [['abc'], [], [0], [-1], [1.5], [null], [true]]) {
      const badAccRes = await rpc('tools/call', {
        name: 'publish_video_to_platforms',
        arguments: {
          filePath: videoFile,
          platforms: [4],
          title: '账号校验测试',
          accountIds: badAccountIds,
          dryRun: true,
        },
      });
      assert.equal(
        badAccRes.result.isError,
        true,
        `Expected isError=true for accountIds=${JSON.stringify(badAccountIds)}`
      );
    }

    // 合法 accountIds 精准命中对应账号
    const okAccRes = await rpc('tools/call', {
      name: 'publish_video_to_platforms',
      arguments: {
        filePath: videoFile,
        platforms: [4],
        title: '指定账号测试',
        accountIds: [4],
        dryRun: true,
      },
    });
    assert.notEqual(okAccRes.result.isError, true);
    assert.deepEqual(okAccRes.result.structuredContent.results[0].accountIds, [4]);
  } finally {
    child.stdin.end();
    child.kill();
    rlOut.close();
    await new Promise((resolve) => mockWb.close(resolve));
  }
});

test('NEW-GAP-1 & NOTE-1: PublishPage 前端定时校验与 CreatorsPage activeFilterRef 防过期闭包', () => {
  const publishTsx = fs.readFileSync(path.join(PROJECT_ROOT, 'frontend', 'src', 'pages', 'PublishPage.tsx'), 'utf8');
  assert.match(publishTsx, /每天发布条数（\$\{videosPerDay\}）不能大于每天时间点数量/);
  assert.match(publishTsx, /定时时间点格式错误/);
  assert.match(publishTsx, /最早定时发布时间必须晚于当前时间至少 2 小时/);

  const creatorsTsx = fs.readFileSync(path.join(PROJECT_ROOT, 'frontend', 'src', 'pages', 'CreatorsPage.tsx'), 'utf8');
  assert.match(creatorsTsx, /activeFilterRef\s*=\s*useRef\(/);
  assert.match(creatorsTsx, /activeFilterRef\.current/);
});

test('NEW-GAP-2: 外键存在性校验、compare-remix/recommend 参数校验与 comments/crawl 同步拦截', async () => {
  // 1. POST /api/radar/board 外键校验（非正整数 -> 400；不存在外键 -> 404；绝不触发 SQLite 500）
  const boardCases = [
    [{ title: 'FK1', source_content_id: 999999 }, 404],
    [{ title: 'FK2', source_content_id: 'abc' }, 400],
    [{ title: 'FK3', account_id: 999999 }, 404],
    [{ title: 'FK4', account_id: 'abc' }, 400],
    [{ title: 'FK5', recommendation_id: 999999 }, 404],
    [{ title: 'FK6', cluster_id: 999999 }, 404],
  ];
  for (const [payload, expectedStatus] of boardCases) {
    const res = await app.inject({ method: 'POST', url: '/api/radar/board', payload });
    assert.equal(res.statusCode, expectedStatus, `Expected ${expectedStatus} for ${JSON.stringify(payload)}, got ${res.statusCode}`);
  }

  // 2. POST/PATCH /api/sources category_id 校验（无效 -> 400；不存在分类 -> 404；null 可清空）
  const postSrcBad = await app.inject({
    method: 'POST',
    url: '/api/sources',
    payload: { url: 'https://example.com/feed.xml', category_id: 'abc' },
  });
  assert.equal(postSrcBad.statusCode, 400);

  const postSrcMissingCat = await app.inject({
    method: 'POST',
    url: '/api/sources',
    payload: { url: 'https://example.com/feed.xml', category_id: 999999 },
  });
  assert.equal(postSrcMissingCat.statusCode, 404);

  const patchSrcBad = await app.inject({
    method: 'PATCH',
    url: `/api/sources/${sid1}`,
    payload: { category_id: 'abc' },
  });
  assert.equal(patchSrcBad.statusCode, 400);

  const patchSrcMissing = await app.inject({
    method: 'PATCH',
    url: `/api/sources/${sid1}`,
    payload: { category_id: 999999 },
  });
  assert.equal(patchSrcMissing.statusCode, 404);

  const patchSrcNull = await app.inject({
    method: 'PATCH',
    url: `/api/sources/${sid1}`,
    payload: { category_id: null },
  });
  assert.equal(patchSrcNull.statusCode, 200);
  assert.equal(patchSrcNull.json().category_id, null);

  // 3. POST /api/radar/creators/compare-remix 参数校验
  for (const badBody of [
    { creatorId: 'abc' },
    { creatorId: 0 },
    { contentIds: ['abc'] },
    { contentIds: [] },
    { contentIds: '1,2' },
  ]) {
    const cmpRes = await app.inject({
      method: 'POST',
      url: '/api/radar/creators/compare-remix',
      payload: badBody,
    });
    assert.equal(cmpRes.statusCode, 400, `Expected 400 for compare-remix ${JSON.stringify(badBody)}, got ${cmpRes.statusCode}`);
  }

  // 4. POST /api/radar/intel/:id/recommend accountId 校验
  for (const badAcc of ['abc', 0, -1, true]) {
    const recRes = await app.inject({
      method: 'POST',
      url: '/api/radar/intel/1/recommend',
      payload: { accountId: badAcc },
    });
    assert.equal(recRes.statusCode, 400, `Expected 400 for recommend accountId=${JSON.stringify(badAcc)}, got ${recRes.statusCode}`);
  }

  // 5. POST /api/comments/crawl 同步校验 platform / mode / maxComments / input
  const jobsFile = path.join(PROJECT_ROOT, 'data', 'comment_crawl_jobs.json');
  const beforeJobsRaw = fs.existsSync(jobsFile) ? fs.readFileSync(jobsFile, 'utf8') : null;
  for (const badCrawl of [
    { platform: 'tiktok', mode: 'detail', input: 'https://example.com' },
    { platform: 'douyin', mode: 'invalid_mode', input: 'https://example.com' },
    { platform: 'douyin', mode: 'detail', input: 'https://example.com', maxComments: 'abc' },
    { platform: 'douyin', mode: 'detail', input: 'https://example.com', maxComments: 0 },
    { platform: 'douyin', mode: 'detail', input: '   ' },
  ]) {
    const crawlRes = await app.inject({
      method: 'POST',
      url: '/api/comments/crawl',
      payload: badCrawl,
    });
    assert.equal(crawlRes.statusCode, 400, `Expected 400 for crawl ${JSON.stringify(badCrawl)}, got ${crawlRes.statusCode}`);
  }
  const afterJobsRaw = fs.existsSync(jobsFile) ? fs.readFileSync(jobsFile, 'utf8') : null;
  assert.equal(afterJobsRaw, beforeJobsRaw);
});

test.after(async () => {
  await app.close();
  await new Promise((resolve) => mockSauServer.close(resolve));
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
