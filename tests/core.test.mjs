import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmw-unit-'));
process.env.MMW_DB_PATH = path.join(tmpDir, 'unit.db');

const { getDb, closeDb, upsertContentWithMetrics, canonicalizeUrl, backupDatabase } = await import('../dist/db/database.js');
const { recognizeSourceUrl } = await import('../dist/adapters/urlRecognizer.js');
const { parseFeedContent, extractArticleFromHtml } = await import('../dist/adapters/webUtils.js');
const { getSafeProfileDir } = await import('../dist/config.js');

test('URL platform recognition handles all target platforms', () => {
  assert.equal(recognizeSourceUrl('https://www.douyin.com/user/MS4wLjAB').platform, 'douyin');
  assert.equal(recognizeSourceUrl('https://www.kuaishou.com/profile/3xabc').platform, 'kuaishou');
  assert.equal(recognizeSourceUrl('https://channels.weixin.qq.com/platform').platform, 'wechat-channels');
  assert.equal(recognizeSourceUrl('https://x.com/openai').platform, 'x');
  assert.equal(recognizeSourceUrl('https://www.youtube.com/@OpenAI').platform, 'youtube');
  assert.equal(recognizeSourceUrl('https://www.xiaohongshu.com/user/profile/12345').platform, 'website');
  assert.equal(recognizeSourceUrl('https://example.com/feed.xml').platform, 'rss');
  assert.equal(recognizeSourceUrl('example.com/blog').platform, 'website');
});

test('URL canonicalization strips tracking params and trailing slash', () => {
  const a = canonicalizeUrl('https://example.com/post/1/?utm_source=twitter&spm=123#top');
  const b = canonicalizeUrl('https://example.com/post/1');
  assert.equal(a, b);
});

test('Content deduplication and metrics snapshot history preservation', () => {
  const db = getDb();
  const now = new Date().toISOString();
  const sRes = db
    .prepare("INSERT INTO sources (name, platform, url, created_at, updated_at) VALUES ('Test', 'douyin', 'https://www.douyin.com/user/1', ?, ?)")
    .run(now, now);
  const sourceId = Number(sRes.lastInsertRowid);

  const first = upsertContentWithMetrics({
    sourceId,
    platform: 'douyin',
    platformItemId: 'vid_999',
    url: 'https://www.douyin.com/video/999?utm_source=x',
    title: '测试视频标题',
    body: '视频文案内容',
    metrics: { likes: 100, comments: 10 },
  });
  assert.equal(first.isNew, true);
  assert.equal(first.metricsUpdated, true);

  // Second upsert with same platformItemId and updated likes
  const second = upsertContentWithMetrics({
    sourceId,
    platform: 'douyin',
    platformItemId: 'vid_999',
    url: 'https://www.douyin.com/video/999',
    title: '测试视频标题',
    body: '视频文案内容',
    metrics: { likes: 500, comments: 30 },
  });
  assert.equal(second.isNew, false);
  assert.equal(second.contentId, first.contentId);
  assert.equal(second.metricsUpdated, true);

  // Third upsert with unchanged metrics
  const third = upsertContentWithMetrics({
    sourceId,
    platform: 'douyin',
    platformItemId: 'vid_999',
    url: 'https://www.douyin.com/video/999',
    title: '测试视频标题',
    metrics: { likes: 500, comments: 30 },
  });
  assert.equal(third.isNew, false);
  assert.equal(third.metricsUpdated, false);

  const count = db.prepare('SELECT COUNT(*) AS c FROM contents WHERE id = ?').get(first.contentId);
  assert.equal(count.c, 1);
  const snapshots = db.prepare('SELECT likes FROM content_metrics WHERE content_id = ? ORDER BY id ASC').all(first.contentId);
  assert.deepEqual(snapshots.map((r) => r.likes), [100, 500]);
});

test('RSS & HTML extraction works cleanly', () => {
  const rss = `<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0"><channel><title>科技周报</title>
      <item><title>AI 本地工作台发布</title><link>https://example.com/a1</link><description>正文摘要测试</description><pubDate>Mon, 10 Nov 2026 08:00:00 GMT</pubDate></item>
    </channel></rss>`;
  const parsed = parseFeedContent(rss, 'https://example.com/rss.xml');
  assert.equal(parsed.feedTitle, '科技周报');
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].title, 'AI 本地工作台发布');

  const html = `<html><head><title>文章标题</title><meta name="author" content="张三"/></head><body><article><h1>文章标题</h1><p>这是一段很长很清晰的中文技术文章正文，用于测试 Readability 提取质量。</p></article></body></html>`;
  const art = extractArticleFromHtml(html, 'https://example.com/p1');
  assert.equal(art.title, '文章标题');
  assert.ok(art.body.includes('中文技术文章正文'));
});

test('Profile directory safety and DB backup', () => {
  const dir = getSafeProfileDir('douyin');
  assert.ok(dir.includes('browser-profiles'));
  assert.ok(!dir.toLowerCase().includes('google\\chrome\\user data'));
  const bk = backupDatabase();
  assert.ok(fs.existsSync(bk.backupPath));
  assert.ok(bk.sizeBytes > 0);
  fs.rmSync(bk.backupPath, { force: true });
});

test.after(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
