import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// 严格隔离测试数据库与 AI 配置，绝不触碰正式 data/workbench.db 或本机 8317 密钥
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmw-creators-test-'));
process.env.MMW_DB_PATH = path.join(tmpDir, 'creators-test.db');
process.env.MMW_CLIPROXY_CONFIG = path.join(tmpDir, 'missing-cliproxy.yaml');
process.env.AI_API_KEY = '';
process.env.AI_BASE_URL = 'http://127.0.0.1:1/v1';

const Fastify = (await import('fastify')).default;
const { getDb, closeDb, upsertContentWithMetrics } = await import('../dist/db/database.js');
const { registerRadarRoutes } = await import('../dist/api/radarRoutes.js');
const { recomputeSourceBreakout } = await import('../dist/services/breakoutService.js');
const { getShanghaiDayWindow } = await import('../dist/services/creatorR2Service.js');

const app = Fastify({ logger: false });
registerRadarRoutes(app);

let biliCreatorId = 0;
let douyinCreatorId = 0;
let rssSourceId = 0;
let hotBoardSourceId = 0;
let biliTodayContentId = 0;
let douyinTodayContentId = 0;

test('V3 增量迁移建表完整且支持 published_at / summary 补全回填', () => {
  const db = getDb();
  const versions = db
    .prepare('SELECT version FROM schema_migrations ORDER BY version ASC')
    .all()
    .map((r) => Number(r.version));
  assert.deepEqual(versions.slice(0, 3), [1, 2, 3]);
  assert.ok(versions.includes(4));

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('content_r2_analyses', 'comment_topic_ideas')")
    .all()
    .map((r) => String(r.name))
    .sort();
  assert.deepEqual(tables, ['comment_topic_ideas', 'content_r2_analyses']);

  const now = new Date().toISOString();
  const sRes = db
    .prepare("INSERT INTO sources (name, platform, url, source_type, created_at, updated_at) VALUES ('回填测试博主', 'bilibili', 'https://space.bilibili.com/999001', 'creator', ?, ?)")
    .run(now, now);
  const sid = Number(sRes.lastInsertRowid);

  // 先写入无发布时间、无简介的粗略条目
  const first = upsertContentWithMetrics({
    sourceId: sid,
    platform: 'bilibili',
    platformItemId: 'BV_BACKFILL_1',
    url: 'https://www.bilibili.com/video/BV_BACKFILL_1',
    title: '回填测试视频',
    publishedAt: null,
    summary: '',
  });
  assert.equal(first.isNew, true);

  // 二次抓取补齐真实 published_at 与 summary
  const second = upsertContentWithMetrics({
    sourceId: sid,
    platform: 'bilibili',
    platformItemId: 'BV_BACKFILL_1',
    url: 'https://www.bilibili.com/video/BV_BACKFILL_1',
    title: '回填测试视频',
    publishedAt: '2026-11-20T08:00:00.000Z',
    summary: '后续接口补全的简介内容',
  });
  assert.equal(second.isNew, false);
  assert.equal(second.contentId, first.contentId);

  // 再次写入不应覆盖已有 non-null 的 published_at
  upsertContentWithMetrics({
    sourceId: sid,
    platform: 'bilibili',
    platformItemId: 'BV_BACKFILL_1',
    url: 'https://www.bilibili.com/video/BV_BACKFILL_1',
    title: '回填测试视频',
    publishedAt: '2026-11-25T08:00:00.000Z',
    summary: '第二次新简介不应覆盖已有非空简介',
  });

  const savedRow = db.prepare('SELECT published_at, summary FROM contents WHERE id = ?').get(first.contentId);
  assert.equal(savedRow.published_at, '2026-11-20T08:00:00.000Z');
  assert.equal(savedRow.summary, '后续接口补全的简介内容');

  // 清理该测试源，避免影响后续 R1 统计
  db.prepare('DELETE FROM sources WHERE id = ?').run(sid);
});

test('R1 博主与 RSS 源分离、东八区今日更新视图与热度排行榜（含抖音无播放量兼容与兜底）', async () => {
  const db = getDb();
  const now = new Date().toISOString();
  const win = getShanghaiDayWindow();
  const todayPlus2h = new Date(win.todayStartMs + 2 * 3600 * 1000).toISOString();
  const todayPlus3h = new Date(win.todayStartMs + 3 * 3600 * 1000).toISOString();
  const twoDaysAgo = new Date(win.todayStartMs - 2 * 86400000 + 3600 * 1000).toISOString();
  const sevenDaysAgo = new Date(win.todayStartMs - 7 * 86400000 + 3600 * 1000).toISOString();

  biliCreatorId = Number(
    db
      .prepare("INSERT INTO sources (name, platform, url, source_type, follower_count, created_at, updated_at) VALUES ('影视飓风测试', 'bilibili', 'https://space.bilibili.com/946974', 'creator', 1000000, ?, ?)")
      .run(now, now).lastInsertRowid
  );
  douyinCreatorId = Number(
    db
      .prepare("INSERT INTO sources (name, platform, url, source_type, follower_count, created_at, updated_at) VALUES ('水球泡测试', 'douyin', 'https://www.douyin.com/user/test', 'creator', 50000, ?, ?)")
      .run(now, now).lastInsertRowid
  );
  rssSourceId = Number(
    db
      .prepare("INSERT INTO sources (name, platform, url, source_type, created_at, updated_at) VALUES ('Hugging Face Blog', 'rss', 'https://huggingface.co/blog/feed.xml', 'rss', ?, ?)")
      .run(now, now).lastInsertRowid
  );
  hotBoardSourceId = Number(
    db
      .prepare("INSERT INTO sources (name, platform, url, source_type, status, created_at, updated_at) VALUES ('热榜导入测试', 'bilibili', 'https://www.bilibili.com/v/popular/all', 'hot_board', 'paused', ?, ?)")
      .run(now, now).lastInsertRowid
  );

  // RSS 与热榜各自插入今天内容，验证默认不混入对标博主视图
  upsertContentWithMetrics({
    sourceId: rssSourceId,
    platform: 'rss',
    platformItemId: 'rss-1',
    url: 'https://huggingface.co/blog/rss-1',
    title: 'RSS 英文博客文章',
    publishedAt: todayPlus2h,
  });
  upsertContentWithMetrics({
    sourceId: hotBoardSourceId,
    platform: 'bilibili',
    platformItemId: 'BV_HOT_1',
    url: 'https://www.bilibili.com/video/BV_HOT_1',
    title: '热榜视频不应该出现在博主流',
    publishedAt: todayPlus2h,
  });

  // B站博主今日新发 + 历史基线
  biliTodayContentId = upsertContentWithMetrics({
    sourceId: biliCreatorId,
    platform: 'bilibili',
    platformItemId: 'BV_TODAY_1',
    url: 'https://www.bilibili.com/video/BV_TODAY_1',
    title: 'B站今日评测大片：百元设备实战对比',
    summary: '今天实测三款入门设备在逆光和暗光下的真实表现。',
    publishedAt: todayPlus2h,
    metrics: { views: 80000, likes: 2600, comments: 180, favorites: 1100, shares: 95 },
  }).contentId;

  upsertContentWithMetrics({
    sourceId: biliCreatorId,
    platform: 'bilibili',
    platformItemId: 'BV_OLD_1',
    url: 'https://www.bilibili.com/video/BV_OLD_1',
    title: 'B站七天前旧视频（今日入库但发布时间是7天前）',
    publishedAt: sevenDaysAgo,
    metrics: { views: 15000, likes: 400, comments: 30, favorites: 120, shares: 20 },
  });

  // 抖音博主（views=null）今日高互动爆款 + 3条基线
  for (let i = 1; i <= 3; i++) {
    upsertContentWithMetrics({
      sourceId: douyinCreatorId,
      platform: 'douyin',
      platformItemId: `dy_base_${i}`,
      url: `https://www.douyin.com/video/700000000000000000${i}`,
      title: `抖音常规分享 ${i}`,
      publishedAt: twoDaysAgo,
      metrics: { views: null, likes: 300 + i * 20, comments: 25, favorites: 80, shares: 15 },
    });
  }
  douyinTodayContentId = upsertContentWithMetrics({
    sourceId: douyinCreatorId,
    platform: 'douyin',
    platformItemId: 'dy_today_boom',
    url: 'https://www.douyin.com/video/7000000000000009999',
    title: '抖音今日高赞爆款：普通人做 AI 提效的 3 个误区',
    summary: '总结了大家最容易踩坑的三个提效习惯，点赞收藏很高。',
    publishedAt: todayPlus3h,
    metrics: { views: null, likes: 4500, comments: 420, favorites: 1800, shares: 360 },
  }).contentId;

  recomputeSourceBreakout(biliCreatorId);
  recomputeSourceBreakout(douyinCreatorId);

  // 1) 默认 includeRss=0：只出现 2 位 creator，今日更新与今日热度榜准确
  const res = await app.inject({ method: 'GET', url: '/api/radar/creators/feed' });
  assert.equal(res.statusCode, 200);
  const body = res.json();

  assert.equal(body.creators.length, 2);
  assert.ok(body.creators.every((c) => c.source_type === 'creator'));
  assert.equal(body.todayUpdates.dateLocal, win.dateLocal);
  assert.equal(body.todayUpdates.hasTodayNew, true);
  assert.equal(body.todayUpdates.todayCount, 2);

  // 验证 7 天前发布但今天才发现的旧视频不会被当成“今日新发”
  const biliCreatorMeta = body.creators.find((c) => c.id === biliCreatorId);
  assert.equal(biliCreatorMeta.today_new_count, 1);

  assert.equal(body.todayLeaderboard.isFallback, false);
  assert.equal(body.todayLeaderboard.fallbackLabel, '');
  assert.equal(body.todayLeaderboard.items.length, 2);
  assert.equal(body.todayLeaderboard.items[0].rank, 1);
  assert.ok(body.todayLeaderboard.items[0].heatScore > 0);
  assert.ok(String(body.todayLeaderboard.items[0].heatBasis).length > 0);
  // 抖音 views=null 也能凭借高赞/评/藏/爆款倍数正常上榜
  const dyRankItem = body.todayLeaderboard.items.find((it) => it.id === douyinTodayContentId);
  assert.ok(dyRankItem && dyRankItem.heatScore > 40);

  // 2) includeRss=1 允许混入 RSS，但仍排除 hot_board
  const resWithRss = await app.inject({ method: 'GET', url: '/api/radar/creators/feed?includeRss=1' });
  const bodyWithRss = resWithRss.json();
  assert.equal(bodyWithRss.creators.length, 3);
  assert.ok(bodyWithRss.creators.some((c) => c.source_type === 'rss'));
  assert.ok(!bodyWithRss.creators.some((c) => c.source_type === 'hot_board'));

  // 3) 模拟今日暂无新发：把今日两篇改到 2 天前，检验兜底逻辑
  db.prepare('UPDATE contents SET published_at = ? WHERE id IN (?, ?)').run(twoDaysAgo, biliTodayContentId, douyinTodayContentId);
  const fallbackRes = await app.inject({ method: 'GET', url: '/api/radar/creators/feed' });
  const fbBody = fallbackRes.json();
  assert.equal(fbBody.todayUpdates.hasTodayNew, false);
  assert.equal(fbBody.todayUpdates.todayCount, 0);
  assert.equal(fbBody.todayUpdates.items.length, 2);
  assert.equal(fbBody.todayLeaderboard.isFallback, true);
  assert.match(fbBody.todayLeaderboard.fallbackLabel, /近 3 天/);
  assert.ok(fbBody.todayLeaderboard.items.length >= 2);

  // 恢复今日发布时间供后续用例使用
  db.prepare('UPDATE contents SET published_at = ? WHERE id = ?').run(todayPlus2h, biliTodayContentId);
  db.prepare('UPDATE contents SET published_at = ? WHERE id = ?').run(todayPlus3h, douyinTodayContentId);
});

test('R3 分博主全部历史视频严格按发布时间从新到旧排序并支持分页与搜索', async () => {
  const win = getShanghaiDayWindow();
  // 为 B站博主补充 35 条横跨 60 天的历史视频
  for (let i = 1; i <= 35; i++) {
    const pub = new Date(win.todayStartMs - i * 40 * 3600 * 1000).toISOString();
    upsertContentWithMetrics({
      sourceId: biliCreatorId,
      platform: 'bilibili',
      platformItemId: `BV_HIST_${String(i).padStart(2, '0')}`,
      url: `https://www.bilibili.com/video/BV_HIST_${String(i).padStart(2, '0')}`,
      title: i === 28 ? `历史深度专题 第${i}期 农业无人机实测` : `历史视频档案 第${i}期`,
      publishedAt: pub,
      metrics: { views: 5000 + i * 100, likes: 100 + i * 5 },
    });
  }

  // 第 1 页 (offset=0, limit=15, days=0)
  const p1 = (await app.inject({ method: 'GET', url: `/api/radar/creators/feed?creatorId=${biliCreatorId}&days=0&offset=0&limit=15` })).json();
  assert.equal(p1.items.length, 15);
  assert.equal(p1.total, 37);
  assert.equal(p1.offset, 0);
  assert.equal(p1.limit, 15);
  assert.equal(p1.hasMore, true);

  // 验证严格按 COALESCE(published_at, discovered_at) DESC 排序
  for (let i = 1; i < p1.items.length; i++) {
    const prevT = Date.parse(p1.items[i - 1].published_at || p1.items[i - 1].discovered_at);
    const curT = Date.parse(p1.items[i].published_at || p1.items[i].discovered_at);
    assert.ok(prevT >= curT, `排序错乱：idx ${i - 1} (${prevT}) < idx ${i} (${curT})`);
  }

  // 最后一页 (offset=30, limit=15)
  const p3 = (await app.inject({ method: 'GET', url: `/api/radar/creators/feed?creatorId=${biliCreatorId}&days=0&offset=30&limit=15` })).json();
  assert.equal(p3.items.length, 7);
  assert.equal(p3.hasMore, false);

  // 关键词搜索跨全部历史命中第 28 期
  const searchRes = (
    await app.inject({
      method: 'GET',
      url: `/api/radar/creators/feed?creatorId=${biliCreatorId}&days=0&search=${encodeURIComponent('农业无人机')}`,
    })
  ).json();
  assert.equal(searchRes.total, 1);
  assert.match(searchRes.items[0].title, /农业无人机实测/);

  // 校验 fetch-history 参数校验（不存在博主 / 热榜源）
  const bad404 = await app.inject({ method: 'POST', url: '/api/radar/creators/999999/fetch-history', payload: { maxPages: 2 } });
  assert.equal(bad404.statusCode, 404);
  const badHot = await app.inject({ method: 'POST', url: `/api/radar/creators/${hotBoardSourceId}/fetch-history`, payload: { maxPages: 2 } });
  assert.equal(badHot.statusCode, 400);
});

test('R2 统一三项分析（离线降级、口播自动升级、Mock LLM 缓存）与多视频二创对比', async () => {
  const db = getDb();

  // 1) 离线兜底分析（仅有标题简介）
  const offRes = await app.inject({
    method: 'POST',
    url: `/api/radar/intel/${douyinTodayContentId}/r2-analyze`,
    payload: {},
  });
  assert.equal(offRes.statusCode, 200);
  const offJson = offRes.json();
  assert.equal(offJson.ok, true);
  assert.equal(offJson.analysis.basisSource, '标题简介+真实数据');
  assert.ok(offJson.analysis.whatItSays.length > 0);
  assert.ok(offJson.analysis.heatVerdict.length > 0);
  assert.ok(offJson.analysis.remixSuitability.length > 0);
  assert.ok(offJson.analysis.remixScore > 0);

  // 2) 写入口播全文 >= 40 字后，即使不传 force 也应自动识别指纹变化升级为「口播全文+真实数据」
  db.prepare("UPDATE contents SET transcript = ?, transcript_status = 'done' WHERE id = ?").run(
    '今天我花三天时间实测了普通人用 AI 工具最容易踩的三个误区，第一个就是只顾着背提示词而不整理真实业务流程，第二个是忽略了数据校验和人工把关。',
    douyinTodayContentId
  );
  const upgRes = (
    await app.inject({
      method: 'POST',
      url: `/api/radar/intel/${douyinTodayContentId}/r2-analyze`,
      payload: {},
    })
  ).json();
  assert.equal(upgRes.analysis.basisSource, '口播全文+真实数据');

  // 确认 feed 返回已携带 r2_analysis、latest_favorites、transcript_preview
  const feedCheck = (await app.inject({ method: 'GET', url: `/api/radar/creators/feed?creatorId=${douyinCreatorId}&days=0` })).json();
  const dyFeedItem = feedCheck.items.find((x) => x.id === douyinTodayContentId);
  assert.ok(dyFeedItem.r2_analysis);
  assert.equal(dyFeedItem.r2_analysis.basisSource, '口播全文+真实数据');
  assert.equal(dyFeedItem.latest_favorites, 1800);
  assert.equal(dyFeedItem.latest_shares, 360);
  assert.ok(dyFeedItem.transcript_preview.includes('实测了普通人用'));

  // 3) 启动临时 Mock OpenAI 服务，验证真实 JSON 解析与 ai_receipts 缓存命中
  let mockHits = 0;
  const mockServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      mockHits++;
      const parsed = JSON.parse(raw || '{}');
      const userPrompt = String(parsed?.messages?.[1]?.content || '');
      let replyJson;
      if (userPrompt.includes('候选视频列表')) {
        replyJson = {
          bestContentId: douyinTodayContentId,
          summary: 'Mock 对比结论：抖音那条已有完整口播且互动倍数为爆款，最适合立刻二创。',
          rankings: [
            {
              contentId: douyinTodayContentId,
              remixScore: 92,
              verdict: '最推荐二创',
              reason: '已有口播全文且切中痛点',
              suggestedHook: '别再死背提示词了，90% 的人都用错了方向。',
            },
            {
              contentId: 99999999, // 刻意夹带幻觉 ID，检验服务端过滤能力
              remixScore: 99,
              verdict: '幻觉条目',
              reason: '不应出现',
              suggestedHook: '不应出现',
            },
          ],
        };
      } else {
        replyJson = {
          whatItSays: '这条视频拆解了普通人做 AI 提效时最容易踩的 3 个误区，强调先理流程再选工具。',
          heatVerdict: '明显爆款：点赞 4500、收藏 1800，远超该博主日常互动中位数。',
          heatLevel: 'viral',
          remixSuitability: '高度适合二创',
          remixScore: 91,
          remixAngle: '保留“三个反常识误区”结构，结合自身行业真实案例做实操演示。',
        };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(replyJson) } }],
          usage: { prompt_tokens: 120, completion_tokens: 80 },
        })
      );
    });
  });

  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  const addr = mockServer.address();
  const mockUrl = `http://127.0.0.1:${addr.port}/v1`;
  const now = new Date().toISOString();

  db.prepare("UPDATE app_settings SET value = ?, updated_at = ? WHERE key = 'ai_base_url'").run(mockUrl, now);
  db.prepare("UPDATE app_settings SET value = ?, updated_at = ? WHERE key = 'ai_api_key'").run('test-mock-key-local', now);

  try {
    const aiR2 = (
      await app.inject({
        method: 'POST',
        url: `/api/radar/intel/${douyinTodayContentId}/r2-analyze`,
        payload: { force: true },
      })
    ).json();
    assert.equal(aiR2.analysis.heatLevel, 'viral');
    assert.equal(aiR2.analysis.remixScore, 91);
    assert.equal(mockHits, 1);

    // 再次请求不传 force：直接命中数据库指纹缓存，不再请求 Mock LLM
    const cachedR2 = (
      await app.inject({
        method: 'POST',
        url: `/api/radar/intel/${douyinTodayContentId}/r2-analyze`,
        payload: {},
      })
    ).json();
    assert.equal(cachedR2.analysis.remixScore, 91);
    assert.equal(mockHits, 1);

    // 横向二创对比：过滤幻觉 ID 99999999，补全其余候选并连续排名
    const cmpRes = (
      await app.inject({
        method: 'POST',
        url: '/api/radar/creators/compare-remix',
        payload: { contentIds: [biliTodayContentId, douyinTodayContentId] },
      })
    ).json();
    assert.equal(cmpRes.ok, true);
    assert.equal(cmpRes.bestContentId, douyinTodayContentId);
    assert.equal(cmpRes.rankings.length, 2);
    assert.deepEqual(
      cmpRes.rankings.map((r) => r.rank),
      [1, 2]
    );
    assert.ok(cmpRes.rankings.every((r) => r.contentId === biliTodayContentId || r.contentId === douyinTodayContentId));
  } finally {
    db.prepare("UPDATE app_settings SET value = ?, updated_at = ? WHERE key = 'ai_base_url'").run('http://127.0.0.1:1/v1', now);
    db.prepare("UPDATE app_settings SET value = ?, updated_at = ? WHERE key = 'ai_api_key'").run('', now);
    await new Promise((resolve) => mockServer.close(resolve));
  }

  // 空候选对比应优雅返回 null
  const emptyCmp = (
    await app.inject({
      method: 'POST',
      url: '/api/radar/creators/compare-remix',
      payload: { creatorId: 999999 },
    })
  ).json();
  assert.equal(emptyCmp.ok, true);
  assert.equal(emptyCmp.bestContentId, null);
  assert.deepEqual(emptyCmp.rankings, []);
});

test('R4 零评论严禁编造、真实评论话题提炼与幂等存入个人选题库', async () => {
  const db = getDb();
  const now = new Date().toISOString();

  // 1) 零评论红线：绝对不能编造评论或话题
  const zeroRes = (
    await app.inject({
      method: 'POST',
      url: `/api/radar/intel/${biliTodayContentId}/comments/topics`,
      payload: { autoCrawl: false },
    })
  ).json();
  assert.equal(zeroRes.ok, true);
  assert.equal(zeroRes.commentsCount, 0);
  assert.deepEqual(zeroRes.topics, []);

  // 2) 写入真实评论
  const realTexts = [
    '请问新手预算 500 块以内到底该买哪一款？',
    '暗光环境下噪点控制得怎么样？有没有原片对比？',
    '讲得很实在，我之前就是买贵了结果吃灰半年',
    '能不能出一期零基础三分钟上手的参数设置教程？',
  ];
  const insCm = db.prepare(
    'INSERT INTO content_comments (content_id, platform, platform_comment_id, author, text, likes, published_at, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  realTexts.forEach((txt, idx) => {
    insCm.run(biliTodayContentId, 'bilibili', `cm_${idx + 1}`, `观众${idx + 1}`, txt, 120 - idx * 20, now, now);
  });

  // 3) 提炼评论话题与创作选题
  const topicRes = (
    await app.inject({
      method: 'POST',
      url: `/api/radar/intel/${biliTodayContentId}/comments/topics`,
      payload: { autoCrawl: false },
    })
  ).json();
  assert.equal(topicRes.ok, true);
  assert.equal(topicRes.commentsCount, 4);
  assert.ok(topicRes.topics.length >= 2);
  for (const t of topicRes.topics) {
    assert.ok(t.evidenceComments.length >= 1);
    // 每条引用证据必须真实落在实际评论原文内
    for (const ev of t.evidenceComments) {
      assert.ok(realTexts.some((rt) => rt.includes(ev) || ev.includes(rt)), `引用评论未对齐真实评论: ${ev}`);
    }
  }

  // 详情接口同步暴露 commentTopics
  const detailRes = (await app.inject({ method: 'GET', url: `/api/radar/intel/${biliTodayContentId}/detail` })).json();
  assert.equal(detailRes.commentTopics.length, topicRes.topics.length);

  // 4) 一键存入个人选题库 + 幂等防重复校验
  const targetTopicId = topicRes.topics[0].id;
  const save1 = (
    await app.inject({
      method: 'POST',
      url: `/api/radar/comments/topics/${targetTopicId}/save-board`,
    })
  ).json();
  assert.equal(save1.ok, true);
  assert.equal(save1.topicId, targetTopicId);
  assert.equal(save1.boardItem.status, 'to_research');
  assert.equal(save1.boardItem.source_content_id, biliTodayContentId);

  const countBefore = Number(db.prepare('SELECT COUNT(*) AS c FROM topic_board').get().c);
  const save2 = (
    await app.inject({
      method: 'POST',
      url: `/api/radar/comments/topics/${targetTopicId}/save-board`,
    })
  ).json();
  const countAfter = Number(db.prepare('SELECT COUNT(*) AS c FROM topic_board').get().c);
  assert.equal(save2.boardItem.id, save1.boardItem.id);
  assert.equal(countAfter, countBefore);
});

test.after(async () => {
  await app.close();
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
