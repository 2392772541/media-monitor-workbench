import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 隔离测试数据库，避免影响正式工作台数据
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmw-digest-test-'));
process.env.MMW_DB_PATH = path.join(tmpDir, 'digest-test.db');

const { getDb, closeDb, upsertContentWithMetrics } = await import('../dist/db/database.js');
const {
  normalizeNumberedLines,
  normalizeOverviewText,
  buildTranscriptExcerpt,
  generateCreatorCopyDigest,
  isVideoPlatform,
} = await import('../dist/services/creatorDigestService.js');

test('大概讲什么完整收句：超长时按中文句号安全截断，绝不在半句话断开', () => {
  const shortText = '博主拆解了三套实用AI搭配方法。';
  assert.equal(normalizeOverviewText(shortText, 220), shortText);

  const longText = `${'第一句讲核心逻辑。'.repeat(18)}第二句讲最后一步但被写得太长一直没句号${'甲'.repeat(120)}`;
  const cleaned = normalizeOverviewText(longText, 120);
  assert.ok(cleaned.length <= 120);
  assert.ok(cleaned.endsWith('。'), `预期以句号收尾，实际：${cleaned.slice(-10)}`);
});

test('文案 1234 归纳列表清洗：自动剥离冗余编号并最多保留 4 条干货', () => {
  const cleaned = normalizeNumberedLines([
    '1. 先用单个核心场景切入，别一口气堆工具',
    '2、把每天高频重复动作做成固定流程',
    '③ 用免费离线显卡先跑通验证再花钱',
    '- 隐私内容分段喂给模型，只给必要片段',
    '5) 多出来的第五条应被截断',
  ]);

  assert.deepEqual(cleaned, [
    '先用单个核心场景切入，别一口气堆工具',
    '把每天高频重复动作做成固定流程',
    '用免费离线显卡先跑通验证再花钱',
    '隐私内容分段喂给模型，只给必要片段',
  ]);

  assert.deepEqual(normalizeNumberedLines(['', '   ', null]), []);
  assert.deepEqual(normalizeNumberedLines(null), []);
});

test('长口播截断覆盖策略：12000字以内完整保留，超长口播保留开头+中段+结尾', () => {
  const shortText = '这是一段完整口播测试文案。'.repeat(20);
  assert.equal(buildTranscriptExcerpt(shortText, 12000), shortText.trim());

  const longText = `开头重点${'甲'.repeat(6000)}中段精华${'乙'.repeat(6000)}${'丙'.repeat(3500)}收尾结论`;
  const excerpt = buildTranscriptExcerpt(longText, 12000);
  assert.ok(excerpt.includes('开头重点'), '应保留开头');
  assert.ok(excerpt.includes('[……中段节选……]'), '应包含中段衔接标识');
  assert.ok(excerpt.includes('收尾结论'), '应保留收尾结论');
});

test('强口播守卫：未转写口播的视频严禁靠标题简介硬猜归纳，必须抛出 NEED_TRANSCRIPT', async () => {
  assert.equal(isVideoPlatform('douyin'), true);
  assert.equal(isVideoPlatform('bilibili'), true);
  assert.equal(isVideoPlatform('rss'), false);

  const db = getDb();
  const now = new Date().toISOString();
  const src = db
    .prepare(
      "INSERT INTO sources (name, platform, url, source_type, created_at, updated_at) VALUES ('测试抖音博主', 'douyin', 'https://v.douyin.com/test/', 'creator', ?, ?)"
    )
    .run(now, now);

  const saved = upsertContentWithMetrics({
    sourceId: Number(src.lastInsertRowid),
    platform: 'douyin',
    platformItemId: '7999999999999999999',
    url: 'https://www.douyin.com/video/7999999999999999999',
    title: '只写了很长标题和简介但没有转口播稿的视频',
    summary: '这是一段200字的抖音视频简介，但不是视频真实转写出来的完整口播文案。'.repeat(5),
    body: '简介内容'.repeat(40),
    metrics: { likes: 1200 },
  });

  await assert.rejects(
    async () => generateCreatorCopyDigest(saved.contentId, true),
    /NEED_TRANSCRIPT/
  );
});

test.after(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
