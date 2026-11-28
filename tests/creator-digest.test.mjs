import test from 'node:test';
import assert from 'node:assert/strict';

const { normalizeNumberedLines } = await import('../dist/services/creatorDigestService.js');

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
