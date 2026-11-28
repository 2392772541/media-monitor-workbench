import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmw-cg-test-'));
process.env.MMW_DB_PATH = path.join(tmpDir, 'cg-test.db');
// 测试环境指向不可达 AI 地址，验证离线规则兜底逻辑不依赖外部网络
process.env.AI_BASE_URL = 'http://127.0.0.1:1/v1';
process.env.AI_API_KEY = 'test-offline-key';

const sauCalls = [];
let mockRetryableOnce = false;

const mockSau = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  let body = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = raw;
  }
  sauCalls.push({ method: req.method, url: req.url, body });

  const json = (status, payload) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  if (req.url === '/getAccounts') {
    return json(200, { code: 200, msg: null, data: [[1, 3, 'dy.json', '主号', 1]] });
  }
  if (req.url === '/comments/capabilities') {
    return json(200, {
      code: 200,
      msg: 'success',
      data: [
        { platformType: 3, key: 'douyin', name: '抖音', supported: true, reserved: false, note: 'ok', accounts: [{ id: 1, accountName: '主号', valid: true }], hasAccount: true, hasValidAccount: true },
        { platformType: 4, key: 'kuaishou', name: '快手', supported: true, reserved: false, note: 'ok', accounts: [{ id: 2, accountName: '主号', valid: true }], hasAccount: true, hasValidAccount: true },
        { platformType: 1, key: 'xiaohongshu', name: '小红书', supported: false, reserved: true, note: 'reserved', accounts: [], hasAccount: false, hasValidAccount: false },
        { platformType: 2, key: 'tencent', name: '微信视频号', supported: false, reserved: true, note: 'reserved', accounts: [], hasAccount: false, hasValidAccount: false },
      ],
    });
  }
  if (req.url === '/postVideo' && req.method === 'POST') {
    return json(200, { code: 200, msg: '发布任务已提交', data: null });
  }
  if (req.url === '/comments/post' && req.method === 'POST') {
    if (mockRetryableOnce) {
      mockRetryableOnce = false;
      return json(400, { code: 400, msg: '审核中', data: { ok: false, retryable: true, message: '视频仍在审核' } });
    }
    return json(200, {
      code: 200,
      msg: 'ok',
      data: { ok: true, video_id: body.videoId || 'v_1001', posted_comment_id: `pc_${sauCalls.length}`, dry_run: Boolean(body.dryRun) },
    });
  }
  if (req.url === '/comments/sync' && req.method === 'POST') {
    if (body.type === 3) {
      return json(200, {
        code: 200,
        msg: 'ok',
        data: {
          ok: true,
          platform_type: 3,
          account_name: '主号',
          videos: [
            { video_id: 'v_1001', title: 'AI学得越晚越占便宜？其实藏着大陷阱', comment_count: 4, like_count: 10, play_count: 500, published_at: '2026-11-28T11:36:00Z' },
          ],
          comments: [
            { video_id: 'v_1001', video_title: 'AI学得越晚越占便宜？其实藏着大陷阱', comment_id: 'c_fan_1', parent_comment_id: '', author_uid: 'u1', author_name: '认真粉丝', text: '这些都不重要，重要的是你的数据安全', like_count: 2, created_at: '2026-11-28T12:00:00Z', is_author: false, has_author_reply: false },
            { video_id: 'v_1001', video_title: 'AI学得越晚越占便宜？其实藏着大陷阱', comment_id: 'c_spam_1', parent_comment_id: '', author_uid: 'u2', author_name: '广告号', text: '加微123456免费领资料日赚500', like_count: 0, created_at: '2026-11-28T12:01:00Z', is_author: false, has_author_reply: false },
            { video_id: 'v_1001', video_title: 'AI学得越晚越占便宜？其实藏着大陷阱', comment_id: 'c_self_1', parent_comment_id: '', author_uid: 'me', author_name: '野生变量', text: '作者自己发的暖场评论', like_count: 1, created_at: '2026-11-28T12:02:00Z', is_author: true, has_author_reply: false },
            { video_id: 'v_1001', video_title: 'AI学得越晚越占便宜？其实藏着大陷阱', comment_id: 'c_done_1', parent_comment_id: '', author_uid: 'u3', author_name: '老粉', text: '讲得挺透彻', like_count: 1, created_at: '2026-11-28T12:03:00Z', is_author: false, has_author_reply: true },
          ],
        },
      });
    }
    return json(200, { code: 200, msg: 'ok', data: { ok: true, platform_type: body.type, account_name: '主号', videos: [], comments: [] } });
  }
  if (req.url === '/comments/reply' && req.method === 'POST') {
    return json(200, { code: 200, msg: 'ok', data: { ok: true, comment_id: body.commentId, dry_run: Boolean(body.dryRun) } });
  }
  return json(404, { code: 404, msg: 'not found', data: null });
});

await new Promise((resolve) => mockSau.listen(0, '127.0.0.1', resolve));
process.env.MMW_SAU_PORT = String(mockSau.address().port);

const { closeDb, getDb } = await import('../dist/db/database.js');
const { registerRoutes } = await import('../dist/api/routes.js');
const {
  detectSpamComment,
  executeWarmupJobById,
  hookPostPublishWarmup,
  runCommentPatrol,
  updateCommentGuardSettings,
} = await import('../dist/services/commentGuardService.js');

const app = Fastify({ logger: false });
registerRoutes(app, async () => {});

test.after(async () => {
  await app.close();
  closeDb();
  mockSau.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('广告与无意义评论过滤准确区分真实粉丝留言', () => {
  const kws = ['加微', '日赚', '免费领'];
  assert.equal(detectSpamComment('加微领教程', kws).isSpam, true);
  assert.equal(detectSpamComment('🔥🔥🔥!!!', kws).isSpam, true);
  assert.equal(detectSpamComment('https://spam.example.com/a', kws).isSpam, true);
  assert.equal(detectSpamComment('这个思路很实在，数据确实关键', kws).isSpam, false);
});

test('配置读取、更新与总览接口正常且预留小红书/视频号', async () => {
  const patchRes = await app.inject({
    method: 'PATCH',
    url: '/api/comment-guard/settings',
    payload: {
      patrolIntervalMinutes: 15,
      warmupCount: 3,
      warmupSpacingMinSec: 0,
      warmupSpacingMaxSec: 0,
      replySpacingMinSec: 0,
      replySpacingMaxSec: 0,
    },
  });
  assert.equal(patchRes.statusCode, 200);
  assert.equal(patchRes.json().settings.patrolIntervalMinutes, 15);

  const ovRes = await app.inject({ method: 'GET', url: '/api/comment-guard/overview' });
  assert.equal(ovRes.statusCode, 200);
  const ov = ovRes.json();
  assert.equal(ov.capabilities.length, 4);
  assert.equal(ov.capabilities.find((c) => c.platformType === 1).reserved, true);
  assert.equal(ov.capabilities.find((c) => c.platformType === 2).reserved, true);
});

test('发布成功后自动排队暖场评论（去重、跳过草稿、审核期自动重试、发完不重发）', async () => {
  sauCalls.length = 0;
  // 草稿不入队
  const draftRes = await hookPostPublishWarmup({ type: 3, title: '草稿测试', isDraft: true });
  assert.equal(draftRes.queued, false);

  // 正常发布自动生成 3 条暖评入队
  const hooked = await hookPostPublishWarmup({
    type: 3,
    title: 'AI学得越晚越占便宜？其实藏着大陷阱',
    description: '工具层门槛下降，但边界体感更保值',
    tags: ['AI学习'],
  });
  assert.equal(hooked.queued, true);
  assert.ok(hooked.jobId > 0);

  // 10 分钟内同视频防重复入队
  const dup = await hookPostPublishWarmup({
    type: 3,
    title: 'AI学得越晚越占便宜？其实藏着大陷阱',
  });
  assert.equal(dup.queued, false);

  // 模拟平台刚发完仍在审核 -> 自动延后重试而不是直接判死
  mockRetryableOnce = true;
  const retryRes = await executeWarmupJobById(hooked.jobId, { skipSpacing: true });
  assert.equal(retryRes.status, 'queued');

  // 审核通过后正常逐条发出全部 3 条暖评
  const doneRes = await executeWarmupJobById(hooked.jobId, { skipSpacing: true });
  assert.equal(doneRes.ok, true);
  assert.equal(doneRes.status, 'done');
  assert.equal(doneRes.sentCount, 3);
  assert.equal(sauCalls.filter((c) => c.url === '/comments/post').length, 4); // 1 retryable + 3 sent

  // 再次执行同一任务幂等跳过，绝不重复发
  const again = await executeWarmupJobById(hooked.jobId, { skipSpacing: true });
  assert.equal(again.status, 'done');
  assert.equal(sauCalls.filter((c) => c.url === '/comments/post').length, 4);
});

test('定时巡检自动过滤广告/作者自评/已有回复，仅对真实未回粉丝自动回复且绝不重复', async () => {
  sauCalls.length = 0;
  updateCommentGuardSettings({ mode: 'auto', replySpacingMinSec: 0, replySpacingMaxSec: 0 });

  const patrol1 = await runCommentPatrol({ manual: true, platforms: [3, 4], skipSpacing: true });
  assert.equal(patrol1.ok, true);
  assert.equal(patrol1.syncedVideos, 1);
  assert.equal(patrol1.discoveredComments, 4);
  assert.equal(patrol1.spamSkippedCount, 1);
  assert.equal(patrol1.repliedCount, 1);

  const replyCalls = sauCalls.filter((c) => c.url === '/comments/reply');
  assert.equal(replyCalls.length, 1);
  assert.equal(replyCalls[0].body.commentId, 'c_fan_1');

  // 验证数据库各状态分类精准
  const db = getDb();
  const rows = db.prepare('SELECT platform_comment_id, reply_status FROM creator_video_comments').all();
  const map = Object.fromEntries(rows.map((r) => [r.platform_comment_id, r.reply_status]));
  assert.equal(map.c_fan_1, 'replied');
  assert.equal(map.c_spam_1, 'skipped_spam');
  assert.equal(map.c_self_1, 'skipped_author');
  assert.equal(map.c_done_1, 'skipped_already_replied');

  // 第二次巡检绝不重复回复 c_fan_1
  const patrol2 = await runCommentPatrol({ manual: true, platforms: [3], skipSpacing: true });
  assert.equal(patrol2.repliedCount, 0);
  assert.equal(sauCalls.filter((c) => c.url === '/comments/reply').length, 1);

  // 验证日志接口有记录
  const logsRes = await app.inject({ method: 'GET', url: '/api/comment-guard/logs' });
  assert.equal(logsRes.statusCode, 200);
  assert.ok(logsRes.json().items.length >= 2);
});
