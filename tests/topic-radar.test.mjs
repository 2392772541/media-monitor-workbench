import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 隔离测试数据库，避免污染正式工作台数据
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmw-radar-test-'));
process.env.MMW_DB_PATH = path.join(tmpDir, 'radar-test.db');

const { getDb, closeDb, upsertContentWithMetrics, updateSourceAuthorProfile } = await import('../dist/db/database.js');
const { recognizeSourceUrl } = await import('../dist/adapters/urlRecognizer.js');
const { computeEngagementScore, recomputeSourceBreakout } = await import('../dist/services/breakoutService.js');
const { titleSimilarity, findDuplicateTopics } = await import('../dist/services/topicBoardService.js');

test('URL 识别正确支持 B站空间与视频链接以及抖音带中文分享口令', () => {
  const space = recognizeSourceUrl('https://space.bilibili.com/946974');
  assert.equal(space.platform, 'bilibili');
  assert.equal(space.sourceType, 'creator');

  const bv = recognizeSourceUrl('https://www.bilibili.com/video/BV1xx411c7mD');
  assert.equal(bv.platform, 'bilibili');

  const dyShare = recognizeSourceUrl('长按复制此条消息，打开抖音搜索，查看TA的更多作品。 https://v.douyin.com/kyLaUI9qlg4/');
  assert.equal(dyShare.valid, true);
  assert.equal(dyShare.platform, 'douyin');
  assert.equal(dyShare.sourceType, 'creator');
  assert.equal(dyShare.normalizedUrl, 'https://v.douyin.com/kyLaUI9qlg4/');
});

test('潜力爆款基线引擎：样本不足时不虚构倍数，满 3 条后准确识别异常爆款', () => {
  const db = getDb();
  const now = new Date().toISOString();
  const src = db
    .prepare(
      "INSERT INTO sources (name, platform, url, source_type, created_at, updated_at) VALUES ('测试B站UP', 'bilibili', 'https://space.bilibili.com/10001', 'creator', ?, ?)"
    )
    .run(now, now);
  const sourceId = Number(src.lastInsertRowid);
  updateSourceAuthorProfile(sourceId, { followerCount: 15000, bio: '测试博主' });

  // 仅 2 条样本时，不得编造 breakout_ratio
  upsertContentWithMetrics({
    sourceId,
    platform: 'bilibili',
    platformItemId: 'BV_A',
    url: 'https://www.bilibili.com/video/BV_A',
    title: '常规视频 A',
    metrics: { views: 10000, likes: 300, comments: 20 },
  });
  upsertContentWithMetrics({
    sourceId,
    platform: 'bilibili',
    platformItemId: 'BV_B',
    url: 'https://www.bilibili.com/video/BV_B',
    title: '常规视频 B',
    metrics: { views: 12000, likes: 350, comments: 25 },
  });

  recomputeSourceBreakout(sourceId);
  const lowSample = db.prepare("SELECT breakout_ratio, breakout_reason FROM contents WHERE platform_item_id = 'BV_A'").get();
  assert.equal(lowSample.breakout_ratio, null);
  assert.match(String(lowSample.breakout_reason), /样本仅 2 条/);

  // 补齐第 3 条常规 + 第 4 条 4 倍异常爆款
  upsertContentWithMetrics({
    sourceId,
    platform: 'bilibili',
    platformItemId: 'BV_C',
    url: 'https://www.bilibili.com/video/BV_C',
    title: '常规视频 C',
    metrics: { views: 11000, likes: 320, comments: 22 },
  });
  upsertContentWithMetrics({
    sourceId,
    platform: 'bilibili',
    platformItemId: 'BV_BOOM',
    url: 'https://www.bilibili.com/video/BV_BOOM',
    title: '低粉异常爆款 D',
    metrics: { views: 85000, likes: 4200, comments: 380, favorites: 1900 },
  });

  recomputeSourceBreakout(sourceId);
  const boom = db.prepare("SELECT breakout_ratio, breakout_score, breakout_reason FROM contents WHERE platform_item_id = 'BV_BOOM'").get();
  assert.ok(boom.breakout_ratio >= 5, `预期爆款倍数 >= 5，实际 ${boom.breakout_ratio}`);
  assert.ok(boom.breakout_score >= 70, `预期爆款分 >= 70，实际 ${boom.breakout_score}`);
  assert.match(String(boom.breakout_reason), /强异常爆款/);

  // 全 null 指标返回 null（严禁当 0 处理）
  assert.equal(computeEngagementScore({ views: null, likes: null }), null);
});

test('个人选题库历史查重准确捕获相似选题', () => {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO topic_board (title, core_angle, status, priority, created_at, updated_at) VALUES (?, '', 'published', 'high', ?, ?)"
  ).run('用 AI Agent 自动化整理每日行业热点的完整教程', now, now);

  assert.ok(titleSimilarity('用 AI Agent 自动整理行业热点实战教程', '用 AI Agent 自动化整理每日行业热点的完整教程') >= 45);
  const hits = findDuplicateTopics('用 AI Agent 自动整理每日热点完整实操教程');
  assert.ok(hits.length >= 1, '应命中历史相似选题');
  assert.equal(hits[0].status, 'published');
});

test.after(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
