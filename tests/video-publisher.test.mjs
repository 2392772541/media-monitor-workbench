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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmw-pub-test-'));
process.env.MMW_DB_PATH = path.join(tmpDir, 'pub-test.db');

// 构造隔离 Mock SAU 服务，记录请求而不触碰真实 5409 或公网账号
const sauRequests = [];
const mockSauServer = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks).toString('utf8');
  let parsedBody = null;
  try {
    parsedBody = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    parsedBody = rawBody;
  }
  sauRequests.push({ method: req.method, url: req.url, body: parsedBody });

  if (req.url === '/getAccounts') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 200, msg: null, data: [] }));
    return;
  }
  if (req.url === '/importLocalFile' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        code: 200,
        msg: 'import success',
        data: {
          id: 77,
          filename: parsedBody?.filename || 'demo.mp4',
          filepath: `uuid-1_${parsedBody?.filename || 'demo.mp4'}`,
          filesize: 1.25,
        },
      })
    );
    return;
  }
  if (req.url === '/postVideo' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 200, msg: '发布任务已提交', data: null }));
    return;
  }
  if (req.url === '/uploadSave' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 200, msg: 'File uploaded and saved successfully', data: { filename: 'web.mp4', filepath: 'u_web.mp4' } }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ code: 404, msg: 'not found', data: null }));
});

await new Promise((resolve) => mockSauServer.listen(0, '127.0.0.1', resolve));
const mockSauAddress = mockSauServer.address();
process.env.MMW_SAU_PORT = String(mockSauAddress.port);

const { closeDb } = await import('../dist/db/database.js');
const { registerRoutes } = await import('../dist/api/routes.js');

const app = Fastify({ logger: false });
registerRoutes(app, async () => {});

test('POST /api/sau/import-local-file 校验参数并转发至 SAU /importLocalFile', async () => {
  sauRequests.length = 0;

  const badRes = await app.inject({
    method: 'POST',
    url: '/api/sau/import-local-file',
    payload: { filePath: '   ' },
  });
  assert.equal(badRes.statusCode, 400);
  assert.equal(sauRequests.filter((r) => r.url === '/importLocalFile').length, 0);

  const okRes = await app.inject({
    method: 'POST',
    url: '/api/sau/import-local-file',
    payload: { filePath: 'C:\\videos\\clip.mp4', filename: 'clip_alias.mp4' },
  });
  assert.equal(okRes.statusCode, 200);
  const payload = okRes.json();
  assert.equal(payload.code, 200);
  assert.equal(payload.data.filepath, 'uuid-1_clip_alias.mp4');

  const sauCall = sauRequests.find((r) => r.url === '/importLocalFile');
  assert.ok(sauCall);
  assert.equal(sauCall.body.filePath, 'C:\\videos\\clip.mp4');
  assert.equal(sauCall.body.filename, 'clip_alias.mp4');
});

test('POST /api/sau/post-video 完整透传 description 与 tags，且保留 /api/sau/upload 表单上传', async () => {
  sauRequests.length = 0;

  const postRes = await app.inject({
    method: 'POST',
    url: '/api/sau/post-video',
    payload: {
      type: 2,
      title: '测试标题',
      description: '话题前的一小段补充描述',
      tags: ['标签一', '标签二'],
      fileList: ['uuid_demo.mp4'],
      accountList: ['cookie_acc.json'],
      isDraft: true,
    },
  });
  assert.equal(postRes.statusCode, 200);
  const sauPost = sauRequests.find((r) => r.url === '/postVideo');
  assert.ok(sauPost);
  assert.equal(sauPost.body.description, '话题前的一小段补充描述');
  assert.deepEqual(sauPost.body.tags, ['标签一', '标签二']);
  assert.equal(sauPost.body.isDraft, true);

  const uploadRes = await app.inject({
    method: 'POST',
    url: '/api/sau/upload',
    headers: { 'content-type': 'multipart/form-data; boundary=----mmwtest' },
    payload: '------mmwtest--\r\n',
  });
  assert.equal(uploadRes.statusCode, 200);
  assert.ok(sauRequests.some((r) => r.url === '/uploadSave'));
});

test('mcp/video-publisher-mcp.mjs stdio JSON-RPC 2.0 握手与全部 5 个工具端到端验证', async () => {
  const workbenchCalls = [];
  let aiShouldFail = true;

  // 构造 Mock 18910 工作台 HTTP 服务
  const mockWorkbench = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try {
      body = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      body = rawBody;
    }
    const urlObj = new URL(req.url, 'http://127.0.0.1');
    workbenchCalls.push({ method: req.method, pathname: urlObj.pathname, search: urlObj.search, body });

    if (urlObj.pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, port: 18910 }));
      return;
    }
    if (urlObj.pathname === '/api/sau/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ installed: true, running: true, port: 5409 }));
      return;
    }
    if (urlObj.pathname === '/api/sau/accounts' || urlObj.pathname === '/api/sau/accounts/validate') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          code: 200,
          msg: null,
          data: [
            [1, 1, 'secret_xhs_cookie_path.json', '小红书号A', 1],
            [2, 2, 'secret_tencent_cookie_path.json', '视频号B', 1],
            [3, 3, 'secret_douyin_cookie_path.json', '抖音号C', 1],
            [4, 4, 'secret_ks_cookie_path.json', '快手号D', 0],
          ],
        })
      );
      return;
    }
    if (urlObj.pathname === '/api/publish/ai-generate') {
      if (aiShouldFail) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, message: '未配置 AI Key' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          byPlatform: {
            3: { title: 'AI抖音标题', description: 'AI抖音描述', tags: ['t1', 't2', 't3', 't4', 't5', 't6'] },
          },
        })
      );
      return;
    }
    if (urlObj.pathname === '/api/sau/import-local-file') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          code: 200,
          msg: 'import success',
          data: { id: 88, filename: 'sample.mp4', filepath: 'uuid-88_sample.mp4', filesize: 0.5 },
        })
      );
      return;
    }
    if (urlObj.pathname === '/api/sau/post-video') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 200, msg: '发布任务已提交', data: null }));
      return;
    }
    if (urlObj.pathname === '/api/sau/publish-history') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          code: 200,
          msg: 'success',
          data: [
            {
              id: 10,
              platform_type: 2,
              platform_name: '视频号',
              title: '历史标题',
              file_list: ['uuid_a.mp4'],
              account_list: ['secret_tencent_cookie_path.json'],
              tags: ['农业'],
              is_draft: 1,
              status: 'success',
            },
          ],
        })
      );
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 404, msg: 'unknown' }));
  });

  await new Promise((resolve) => mockWorkbench.listen(0, '127.0.0.1', resolve));
  const wbPort = mockWorkbench.address().port;

  const sampleVideoPath = path.join(tmpDir, 'sample.mp4');
  fs.writeFileSync(sampleVideoPath, Buffer.from('fake-mp4-bytes'));

  const mcpPath = path.join(PROJECT_ROOT, 'mcp', 'video-publisher-mcp.mjs');
  const child = spawn(process.execPath, [mcpPath], {
    env: { ...process.env, WORKBENCH_BASE_URL: `http://127.0.0.1:${wbPort}` },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const stderrLines = [];
  const rlErr = readline.createInterface({ input: child.stderr });
  rlErr.on('line', (line) => stderrLines.push(line));

  const pending = new Map();
  const nullIdFrames = [];
  const nullIdWaiters = [];
  const rlOut = readline.createInterface({ input: child.stdout });
  rlOut.on('line', (line) => {
    const msg = JSON.parse(line);
    if (msg.id === null) {
      if (nullIdWaiters.length > 0) {
        const waiter = nullIdWaiters.shift();
        waiter(msg);
      } else {
        nullIdFrames.push(msg);
      }
      return;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  });

  const nextNullIdFrame = () =>
    new Promise((resolve, reject) => {
      if (nullIdFrames.length > 0) {
        resolve(nullIdFrames.shift());
        return;
      }
      const timer = setTimeout(() => {
        const idx = nullIdWaiters.indexOf(onFrame);
        if (idx >= 0) nullIdWaiters.splice(idx, 1);
        reject(new Error('RPC timeout waiting for id=null error frame'));
      }, 10000);
      const onFrame = (msg) => {
        clearTimeout(timer);
        resolve(msg);
      };
      nullIdWaiters.push(onFrame);
    });

  let nextId = 1;
  const rpc = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`RPC timeout for ${method}`));
      }, 10000);
      pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  try {
    // 1. initialize + notifications/initialized + ping + unknown method
    const initRes = await rpc('initialize', { protocolVersion: '2025-06-18' });
    assert.equal(initRes.result.protocolVersion, '2025-06-18');
    assert.equal(initRes.result.serverInfo.name, 'video_publisher');

    // 发送 notification 不应有回包，紧接着 ping 应直接对应 ping id
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const pingRes = await rpc('ping');
    assert.deepEqual(pingRes.result, {});

    const unknownRes = await rpc('unknown/method');
    assert.equal(unknownRes.error.code, -32601);

    // 1.5 JSON-RPC 2.0 错误帧：语法错误返回 -32700，非对象返回 -32600
    child.stdin.write('{bad json\n');
    const parseErrRes = await nextNullIdFrame();
    assert.equal(parseErrRes.id, null);
    assert.equal(parseErrRes.error.code, -32700);

    child.stdin.write('[1, 2]\n');
    const invalidReqRes = await nextNullIdFrame();
    assert.equal(invalidReqRes.id, null);
    assert.equal(invalidReqRes.error.code, -32600);

    // 2. tools/list 5 tools 及关键参数 schema 校验
    const listToolsRes = await rpc('tools/list');
    const toolNames = listToolsRes.result.tools.map((t) => t.name);
    assert.deepEqual(toolNames, [
      'check_workbench_status',
      'list_publish_accounts',
      'prepare_publish_copy',
      'publish_video_to_platforms',
      'get_publish_history',
    ]);
    const prepSchema = listToolsRes.result.tools.find((t) => t.name === 'prepare_publish_copy').inputSchema;
    assert.equal(prepSchema.required.includes('rawCopy'), false);
    assert.ok(prepSchema.properties.title);
    assert.ok(prepSchema.properties.description);
    assert.ok(prepSchema.properties.script);
    const pubSchema = listToolsRes.result.tools.find((t) => t.name === 'publish_video_to_platforms').inputSchema;
    assert.equal(pubSchema.properties.confirmed?.type, 'boolean');

    // 3. check_workbench_status
    const statusRes = await rpc('tools/call', { name: 'check_workbench_status', arguments: {} });
    assert.equal(statusRes.result.structuredContent.workbenchOnline, true);
    assert.equal(statusRes.result.structuredContent.sauStatus.port, 5409);

    // 4. list_publish_accounts（校验 Cookie 路径脱敏）
    const accRes = await rpc('tools/call', {
      name: 'list_publish_accounts',
      arguments: { validate: true },
    });
    const accText = accRes.result.content[0].text;
    assert.ok(!accText.includes('secret_'), '不能泄露任何 Cookie 文件路径');
    assert.equal(accRes.result.structuredContent.count, 4);
    assert.equal(accRes.result.structuredContent.accounts[0].platformName, '小红书');
    assert.equal(accRes.result.structuredContent.accounts[3].valid, false);
    assert.equal('filePath' in accRes.result.structuredContent.accounts[0], false);

    // 5. prepare_publish_copy（AI 失败回退 + 各平台字数与标签上限校验）
    const copyRes = await rpc('tools/call', {
      name: 'prepare_publish_copy',
      arguments: {
        rawCopy: '这是一条非常非常非常长到一定会超过小红书二十字和抖音三十字上限的测试主标题，看看会自动怎么截断呢\n这是话题前的补充说明文字，方便观众理解视频背景。\n#标签1 #标签2 #标签3 #标签4 #标签5 #标签6 #标签7',
        useAi: true,
      },
    });
    const copyData = copyRes.result.structuredContent;
    assert.equal(copyData.mode, 'rule');
    assert.ok(copyData.aiFallbackReason);
    assert.ok(copyData.platforms['1'].title.length <= 20);
    assert.ok(copyData.platforms['1'].tags.length <= 6);
    assert.ok(copyData.platforms['3'].title.length <= 30);
    assert.ok(copyData.platforms['3'].tags.length <= 5);
    assert.ok(copyData.platforms['2'].shortTitle.length >= 6 && copyData.platforms['2'].shortTitle.length <= 16);
    assert.ok(copyData.platforms['2'].tags.length <= 5);
    assert.ok(copyData.platforms['4'].tags.length <= 3);
    assert.ok(copyData.platforms['1'].warnings.length > 0);
    assert.ok(copyData.platforms['4'].warnings.length > 0);

    // 5.5 prepare_publish_copy 支持无 rawCopy 的 { title, description, tags }，并修复空白 tags 覆盖与短标题前缀重复
    const structuredCopyRes = await rpc('tools/call', {
      name: 'prepare_publish_copy',
      arguments: {
        title: '农资实操小技巧',
        description: '话题前的一段通俗简介',
        tags: ['#玉米', '水肥'],
        platforms: [1, 2, 3, 4],
      },
    });
    assert.equal(structuredCopyRes.result.isError ?? false, false);
    const structuredCopy = structuredCopyRes.result.structuredContent;
    assert.equal(structuredCopy.platforms['3'].title, '农资实操小技巧');
    assert.equal(structuredCopy.platforms['3'].description, '话题前的一段通俗简介');
    assert.deepEqual(structuredCopy.platforms['3'].tags, ['玉米', '水肥']);
    assert.ok(structuredCopy.platforms['2'].shortTitle.length >= 6);

    const emptyCopyRes = await rpc('tools/call', {
      name: 'prepare_publish_copy',
      arguments: { tags: ['玉米'] },
    });
    assert.equal(emptyCopyRes.result.isError, true);

    const blankTagsRes = await rpc('tools/call', {
      name: 'prepare_publish_copy',
      arguments: {
        rawCopy: '正文标题\n正文内容 #自动标签',
        tags: [' ', '# '],
        platforms: [3],
      },
    });
    assert.deepEqual(blankTagsRes.result.structuredContent.platforms['3'].tags, ['自动标签']);

    const shortPrefixRes = await rpc('tools/call', {
      name: 'prepare_publish_copy',
      arguments: {
        rawCopy: 'Hi!!!\n短',
        titleHint: 'Hi!!!',
        platforms: [2],
      },
    });
    assert.equal(shortPrefixRes.result.structuredContent.platforms['2'].shortTitle.startsWith('HiHi'), false);

    // 6. publish_video_to_platforms: dryRun 不触发导入也不发布
    workbenchCalls.length = 0;
    const dryRes = await rpc('tools/call', {
      name: 'publish_video_to_platforms',
      arguments: {
        filePath: sampleVideoPath,
        platforms: [2, 3],
        title: 'DryRun 测试标题',
        description: 'DryRun 简介',
        tags: ['测试'],
        dryRun: true,
      },
    });
    assert.equal(dryRes.result.structuredContent.dryRun, true);
    assert.equal(dryRes.result.structuredContent.fileValidation.ok, true);
    assert.equal(workbenchCalls.some((c) => c.pathname === '/api/sau/import-local-file'), false);
    assert.equal(workbenchCalls.some((c) => c.pathname === '/api/sau/post-video'), false);
    assert.ok(!dryRes.result.content[0].text.includes('secret_'));

    // 6.5 publish_video_to_platforms: 未传 confirmed: true 或 confirmed: false 时（非 dryRun）必须拦截，0 次导入与发布调用
    workbenchCalls.length = 0;
    const unconfirmedRes = await rpc('tools/call', {
      name: 'publish_video_to_platforms',
      arguments: {
        filePath: sampleVideoPath,
        platforms: [3],
        title: '未确认不应发布',
        description: '简介',
        tags: ['测试'],
        dryRun: false,
      },
    });
    assert.equal(unconfirmedRes.result.isError, true);
    assert.equal(unconfirmedRes.result.structuredContent?.requiresConfirmation, true);
    assert.equal(JSON.parse(unconfirmedRes.result.content[0].text).requiresConfirmation, true);
    assert.equal(workbenchCalls.some((c) => c.pathname === '/api/sau/import-local-file'), false);
    assert.equal(workbenchCalls.some((c) => c.pathname === '/api/sau/post-video'), false);

    workbenchCalls.length = 0;
    const confirmedFalseRes = await rpc('tools/call', {
      name: 'publish_video_to_platforms',
      arguments: {
        filePath: sampleVideoPath,
        platforms: [3],
        title: 'confirmed=false 不应发布',
        confirmed: false,
      },
    });
    assert.equal(confirmedFalseRes.result.isError, true);
    assert.equal(confirmedFalseRes.result.structuredContent?.requiresConfirmation, true);
    assert.equal(workbenchCalls.some((c) => c.pathname === '/api/sau/import-local-file'), false);
    assert.equal(workbenchCalls.some((c) => c.pathname === '/api/sau/post-video'), false);

    // 7. publish_video_to_platforms: confirmed=true + isDraft=true 安全拦截非视频号平台（1/3/4），仅提交平台 2
    workbenchCalls.length = 0;
    const draftRes = await rpc('tools/call', {
      name: 'publish_video_to_platforms',
      arguments: {
        filePath: sampleVideoPath,
        platforms: [1, 2, 3, 4],
        title: '草稿安全测试',
        description: '视频号草稿简介',
        tags: ['干货'],
        isDraft: true,
        confirmed: true,
      },
    });
    const draftResults = draftRes.result.structuredContent.results;
    const byType = Object.fromEntries(draftResults.map((r) => [r.type, r]));
    assert.equal(byType[1].status, 'blocked_draft_unsupported');
    assert.equal(byType[3].status, 'blocked_draft_unsupported');
    assert.equal(byType[4].status, 'blocked_draft_unsupported');
    assert.equal(byType[2].status, 'submitted');
    assert.equal(byType[2].isDraft, true);
    assert.ok(!draftRes.result.content[0].text.includes('secret_'));

    const postCalls = workbenchCalls.filter((c) => c.pathname === '/api/sau/post-video');
    assert.equal(postCalls.length, 1);
    assert.equal(postCalls[0].body.type, 2);
    assert.equal(postCalls[0].body.isDraft, true);
    assert.equal(postCalls[0].body.description, '视频号草稿简介');
    assert.deepEqual(postCalls[0].body.fileList, ['uuid-88_sample.mp4']);

    // 7.5 publish_video_to_platforms: confirmed=true 且非草稿模式正常提交
    workbenchCalls.length = 0;
    const normalPubRes = await rpc('tools/call', {
      name: 'publish_video_to_platforms',
      arguments: {
        filePath: sampleVideoPath,
        platforms: [3],
        title: '确认后正常发布',
        description: '抖音简介',
        tags: ['农资'],
        confirmed: true,
      },
    });
    assert.equal(normalPubRes.result.isError ?? false, false);
    assert.equal(normalPubRes.result.structuredContent.results[0].status, 'submitted');
    assert.equal(workbenchCalls.filter((c) => c.pathname === '/api/sau/import-local-file').length, 1);
    assert.equal(workbenchCalls.filter((c) => c.pathname === '/api/sau/post-video').length, 1);

    // 8. get_publish_history（脱敏 account_list）
    const histRes = await rpc('tools/call', {
      name: 'get_publish_history',
      arguments: { limit: 999 },
    });
    assert.equal(histRes.result.structuredContent.limit, 200);
    assert.equal(histRes.result.structuredContent.records[0].accountCount, 1);
    assert.ok(!histRes.result.content[0].text.includes('secret_'));
    assert.equal(stderrLines.some((l) => l.includes('secret_')), false);
  } finally {
    child.stdin.end();
    child.kill();
    rlErr.close();
    rlOut.close();
    await new Promise((resolve) => mockWorkbench.close(resolve));
  }
});

test('C:\\Users\\win10\\.gemini\\antigravity\\mcp_config.json 已合法注册 video_publisher', () => {
  const cfgPath = 'C:\\Users\\win10\\.gemini\\antigravity\\mcp_config.json';
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const entry = cfg?.mcpServers?.video_publisher;
  assert.ok(entry, 'mcp_config.json 必须包含 video_publisher');
  assert.equal(entry.command, 'C:\\Users\\win10\\scoop\\apps\\nodejs\\current\\node.EXE');
  assert.deepEqual(entry.args, [path.join(PROJECT_ROOT, 'mcp', 'video-publisher-mcp.mjs')]);
  assert.equal(entry.env?.WORKBENCH_BASE_URL, 'http://127.0.0.1:18910');
});

test('sau-engine 新增 /importLocalFile、4 平台 description 透传、小红书多标签与抖音空标签防护隔离验证', () => {
  const venvPython = 'D:\\HeyGem\\social-auto-upload\\.venv\\Scripts\\python.exe';
  assert.ok(fs.existsSync(venvPython), 'Python venv 应存在');

  const pyScript = `
import asyncio
import gc
import json
import sqlite3
import tempfile
from pathlib import Path
from unittest.mock import patch
import sau_backend
from myUtils import postVideo
from uploader.tencent_uploader.main import TencentVideo
from uploader.xiaohongshu_uploader.main import XiaoHongShuVideo
from uploader.douyin_uploader.main import DouYinVideo

with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as td:
    tmp = Path(td)
    sau_backend.BASE_DIR = tmp
    sau_backend.ensure_runtime_ready()
    client = sau_backend.app.test_client()

    # 1. /importLocalFile 校验与正常导入（含非 dict JSON 与路径穿越拦截）
    assert client.post("/importLocalFile", json=[1, 2, 3]).status_code == 400
    assert client.post("/importLocalFile", json="not-an-object").status_code == 400
    assert client.post("/importLocalFile", json={"filePath": "relative.mp4"}).status_code == 400
    assert client.post("/importLocalFile", json={"filePath": str(tmp / "missing.mp4")}).status_code == 404
    bad_txt = tmp / "note.txt"
    bad_txt.write_text("hi", encoding="utf-8")
    assert client.post("/importLocalFile", json={"filePath": str(bad_txt)}).status_code == 400

    src_mp4 = tmp / "origin.mp4"
    src_mp4.write_bytes(b"video-bytes-123")
    assert client.post("/importLocalFile", json={"filePath": str(src_mp4), "filename": ".."}).status_code == 400
    assert client.post("/importLocalFile", json={"filePath": str(src_mp4), "filename": "../evil"}).status_code == 400
    assert client.post("/importLocalFile", json={"filePath": str(src_mp4), "filename": "sub\\\\evil"}).status_code == 400

    ok_resp = client.post("/importLocalFile", json={"filePath": f'"{src_mp4}"', "filename": "custom_clip"})
    assert ok_resp.status_code == 200
    ok_data = ok_resp.get_json()["data"]
    assert ok_data["id"] >= 1
    assert ok_data["filename"] == "custom_clip.mp4"
    assert ok_data["filepath"].endswith("_custom_clip.mp4")
    assert (tmp / "videoFile" / ok_data["filepath"]).is_file()

    ok_resp2 = client.post("/importLocalFile", json={"filePath": str(src_mp4), "filename": "already_ext.mp4"})
    assert ok_resp2.status_code == 200
    assert ok_resp2.get_json()["data"]["filename"] == "already_ext.mp4"

    # 1.5 postVideo.py 中 post_video_tencent / post_video_ks 透传 desc
    postVideo.BASE_DIR = tmp
    pv_captured = []
    class DummyPV:
        def __init__(self, *args, **kwargs): pv_captured.append((args, kwargs))
        async def main(self): return None
    with patch.object(postVideo, "TencentVideo", DummyPV), patch.object(postVideo, "KSVideo", DummyPV):
        postVideo.post_video_tencent("tt", ["a.mp4"], ["tag"], ["c.json"], desc="t_desc")
        postVideo.post_video_ks("kt", ["a.mp4"], ["tag"], ["c.json"], desc="k_desc")
    assert pv_captured[0][1]["desc"] == "t_desc"
    assert pv_captured[1][1]["desc"] == "k_desc"

    # 2. /postVideo 与 /postVideoBatch 透传 description 给 4 个平台
    calls = []
    def mk_stub(name):
        def _fn(*args, **kwargs):
            calls.append((name, args, kwargs))
        return _fn

    with patch.object(sau_backend, "post_video_xhs", side_effect=mk_stub("xhs")), \\
         patch.object(sau_backend, "post_video_tencent", side_effect=mk_stub("tencent")), \\
         patch.object(sau_backend, "post_video_DouYin", side_effect=mk_stub("douyin")), \\
         patch.object(sau_backend, "post_video_ks", side_effect=mk_stub("ks")):
        r2 = client.post("/postVideo", json={"type": 2, "title": "t2", "description": "d2", "fileList": ["a.mp4"], "accountList": ["c.json"]})
        r4 = client.post("/postVideo", json={"type": 4, "title": "t4", "description": "d4", "fileList": ["a.mp4"], "accountList": ["c.json"]})
        assert r2.status_code == 200 and r4.status_code == 200
        rb = client.post("/postVideoBatch", json=[
            {"type": 1, "title": "b1", "description": "bd1", "fileList": ["a.mp4"], "accountList": ["c.json"]},
            {"type": 2, "title": "b2", "description": "bd2", "fileList": ["a.mp4"], "accountList": ["c.json"]},
            {"type": 3, "title": "b3", "description": "bd3", "fileList": ["a.mp4"], "accountList": ["c.json"]},
            {"type": 4, "title": "b4", "description": "bd4", "fileList": ["a.mp4"], "accountList": ["c.json"]},
        ])
        assert rb.status_code == 200
        rb_bad = client.post("/postVideoBatch", json=[
            {"type": 99, "title": "bad", "fileList": ["a.mp4"], "accountList": ["c.json"]},
        ])
        assert rb_bad.status_code == 400
    assert calls[0][0] == "tencent" and calls[0][2]["desc"] == "d2"
    assert calls[1][0] == "ks" and calls[1][2]["desc"] == "d4"
    assert calls[2][0] == "xhs" and calls[2][2]["desc"] == "bd1"
    assert calls[3][0] == "tencent" and calls[3][2]["desc"] == "bd2"
    assert calls[4][0] == "douyin" and calls[4][2]["desc"] == "bd3"
    assert calls[5][0] == "ks" and calls[5][2]["desc"] == "bd4"

    # 校验未知平台 type=99 未写入 publish_records，且显式关闭 sqlite3 连接防止 Windows WinError 32
    db_conn = sqlite3.connect(tmp / "db" / "database.db")
    try:
        bad_rows = db_conn.execute("SELECT COUNT(1) FROM publish_records WHERE platform_type = 99").fetchone()[0]
        assert bad_rows == 0
    finally:
        db_conn.close()

    # 3. TencentVideo.add_title_tags 在话题前写入 desc
    class FakeKeyboard:
        def __init__(self): self.events = []
        async def type(self, text, delay=None): self.events.append(("type", text))
        async def press(self, key): self.events.append(("press", key))
    class FakeLocator:
        async def click(self): pass
        @property
        def first(self): return self
        async def wait_for(self, **kw): pass
    class FakeTencentPage:
        def __init__(self): self.keyboard = FakeKeyboard()
        def locator(self, sel): return FakeLocator()

    tv = TencentVideo("主标题", "a.mp4", [" #农业 ", "", "科普"], 0, "c.json", desc="补充简介")
    tp = FakeTencentPage()
    asyncio.run(tv.add_title_tags(tp))
    assert tp.keyboard.events == [
        ("type", "主标题"), ("press", "Enter"),
        ("type", "补充简介"), ("press", "Enter"),
        ("type", "#农业"), ("press", "Space"),
        ("type", "#科普"), ("press", "Space"),
    ]

    # 4. XiaoHongShuVideo.fill_tags 最多 6 个标签且话题建议超时不中断后续标签
    class XhsTopicItem:
        def __init__(self, fail_on):
            self.clicks = 0
            self.fail_on = fail_on
            self.calls = 0
        @property
        def first(self): return self
        async def wait_for(self, **kw):
            self.calls += 1
            if self.calls in self.fail_on:
                raise TimeoutError("no topic suggestion")
        async def click(self): self.clicks += 1

    class XhsPage:
        def __init__(self):
            self.keyboard = FakeKeyboard()
            self.topic_item = XhsTopicItem(fail_on={2})
            self.desc_loc = FakeLocator()
            self.container_loc = FakeLocator()
        def locator(self, sel):
            if sel == "#creator-editor-topic-container .item": return self.topic_item
            if sel == "#creator-editor-topic-container": return self.container_loc
            return self.desc_loc

    xv = XiaoHongShuVideo("标题", "a.mp4", ["t1", "#t2", "t1", "t3", "t4", "t5", "t6", "t7"], 0, "c.json", desc="简介")
    xp = XhsPage()
    asyncio.run(xv.fill_tags(xp))
    typed_tags = [v for k, v in xp.keyboard.events if k == "type"]
    assert typed_tags == ["#t1", "#t2", "#t3", "#t4", "#t5", "#t6"]
    assert ("press", "Space") in xp.keyboard.events
    assert xp.topic_item.clicks == 5

    # 5. DouYinVideo tags=None 防护与 fill_title_and_description 前导 # 清洗（防 ##农资）
    dv = DouYinVideo("抖音标题", "a.mp4", None, 0, "c.json", desc=None)
    assert dv.tags == []
    assert len(dv.tags or []) == 0

    class DyInputLocator(FakeLocator):
        def locator(self, sel): return self
        async def fill(self, text): pass
    class DyPage:
        def __init__(self):
            self.keyboard = FakeKeyboard()
            self._loc = DyInputLocator()
        def get_by_text(self, text, exact=False): return self._loc

    dy_page = DyPage()
    asyncio.run(dv.fill_title_and_description(dy_page, "抖音标题", "抖音简介", ["#农资", " ", "# ", " 玉米 "]))
    dy_typed_tags = [v for k, v in dy_page.keyboard.events if k == "type" and v.startswith(" #")]
    assert dy_typed_tags == [" #农资", " #玉米"]
    gc.collect()
print("PY_M3_OK")
`;

  const res = spawnSync(venvPython, ['-c', pyScript], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      PYTHONPATH: path.join(PROJECT_ROOT, 'sau-engine'),
    },
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, `Python 隔离验证失败:\nstdout=${res.stdout}\nstderr=${res.stderr}`);
  assert.ok(res.stdout.includes('PY_M3_OK'));
});

test.after(async () => {
  await app.close();
  await new Promise((resolve) => mockSauServer.close(resolve));
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
