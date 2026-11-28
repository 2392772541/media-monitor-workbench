import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  MCP_CONFIG_PATH,
  MCP_SCRIPT_PATH,
  PYTHON_EXE,
  PROJECT_ROOT,
  SKILL_DIR,
  SKILL_DOCTOR_SCRIPT,
  SKILL_MD_PATH,
  McpStdioClient,
  assertSortedNewestFirst,
  cleanupBoardItem,
  cleanupSauFile,
  createSyntheticMp4,
  httpJson,
  isFastifyRouteNotFound,
  isM1Deployed,
  isRouteMissing,
  listFilesRecursive,
  parseMcpToolJson,
  parseSkillFrontmatter,
  pendingIfOffline,
  pickCreatorAndContentIds,
  runCommandSync,
  scanCssCompliance,
  scanForSecrets,
  throwIfMcpOfflineOrPreM3,
} from './lib/helpers.mjs';

export function getTier1Checks() {
  return [
    // ================= F1: 每日最新更新与博主数据源分离 (5 checks) =================
    {
      id: 'T1-F1-01',
      feature: 'F1',
      name: 'GET /api/radar/creators/feed returns upgraded F1 shape with todayUpdates & pagination metadata',
      async run(ctx) {
        const res = await httpJson(ctx, `${ctx.baseUrl}/api/radar/creators/feed`);
        assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
        const d = res.json;
        assert.ok(d && Array.isArray(d.creators), 'creators must be an Array');
        assert.ok(Array.isArray(d.items), 'items must be an Array');
        if (!d.todayUpdates || typeof d.total !== 'number' || typeof d.hasMore !== 'boolean') {
          pendingIfOffline(ctx, 'M1 feed upgrade fields (todayUpdates/total/offset/limit/hasMore) not yet deployed');
        }
        assert.match(String(d.todayUpdates.dateLocal), /^\d{4}-\d{2}-\d{2}$/, 'todayUpdates.dateLocal must be YYYY-MM-DD');
        assert.equal(typeof d.todayUpdates.hasTodayNew, 'boolean');
        assert.equal(typeof d.todayUpdates.todayCount, 'number');
        assert.ok(Array.isArray(d.todayUpdates.items));
        assert.equal(d.offset, 0);
        assert.equal(d.limit, 30);
      },
    },
    {
      id: 'T1-F1-02',
      feature: 'F1',
      name: 'Default feed excludes RSS & hot_board sources (source_type === creator only)',
      async run(ctx) {
        const res = await httpJson(ctx, `${ctx.baseUrl}/api/radar/creators/feed`);
        assert.equal(res.status, 200);
        const d = res.json;
        if (!d.todayUpdates || d.creators.some((c) => c.source_type === undefined)) {
          pendingIfOffline(ctx, 'M1 creator source_type isolation not yet deployed on /api/radar/creators/feed');
        }
        for (const c of d.creators) {
          assert.equal(c.source_type, 'creator', `Creator ${c.name} must have source_type === 'creator', got ${c.source_type}`);
        }
        const creatorIds = new Set(d.creators.map((c) => Number(c.id)));
        for (const item of d.items) {
          assert.ok(creatorIds.has(Number(item.source_id)), `Item ${item.id} source_id=${item.source_id} not in creator list`);
        }
      },
    },
    {
      id: 'T1-F1-03',
      feature: 'F1',
      name: 'Each creator summary contains required metadata and today_new_count',
      async run(ctx) {
        const res = await httpJson(ctx, `${ctx.baseUrl}/api/radar/creators/feed`);
        assert.equal(res.status, 200);
        const d = res.json;
        if (!d.todayUpdates || d.creators.some((c) => c.today_new_count === undefined)) {
          pendingIfOffline(ctx, 'M1 creator today_new_count/source_type fields not yet deployed');
        }
        assert.ok(d.creators.length >= 1, 'Expected at least 1 creator');
        for (const c of d.creators) {
          assert.ok(Number(c.id) > 0);
          assert.ok(typeof c.name === 'string' && c.name.length > 0);
          assert.ok(typeof c.platform === 'string' && c.platform.length > 0);
          assert.equal(c.source_type, 'creator');
          assert.ok(typeof c.content_count === 'number' && c.content_count >= 0);
          assert.ok(typeof c.today_new_count === 'number' && c.today_new_count >= 0);
          assert.ok('latest_published_at' in c);
        }
      },
    },
    {
      id: 'T1-F1-04',
      feature: 'F1',
      name: 'Filtering feed by ?creatorId=<id> returns only that creator items while keeping creators list',
      async run(ctx) {
        const { creators } = await pickCreatorAndContentIds(ctx);
        assert.ok(creators.length >= 1, 'No creator available');
        const target = creators.find((c) => Number(c.content_count) > 0) || creators[0];
        const res = await httpJson(ctx, `${ctx.baseUrl}/api/radar/creators/feed?creatorId=${target.id}&days=0`);
        assert.equal(res.status, 200);
        assert.ok(Array.isArray(res.json.creators) && res.json.creators.length >= 1);
        assert.ok(Array.isArray(res.json.items));
        for (const it of res.json.items) {
          assert.equal(Number(it.source_id), Number(target.id));
        }
      },
    },
    {
      id: 'T1-F1-05',
      feature: 'F1',
      name: 'Filtering feed by ?search=<keyword> returns matching creator items and total <= unfilteredTotal',
      async run(ctx) {
        const baseRes = await httpJson(ctx, `${ctx.baseUrl}/api/radar/creators/feed?days=0&limit=30`);
        assert.equal(baseRes.status, 200);
        if (typeof baseRes.json?.total !== 'number' || !baseRes.json?.todayUpdates) {
          pendingIfOffline(ctx, 'M1 feed search & total fields not yet deployed');
        }
        const first = baseRes.json.items[0];
        assert.ok(first && first.title, 'Need at least 1 item to derive search keyword');
        const kw = String(first.title).trim().slice(0, 4);
        const searchRes = await httpJson(
          ctx,
          `${ctx.baseUrl}/api/radar/creators/feed?days=0&search=${encodeURIComponent(kw)}`
        );
        assert.equal(searchRes.status, 200);
        assert.ok(searchRes.json.total <= baseRes.json.total, 'Filtered total must be <= unfiltered total');
        assert.ok(searchRes.json.items.length >= 1, `Expected at least 1 match for "${kw}"`);
        const kwLower = kw.toLowerCase();
        for (const it of searchRes.json.items) {
          const hay = [it.title, it.summary, it.body, it.author, it.source_name].map((v) => String(v || '').toLowerCase()).join(' ');
          assert.ok(hay.includes(kwLower), `Item ${it.id} does not match keyword "${kw}"`);
        }
      },
    },

    // ================= F2: 当日新发热度排行榜与无新发兜底 (5 checks) =================
    {
      id: 'T1-F2-01',
      feature: 'F2',
      name: 'Feed includes todayLeaderboard structure with dateLocal, isFallback, fallbackLabel, items',
      async run(ctx) {
        const res = await httpJson(ctx, `${ctx.baseUrl}/api/radar/creators/feed`);
        assert.equal(res.status, 200);
        const lb = res.json?.todayLeaderboard;
        if (!lb) {
          pendingIfOffline(ctx, 'M1 todayLeaderboard not yet deployed on /api/radar/creators/feed');
        }
        assert.match(String(lb.dateLocal), /^\d{4}-\d{2}-\d{2}$/);
        assert.equal(typeof lb.isFallback, 'boolean');
        assert.equal(typeof lb.fallbackLabel, 'string');
        assert.ok(Array.isArray(lb.items));
      },
    },
    {
      id: 'T1-F2-02',
      feature: 'F2',
      name: 'todayLeaderboard items have sequential 1-based rank, finite heatScore >= 0, non-empty heatBasis',
      async run(ctx) {
        const res = await httpJson(ctx, `${ctx.baseUrl}/api/radar/creators/feed`);
        assert.equal(res.status, 200);
        const lb = res.json?.todayLeaderboard;
        if (!lb) {
          pendingIfOffline(ctx, 'M1 todayLeaderboard not yet deployed');
        }
        assert.ok(lb.items.length >= 1, 'Expected at least 1 item in todayLeaderboard (live or fallback)');
        lb.items.forEach((it, idx) => {
          assert.equal(it.rank, idx + 1, `Expected rank ${idx + 1}, got ${it.rank}`);
          assert.equal(typeof it.heatScore, 'number');
          assert.ok(Number.isFinite(it.heatScore) && it.heatScore >= 0, `Invalid heatScore: ${it.heatScore}`);
          assert.ok(typeof it.heatBasis === 'string' && it.heatBasis.trim().length > 0, 'heatBasis must be non-empty');
        });
      },
    },
    {
      id: 'T1-F2-03',
      feature: 'F2',
      name: 'todayLeaderboard items are sorted monotonically non-increasing by heatScore',
      async run(ctx) {
        const res = await httpJson(ctx, `${ctx.baseUrl}/api/radar/creators/feed`);
        assert.equal(res.status, 200);
        const lb = res.json?.todayLeaderboard;
        if (!lb) {
          pendingIfOffline(ctx, 'M1 todayLeaderboard not yet deployed');
        }
        for (let i = 0; i < lb.items.length - 1; i++) {
          assert.ok(
            lb.items[i].heatScore >= lb.items[i + 1].heatScore,
            `Leaderboard order broken at index ${i}: ${lb.items[i].heatScore} < ${lb.items[i + 1].heatScore}`
          );
        }
      },
    },
    {
      id: 'T1-F2-04',
      feature: 'F2',
      name: 'GET /api/radar/creators/leaderboard?sort=ratio&limit=10 returns <=10 non-hotboard items',
      async run(ctx) {
        const [lbRes, srcRes] = await Promise.all([
          httpJson(ctx, `${ctx.baseUrl}/api/radar/creators/leaderboard?sort=ratio&limit=10`),
          httpJson(ctx, `${ctx.baseUrl}/api/sources`),
        ]);
        assert.equal(lbRes.status, 200);
        assert.ok(Array.isArray(lbRes.json?.items));
        assert.ok(lbRes.json.items.length <= 10);
        if (srcRes.status === 200 && Array.isArray(srcRes.json)) {
          const hotBoardIds = new Set(srcRes.json.filter((s) => s.source_type === 'hot_board').map((s) => Number(s.id)));
          for (const it of lbRes.json.items) {
            assert.ok(!hotBoardIds.has(Number(it.source_id)), `hot_board source ${it.source_id} leaked into leaderboard`);
          }
        }
      },
    },
    {
      id: 'T1-F2-05',
      feature: 'F2',
      name: 'POST /api/radar/creators/recompute-breakout succeeds with sourcesProcessed >= 1',
      async run(ctx) {
        const res = await httpJson(ctx, `${ctx.baseUrl}/api/radar/creators/recompute-breakout`, { method: 'POST' });
        assert.equal(res.status, 200);
        assert.equal(res.json?.ok, true);
        assert.ok(Number(res.json?.sourcesProcessed) >= 1, 'Expected sourcesProcessed >= 1');
        assert.ok(Number(res.json?.contentsUpdated) >= 1, 'Expected contentsUpdated >= 1');
      },
    },

    // ================= F3: 口播文案抓取与 R2 三项 AI 分析及二创对比 (6 checks) =================
    {
      id: 'T1-F3-01',
      feature: 'F3',
      name: 'Feed items expose transcript_status, transcript_preview, and r2_analysis fields',
      async run(ctx) {
        const res = await httpJson(ctx, `${ctx.baseUrl}/api/radar/creators/feed?days=0&limit=10`);
        assert.equal(res.status, 200);
        const items = res.json?.items || [];
        assert.ok(items.length >= 1);
        const sample = items[0];
        if (!('transcript_preview' in sample) || !('r2_analysis' in sample)) {
          pendingIfOffline(ctx, 'M1 transcript_preview / r2_analysis fields not yet deployed on feed items');
        }
        for (const it of items) {
          assert.ok('transcript_status' in it);
          assert.equal(typeof it.transcript_preview, 'string');
          assert.ok(it.r2_analysis === null || (typeof it.r2_analysis === 'object' && 'whatItSays' in it.r2_analysis));
        }
      },
    },
    {
      id: 'T1-F3-02',
      feature: 'F3',
      name: 'POST /api/radar/intel/:id/r2-analyze returns 3-part R2 analysis (whatItSays, heatVerdict, remixSuitability)',
      async run(ctx) {
        const { biliItems, items } = await pickCreatorAndContentIds(ctx);
        const target = biliItems[0] || items[0];
        assert.ok(target, 'No creator content item found');
        const res = await httpJson(ctx, `${ctx.baseUrl}/api/radar/intel/${target.id}/r2-analyze`, {
          method: 'POST',
          body: { force: false },
          timeoutMs: 90000,
        });
        if (isRouteMissing(res)) {
          pendingIfOffline(ctx, 'M1 POST /api/radar/intel/:id/r2-analyze not yet deployed');
        }
        assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${res.text}`);
        assert.equal(res.json?.ok, true);
        const a = res.json?.analysis;
        assert.ok(a && Number(a.contentId) === Number(target.id));
        assert.ok(typeof a.whatItSays === 'string' && a.whatItSays.trim().length > 0);
        assert.ok(typeof a.heatVerdict === 'string' && a.heatVerdict.trim().length > 0);
        assert.ok(typeof a.heatLevel === 'string' && a.heatLevel.trim().length > 0);
        assert.ok(typeof a.remixSuitability === 'string' && a.remixSuitability.trim().length > 0);
        assert.ok(Number.isFinite(a.remixScore) && a.remixScore >= 0 && a.remixScore <= 100);
        assert.equal(typeof a.remixAngle, 'string');
        assert.ok(typeof a.basisSource === 'string' && a.basisSource.length > 0);
        assert.ok(!Number.isNaN(new Date(a.updatedAt).getTime()), 'updatedAt must be valid date');
      },
    },
    {
      id: 'T1-F3-03',
      feature: 'F3',
      name: 'Persisted r2_analysis appears on subsequent GET /api/radar/creators/feed',
      async run(ctx) {
        const { biliItems, items } = await pickCreatorAndContentIds(ctx);
        const target = biliItems[0] || items[0];
        assert.ok(target);
        const analyzeRes = await httpJson(ctx, `${ctx.baseUrl}/api/radar/intel/${target.id}/r2-analyze`, {
          method: 'POST',
          body: { force: false },
          timeoutMs: 90000,
        });
        if (isRouteMissing(analyzeRes)) {
          pendingIfOffline(ctx, 'M1 POST /api/radar/intel/:id/r2-analyze not yet deployed');
        }
        assert.equal(analyzeRes.status, 200);
        const feedRes = await httpJson(
          ctx,
          `${ctx.baseUrl}/api/radar/creators/feed?creatorId=${target.source_id}&days=0&limit=50`
        );
        assert.equal(feedRes.status, 200);
        const found = (feedRes.json?.items || []).find((x) => Number(x.id) === Number(target.id));
        assert.ok(found, 'Analyzed item not found in creator feed');
        assert.ok(found.r2_analysis && found.r2_analysis.whatItSays, 'r2_analysis missing from feed item');
        assert.equal(found.r2_analysis.whatItSays, analyzeRes.json.analysis.whatItSays);
      },
    },
    {
      id: 'T1-F3-04',
      feature: 'F3',
      name: 'POST /api/radar/creators/compare-remix compares 2 contentIds and picks bestContentId',
      async run(ctx) {
        const { biliItems, items } = await pickCreatorAndContentIds(ctx);
        const pool = biliItems.length >= 2 ? biliItems : items;
        assert.ok(pool.length >= 2, 'Need at least 2 creator items for compare-remix');
        const ids = [pool[0].id, pool[1].id];
        const res = await httpJson(ctx, `${ctx.baseUrl}/api/radar/creators/compare-remix`, {
          method: 'POST',
          body: { contentIds: ids },
          timeoutMs: 90000,
        });
        if (isRouteMissing(res)) {
          pendingIfOffline(ctx, 'M1 POST /api/radar/creators/compare-remix not yet deployed');
        }
        assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${res.text}`);
        assert.equal(res.json?.ok, true);
        const rankings = res.json?.rankings;
        assert.ok(Array.isArray(rankings) && rankings.length === 2);
        assert.equal(rankings[0].rank, 1);
        assert.equal(rankings[1].rank, 2);
        assert.equal(Number(res.json.bestContentId), Number(rankings[0].contentId));
        for (const r of rankings) {
          assert.ok(ids.includes(r.contentId));
          assert.ok(typeof r.title === 'string' && r.title.length > 0);
          assert.ok(
            Number.isFinite(r.remixScore) && r.remixScore >= 0 && r.remixScore <= 100,
            `Invalid remixScore: ${r.remixScore}`
          );
          assert.ok(typeof r.verdict === 'string' && r.verdict.length > 0);
          assert.ok(typeof r.reason === 'string' && r.reason.length > 0);
          assert.equal(typeof r.suggestedHook, 'string');
        }
      },
    },
    {
      id: 'T1-F3-05',
      feature: 'F3',
      name: 'POST /api/radar/creators/compare-remix with { creatorId } returns ranked candidates & summary',
      async run(ctx) {
        const { creators } = await pickCreatorAndContentIds(ctx);
        const target = creators.find((c) => Number(c.content_count) >= 2) || creators[0];
        assert.ok(target);
        const res = await httpJson(ctx, `${ctx.baseUrl}/api/radar/creators/compare-remix`, {
          method: 'POST',
          body: { creatorId: target.id },
          timeoutMs: 90000,
        });
        if (isRouteMissing(res)) {
          pendingIfOffline(ctx, 'M1 POST /api/radar/creators/compare-remix not yet deployed');
        }
        assert.equal(res.status, 200);
        assert.equal(res.json?.ok, true);
        assert.ok(typeof res.json?.summary === 'string' && res.json.summary.trim().length > 0);
        assert.ok(Array.isArray(res.json?.rankings) && res.json.rankings.length >= 1);
      },
    },
    {
      id: 'T1-F3-06',
      feature: 'F3',
      name: 'GET /api/radar/integrations reports faster-whisper & POST /api/radar/intel/:id/copy-digest returns structured digest',
      async run(ctx) {
        const intRes = await httpJson(ctx, `${ctx.baseUrl}/api/radar/integrations`);
        assert.equal(intRes.status, 200);
        assert.ok(intRes.json?.ai && intRes.json?.mediaCrawler && intRes.json?.tingwu);
        assert.equal(intRes.json.tingwu.engine, 'faster-whisper');

        const { biliItems, items } = await pickCreatorAndContentIds(ctx);
        const transcribedItems = items.filter(
          (it) => Number(it.transcript_chars) >= 40 || it.transcript_status === 'done' || Boolean(it.copy_digest)
        );
        const target =
          transcribedItems.find((it) => Number(it.transcript_chars) >= 40 && it.copy_digest) ||
          transcribedItems.find((it) => Number(it.transcript_chars) >= 40) ||
          transcribedItems[0] ||
          biliItems[0] ||
          items[0];
        assert.ok(target);
        const digRes = await httpJson(ctx, `${ctx.baseUrl}/api/radar/intel/${target.id}/copy-digest`, {
          method: 'POST',
          body: { forceRefresh: false },
          timeoutMs: 90000,
        });
        if (ctx.offlineCheck && digRes.status === 500 && /8317|fetch|ECONNREFUSED|timeout/i.test(digRes.text)) {
          pendingIfOffline(ctx, `AI proxy unavailable during offline-check for copy-digest: ${digRes.text}`);
        }
        assert.equal(digRes.status, 200, `copy-digest failed: ${digRes.text}`);
        assert.equal(digRes.json?.ok, true);
        if (transcribedItems.length > 0) {
          assert.equal(
            digRes.json?.status,
            'done',
            `Expected synchronous digest for transcribed item ${target.id}, got: ${digRes.text}`
          );
          const d = digRes.json?.digest;
          assert.ok(d && typeof d.overview === 'string' && d.overview.trim().length > 0);
          assert.ok(Array.isArray(d.keyPoints));
          assert.ok(Array.isArray(d.actionItems));
        } else if (digRes.json?.status === 'transcribing') {
          assert.equal(digRes.json?.queued, true);
          assert.ok(typeof digRes.json?.message === 'string' && digRes.json.message.trim().length > 0);
        } else {
          assert.equal(digRes.json?.status, 'done');
          const d = digRes.json?.digest;
          assert.ok(d && typeof d.overview === 'string' && d.overview.trim().length > 0);
          assert.ok(Array.isArray(d.keyPoints));
          assert.ok(Array.isArray(d.actionItems));
        }
      },
    },

    // ================= F4: 分博主全部历史视频从新到旧浏览 (5 checks) =================
    {
      id: 'T1-F4-01',
      feature: 'F4',
      name: 'Feed ?days=0&offset=0&limit=30 returns items strictly sorted newest-to-oldest',
      async run(ctx) {
        const res = await httpJson(ctx, `${ctx.baseUrl}/api/radar/creators/feed?days=0&offset=0&limit=30`);
        assert.equal(res.status, 200);
        const items = res.json?.items || [];
        assert.ok(items.length >= 2);
        assertSortedNewestFirst(items, 'feed_page1');
      },
    },
    {
      id: 'T1-F4-02',
      feature: 'F4',
      name: 'Pagination ?days=0&offset=0&limit=15 and offset=15&limit=15 are disjoint and keep consistent total',
      async run(ctx) {
        const p1 = await httpJson(ctx, `${ctx.baseUrl}/api/radar/creators/feed?days=0&offset=0&limit=15`);
        assert.equal(p1.status, 200);
        if (typeof p1.json?.total !== 'number' || typeof p1.json?.offset !== 'number') {
          pendingIfOffline(ctx, 'M1 offset/total pagination not yet deployed on feed');
        }
        const p2 = await httpJson(ctx, `${ctx.baseUrl}/api/radar/creators/feed?days=0&offset=15&limit=15`);
        assert.equal(p2.status, 200);
        assert.equal(p1.json.total, p2.json.total);
        const ids1 = new Set(p1.json.items.map((x) => x.id));
        const ids2 = new Set(p2.json.items.map((x) => x.id));
        for (const id of ids2) {
          assert.ok(!ids1.has(id), `Duplicate id ${id} across page 1 and page 2`);
        }
        if (p1.json.items.length > 0 && p2.json.items.length > 0) {
          assertSortedNewestFirst([p1.json.items[p1.json.items.length - 1], p2.json.items[0]], 'page_boundary');
        }
      },
    },
    {
      id: 'T1-F4-03',
      feature: 'F4',
      name: 'Douyin creator (水球泡) history returns all stored items strictly newest-to-oldest with limit=50',
      async run(ctx) {
        const { douyinCreator, creators } = await pickCreatorAndContentIds(ctx);
        const target = douyinCreator || creators[0];
        assert.ok(target);
        const res = await httpJson(
          ctx,
          `${ctx.baseUrl}/api/radar/creators/feed?creatorId=${target.id}&days=0&limit=50`
        );
        assert.equal(res.status, 200);
        if (typeof res.json?.total !== 'number') {
          pendingIfOffline(ctx, 'M1 total field not yet deployed on feed');
        }
        assert.equal(res.json.items.length, Math.min(50, res.json.total));
        assertSortedNewestFirst(res.json.items, `creator_${target.id}`);
      },
    },
    {
      id: 'T1-F4-04',
      feature: 'F4',
      name: 'Bilibili creator (影视飓风) history returns all stored items strictly newest-to-oldest with limit=50',
      async run(ctx) {
        const { biliCreator, creators } = await pickCreatorAndContentIds(ctx);
        const target = biliCreator || creators[0];
        assert.ok(target);
        const res = await httpJson(
          ctx,
          `${ctx.baseUrl}/api/radar/creators/feed?creatorId=${target.id}&days=0&limit=50`
        );
        assert.equal(res.status, 200);
        if (typeof res.json?.total !== 'number') {
          pendingIfOffline(ctx, 'M1 total field not yet deployed on feed');
        }
        assert.equal(res.json.items.length, Math.min(50, res.json.total));
        assertSortedNewestFirst(res.json.items, `creator_${target.id}`);
      },
    },
    {
      id: 'T1-F4-05',
      feature: 'F4',
      name: 'GET /api/radar/creators/:id/analytics returns creator, works (newest-first), topDirections, chartData',
      async run(ctx) {
        const { creators } = await pickCreatorAndContentIds(ctx);
        const target = creators[0];
        assert.ok(target);
        const res = await httpJson(ctx, `${ctx.baseUrl}/api/radar/creators/${target.id}/analytics`);
        assert.equal(res.status, 200);
        assert.ok(res.json?.creator && Number(res.json.creator.id) === Number(target.id));
        assert.ok(Array.isArray(res.json?.works));
        assert.ok(Array.isArray(res.json?.topDirections));
        assert.ok(Array.isArray(res.json?.chartData));
        assertSortedNewestFirst(res.json.works, 'analytics_works');
      },
    },
    {
      id: 'T1-F4-06',
      feature: 'F4',
      name: 'POST /api/radar/creators/:id/fetch-history ({ maxPages: 1 }) returns ok, sourceId, counts, totalStored',
      async run(ctx) {
        const { creators } = await pickCreatorAndContentIds(ctx);
        const candidates = [
          creators.find((c) => c.platform === 'bilibili' && !c.is_running),
          ...creators.filter((c) => !c.is_running),
          creators[0],
        ].filter((c, idx, arr) => c && arr.findIndex((x) => x && x.id === c.id) === idx);
        assert.ok(candidates.length > 0, 'No creator available for fetch-history');

        let verified = false;
        let lastRes = null;
        for (const target of candidates) {
          const res = await httpJson(ctx, `${ctx.baseUrl}/api/radar/creators/${target.id}/fetch-history`, {
            method: 'POST',
            body: { maxPages: 1 },
            timeoutMs: 90000,
          });
          if (isFastifyRouteNotFound(res) || (isRouteMissing(res) && !(await isM1Deployed(ctx)))) {
            pendingIfOffline(ctx, 'M1 POST /api/radar/creators/:id/fetch-history not yet deployed');
          }
          lastRes = { target, res };
          if (res.status === 200) {
            assert.equal(res.json?.ok, true);
            assert.equal(Number(res.json?.sourceId), Number(target.id));
            assert.equal(typeof res.json?.fetchedCount, 'number');
            assert.equal(typeof res.json?.insertedCount, 'number');
            assert.equal(typeof res.json?.updatedCount, 'number');
            assert.equal(typeof res.json?.totalStored, 'number');
            verified = true;
            break;
          }
          const isExternalAuthOrRateLimit =
            (res.status === 400 || res.status === 401) &&
            res.json?.ok === false &&
            Number(res.json?.sourceId) === Number(target.id) &&
            typeof res.json?.fetchedCount === 'number' &&
            typeof res.json?.insertedCount === 'number' &&
            typeof res.json?.updatedCount === 'number' &&
            typeof res.json?.totalStored === 'number' &&
            /登录|未获取到|未读取到|风控|滑块|验证/.test(String(res.json?.error || ''));
          if (!isExternalAuthOrRateLimit) {
            assert.fail(`Unexpected fetch-history response (${res.status}) for source ${target.id}: ${res.text}`);
          }
        }
        if (!verified && lastRes) {
          assert.equal(lastRes.res.json?.ok, false);
          assert.ok(typeof lastRes.res.json?.error === 'string' && lastRes.res.json.error.length > 0);
        }
      },
    },

    // ================= F5: 评论采集、热门话题提炼与一键转选题 (5 checks) =================
    {
      id: 'T1-F5-01',
      feature: 'F5',
      name: 'GET /api/comments/jobs returns status (installed, dir, running) and jobs array',
      async run(ctx) {
        const res = await httpJson(ctx, `${ctx.baseUrl}/api/comments/jobs`);
        assert.equal(res.status, 200);
        assert.ok(res.json?.status && typeof res.json.status.installed === 'boolean');
        assert.equal(typeof res.json.status.dir, 'string');
        assert.equal(typeof res.json.status.running, 'boolean');
        assert.ok(Array.isArray(res.json?.jobs));
      },
    },
    {
      id: 'T1-F5-02',
      feature: 'F5',
      name: 'POST /api/radar/intel/:id/comments/topics extracts hot topics & creation ideas from comments',
      async run(ctx) {
        const { biliItems, items } = await pickCreatorAndContentIds(ctx);
        let chosen = biliItems[0] || items[0];
        // Prefer an item that already has stored comments so test is deterministic
        for (const cand of [...biliItems.slice(0, 5), ...items.slice(0, 3)]) {
          const det = await httpJson(ctx, `${ctx.baseUrl}/api/radar/intel/${cand.id}/detail`);
          if (det.status === 200 && Array.isArray(det.json?.comments) && det.json.comments.length > 0) {
            chosen = cand;
            break;
          }
        }
        assert.ok(chosen, 'No content item found');
        const res = await httpJson(ctx, `${ctx.baseUrl}/api/radar/intel/${chosen.id}/comments/topics`, {
          method: 'POST',
          body: { autoCrawl: true, force: false },
          timeoutMs: 90000,
        });
        if (isRouteMissing(res)) {
          pendingIfOffline(ctx, 'M1 POST /api/radar/intel/:id/comments/topics not yet deployed');
        }
        assert.equal(res.status, 200, `comments/topics failed: ${res.text}`);
        assert.equal(res.json?.ok, true);
        assert.equal(Number(res.json?.contentId), Number(chosen.id));
        assert.equal(typeof res.json?.commentsCount, 'number');
        assert.ok(Array.isArray(res.json?.topics));
        if (res.json.commentsCount > 0) {
          assert.ok(res.json.topics.length >= 1, 'Expected >= 1 topic when commentsCount > 0');
          const t = res.json.topics[0];
          assert.ok(t.id !== undefined && t.id !== null);
          assert.ok(typeof t.topic === 'string' && t.topic.length > 0);
          assert.equal(typeof t.heatNote, 'string');
          assert.ok(Array.isArray(t.evidenceComments));
          assert.ok(typeof t.creationIdeaTitle === 'string' && t.creationIdeaTitle.length > 0);
          assert.equal(typeof t.creationAngle, 'string');
          assert.ok('savedBoardId' in t);
        }
      },
    },
    {
      id: 'T1-F5-03',
      feature: 'F5',
      name: 'POST /api/radar/comments/topics/:topicId/save-board saves topic into topic_board (cleaned up)',
      async run(ctx) {
        const { biliItems, items } = await pickCreatorAndContentIds(ctx);
        let chosen = biliItems[0] || items[0];
        for (const cand of [...biliItems.slice(0, 5), ...items.slice(0, 3)]) {
          const det = await httpJson(ctx, `${ctx.baseUrl}/api/radar/intel/${cand.id}/detail`);
          if (det.status === 200 && Array.isArray(det.json?.comments) && det.json.comments.length > 0) {
            chosen = cand;
            break;
          }
        }
        const tRes = await httpJson(ctx, `${ctx.baseUrl}/api/radar/intel/${chosen.id}/comments/topics`, {
          method: 'POST',
          body: { autoCrawl: true, force: false },
          timeoutMs: 90000,
        });
        if (isRouteMissing(tRes)) {
          pendingIfOffline(ctx, 'M1 comment topics routes not yet deployed');
        }
        assert.equal(tRes.status, 200);
        const topics = tRes.json?.topics || [];
        assert.ok(topics.length >= 1, 'Need at least 1 generated topic to test save-board');
        const topicId = topics[0].id;
        let createdBoardId = null;
        try {
          const saveRes = await httpJson(ctx, `${ctx.baseUrl}/api/radar/comments/topics/${topicId}/save-board`, {
            method: 'POST',
          });
          if (isRouteMissing(saveRes)) {
            pendingIfOffline(ctx, 'M1 POST /api/radar/comments/topics/:topicId/save-board not yet deployed');
          }
          assert.equal(saveRes.status, 200, `save-board failed: ${saveRes.text}`);
          assert.equal(saveRes.json?.ok, true);
          assert.ok(saveRes.json?.boardItem && Number(saveRes.json.boardItem.id) > 0);
          assert.ok(typeof saveRes.json.boardItem.title === 'string' && saveRes.json.boardItem.title.length > 0);
          createdBoardId = saveRes.json.boardItem.id;
        } finally {
          if (createdBoardId && !topics[0].savedBoardId) {
            await cleanupBoardItem(ctx.baseUrl, createdBoardId);
          }
        }
      },
    },
    {
      id: 'T1-F5-04',
      feature: 'F5',
      name: 'GET /api/radar/board & DELETE /api/radar/board/:id round-trip creates, reads, and deletes cleanly',
      async run(ctx) {
        let boardId = null;
        const uniqueTitle = `[E2E_TEST_TMP] 选题板回读验证_${Date.now()}`;
        try {
          const createRes = await httpJson(ctx, `${ctx.baseUrl}/api/radar/board`, {
            method: 'POST',
            body: { title: uniqueTitle, core_angle: 'e2e test', priority: 'low' },
          });
          assert.equal(createRes.status, 200);
          assert.equal(createRes.json?.ok, true);
          boardId = createRes.json?.item?.id;
          assert.ok(Number(boardId) > 0);

          const listRes = await httpJson(ctx, `${ctx.baseUrl}/api/radar/board`);
          assert.equal(listRes.status, 200);
          assert.ok(Array.isArray(listRes.json?.items));
          assert.ok(listRes.json.items.some((it) => Number(it.id) === Number(boardId)));

          const delRes = await httpJson(ctx, `${ctx.baseUrl}/api/radar/board/${boardId}`, { method: 'DELETE' });
          assert.equal(delRes.status, 200);
          assert.equal(delRes.json?.ok, true);
          const verifyList = await httpJson(ctx, `${ctx.baseUrl}/api/radar/board`);
          assert.ok(!verifyList.json.items.some((it) => Number(it.id) === Number(boardId)));
          boardId = null;
        } finally {
          if (boardId) await cleanupBoardItem(ctx.baseUrl, boardId);
        }
      },
    },
    {
      id: 'T1-F5-05',
      feature: 'F5',
      name: 'GET /api/radar/intel/:id/detail returns full detail structure',
      async run(ctx) {
        const { items } = await pickCreatorAndContentIds(ctx);
        assert.ok(items.length >= 1);
        const res = await httpJson(ctx, `${ctx.baseUrl}/api/radar/intel/${items[0].id}/detail`);
        assert.equal(res.status, 200);
        for (const k of ['content', 'metrics', 'comments', 'analysis', 'recommendation', 'tingwuJobs', 'clusterSiblings', 'duplicates']) {
          assert.ok(k in res.json, `Missing key ${k} in intel detail`);
        }
      },
    },

    // ================= F6: SAU 本机免拖拽导入与 18910 转发接口 (5 checks) =================
    {
      id: 'T1-F6-01',
      feature: 'F6',
      name: 'GET /api/sau/status confirms sau-engine installed, running, on port 5409',
      async run(ctx) {
        const res = await httpJson(ctx, `${ctx.baseUrl}/api/sau/status`);
        assert.equal(res.status, 200);
        assert.equal(res.json?.installed, true);
        assert.equal(res.json?.running, true);
        assert.equal(res.json?.port, 5409);
      },
    },
    {
      id: 'T1-F6-02',
      feature: 'F6',
      name: 'SAU direct POST /importLocalFile imports valid synthetic .mp4 and deletes cleanly',
      async run(ctx) {
        const mp4 = createSyntheticMp4('e2e_src.mp4');
        let importedId = null;
        try {
          const res = await httpJson(ctx, `${ctx.sauUrl}/importLocalFile`, {
            method: 'POST',
            body: { filePath: mp4.filePath, filename: 'e2e_direct.mp4' },
          });
          if (isRouteMissing(res)) {
            pendingIfOffline(ctx, 'M3 sau-engine POST /importLocalFile not yet deployed');
          }
          assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${res.text}`);
          assert.equal(res.json?.code, 200);
          assert.equal(res.json?.msg, 'import success');
          assert.ok(res.json?.data?.id, 'Expected data.id');
          importedId = res.json.data.id;
          assert.ok(String(res.json.data.filepath).endsWith('_e2e_direct.mp4'));
        } finally {
          if (importedId) await cleanupSauFile(ctx.baseUrl, importedId);
          mp4.cleanup();
        }
      },
    },
    {
      id: 'T1-F6-03',
      feature: 'F6',
      name: '18910 POST /api/sau/import-local-file proxies local import and registers in /api/sau/files',
      async run(ctx) {
        const mp4 = createSyntheticMp4('e2e_proxy_src.mp4');
        let importedId = null;
        try {
          const res = await httpJson(ctx, `${ctx.baseUrl}/api/sau/import-local-file`, {
            method: 'POST',
            body: { filePath: mp4.filePath, filename: 'e2e_proxy.mp4' },
          });
          if (isRouteMissing(res)) {
            pendingIfOffline(ctx, 'M3 POST /api/sau/import-local-file not yet deployed');
          }
          assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${res.text}`);
          assert.equal(res.json?.code, 200);
          importedId = res.json?.data?.id;
          assert.ok(importedId, 'Expected imported file id');
          const listRes = await httpJson(ctx, `${ctx.baseUrl}/api/sau/files`);
          assert.equal(listRes.status, 200);
          const files = Array.isArray(listRes.json?.data) ? listRes.json.data : [];
          assert.ok(files.some((f) => Number(f.id) === Number(importedId)), 'Imported file not found in /api/sau/files');
        } finally {
          if (importedId) await cleanupSauFile(ctx.baseUrl, importedId);
          mp4.cleanup();
        }
      },
    },
    {
      id: 'T1-F6-04',
      feature: 'F6',
      name: 'POST /api/sau/import-local-file defaults filename to basename when filename is omitted',
      async run(ctx) {
        const mp4 = createSyntheticMp4('e2e_default_name.mp4');
        let importedId = null;
        try {
          const res = await httpJson(ctx, `${ctx.baseUrl}/api/sau/import-local-file`, {
            method: 'POST',
            body: { filePath: mp4.filePath },
          });
          if (isRouteMissing(res)) {
            pendingIfOffline(ctx, 'M3 POST /api/sau/import-local-file not yet deployed');
          }
          assert.equal(res.status, 200);
          importedId = res.json?.data?.id;
          assert.ok(importedId);
          assert.equal(res.json?.data?.filename, 'e2e_default_name.mp4');
        } finally {
          if (importedId) await cleanupSauFile(ctx.baseUrl, importedId);
          mp4.cleanup();
        }
      },
    },
    {
      id: 'T1-F6-05',
      feature: 'F6',
      name: 'Imported file is downloadable via GET /api/sau/file and removable via DELETE /api/sau/files/:id',
      async run(ctx) {
        const mp4 = createSyntheticMp4('e2e_download.mp4');
        let importedId = null;
        try {
          const impRes = await httpJson(ctx, `${ctx.baseUrl}/api/sau/import-local-file`, {
            method: 'POST',
            body: { filePath: mp4.filePath, filename: 'e2e_download.mp4' },
          });
          if (isRouteMissing(impRes)) {
            pendingIfOffline(ctx, 'M3 POST /api/sau/import-local-file not yet deployed');
          }
          assert.equal(impRes.status, 200);
          importedId = impRes.json?.data?.id;
          const storedPath = impRes.json?.data?.filepath;
          assert.ok(importedId && storedPath);

          const dlRes = await httpJson(ctx, `${ctx.baseUrl}/api/sau/file?filename=${encodeURIComponent(storedPath)}`);
          assert.equal(dlRes.status, 200);
          assert.equal(dlRes.buf.length, mp4.size, 'Downloaded byte length must match synthetic mp4');

          const delRes = await httpJson(ctx, `${ctx.baseUrl}/api/sau/files/${importedId}`, { method: 'DELETE' });
          assert.equal(delRes.status, 200);
          assert.equal(delRes.json?.code, 200);
          importedId = null;

          const filesAfter = await httpJson(ctx, `${ctx.baseUrl}/api/sau/files`);
          const list = Array.isArray(filesAfter.json?.data) ? filesAfter.json.data : [];
          assert.ok(!list.some((f) => Number(f.id) === Number(impRes.json.data.id)), 'Deleted file still listed');
        } finally {
          if (importedId) await cleanupSauFile(ctx.baseUrl, importedId);
          mp4.cleanup();
        }
      },
    },

    // ================= F7: 四平台完整填文案与小红书多标签修复 (5 checks) =================
    {
      id: 'T1-F7-01',
      feature: 'F7',
      name: 'POST /api/publish/ai-generate returns 4-platform copy (1..4) with title, description, #-free tags, tip',
      async run(ctx) {
        const res = await httpJson(ctx, `${ctx.baseUrl}/api/publish/ai-generate`, {
          method: 'POST',
          body: {
            script: '今天分享三个提升农资门店短视频完播率的实用脚本结构，第一条用痛点开头，第二条给田间实测对比，第三条给明确行动建议。',
          },
          timeoutMs: 90000,
        });
        if (ctx.offlineCheck && res.status === 500 && /8317|fetch|ECONNREFUSED|timeout/i.test(res.text)) {
          pendingIfOffline(ctx, `AI proxy unavailable during offline-check for publish/ai-generate: ${res.text}`);
        }
        assert.equal(res.status, 200, `ai-generate failed: ${res.text}`);
        assert.equal(res.json?.ok, true);
        const bp = res.json?.byPlatform;
        assert.ok(bp);
        for (const p of ['1', '2', '3', '4']) {
          const entry = bp[p];
          assert.ok(entry, `Missing platform ${p} in byPlatform`);
          assert.equal(typeof entry.title, 'string');
          assert.equal(typeof entry.description, 'string');
          assert.ok(Array.isArray(entry.tags));
          for (const tag of entry.tags) {
            assert.ok(!String(tag).startsWith('#'), `Tag "${tag}" must not start with #`);
          }
          assert.equal(typeof entry.tip, 'string');
        }
      },
    },
    {
      id: 'T1-F7-02',
      feature: 'F7',
      name: 'Python files pass py_compile & post_video_tencent/post_video_ks/TencentVideo accept desc param',
      async run(ctx) {
        const pyFiles = [
          'sau-engine/sau_backend.py',
          'sau-engine/myUtils/postVideo.py',
          'sau-engine/uploader/xiaohongshu_uploader/main.py',
          'sau-engine/uploader/tencent_uploader/main.py',
          'sau-engine/uploader/douyin_uploader/main.py',
          'sau-engine/uploader/ks_uploader/main.py',
        ];
        const comp = runCommandSync(PYTHON_EXE, ['-m', 'py_compile', ...pyFiles]);
        assert.equal(comp.status, 0, `py_compile failed: ${comp.stderr || comp.stdout}`);

        const sigScript = [
          'import ast, json',
          'def fn_has_arg(path, fn_name, arg_name, cls_name=None):',
          '  tree = ast.parse(open(path, "r", encoding="utf-8").read())',
          '  nodes = tree.body',
          '  if cls_name:',
          '    cls = next((n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == cls_name), None)',
          '    nodes = cls.body if cls else []',
          '  fn = next((n for n in nodes if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == fn_name), None)',
          '  if not fn: return False',
          '  names = [a.arg for a in fn.args.posonlyargs + fn.args.args + fn.args.kwonlyargs]',
          '  return arg_name in names or bool(fn.args.kwarg)',
          'print(json.dumps({',
          '  "tencent_fn": fn_has_arg("sau-engine/myUtils/postVideo.py", "post_video_tencent", "desc"),',
          '  "ks_fn": fn_has_arg("sau-engine/myUtils/postVideo.py", "post_video_ks", "desc"),',
          '  "tencent_cls": fn_has_arg("sau-engine/uploader/tencent_uploader/main.py", "__init__", "desc", "TencentVideo")',
          '}))',
        ].join('\n');
        const sigRes = runCommandSync(PYTHON_EXE, ['-c', sigScript]);
        assert.equal(sigRes.status, 0, `Python inspect failed: ${sigRes.stderr}`);
        const parsed = JSON.parse(sigRes.stdout.trim());
        if (!parsed.tencent_fn || !parsed.ks_fn || !parsed.tencent_cls) {
          pendingIfOffline(
            ctx,
            `M3 Python desc signature not yet added: ${JSON.stringify(parsed)}`
          );
        }
        assert.equal(parsed.tencent_fn, true);
        assert.equal(parsed.ks_fn, true);
        assert.equal(parsed.tencent_cls, true);
      },
    },
    {
      id: 'T1-F7-03',
      feature: 'F7',
      name: 'sau_backend.py /postVideo & /postVideoBatch forward description to all 4 platforms; invalid /post-video returns 400',
      async run(ctx) {
        // Live negative validation (no browser touched)
        const negRes = await httpJson(ctx, `${ctx.baseUrl}/api/sau/post-video`, {
          method: 'POST',
          body: { type: 3, fileList: ['nonexistent.mp4'], accountList: ['none'] },
        });
        assert.equal(negRes.status, 400, `Expected 400 for missing title, got ${negRes.status}`);

        // Static AST verification on sau_backend.py
        const astScript = [
          'import ast, json',
          "src = open('sau-engine/sau_backend.py', 'r', encoding='utf-8').read()",
          'tree = ast.parse(src)',
          'out = {}',
          'for node in tree.body:',
          '  if isinstance(node, ast.FunctionDef) and node.name in ("postVideo", "postVideoBatch"):',
          '    seg = ast.get_source_segment(src, node) or ""',
          '    out[node.name] = {',
          '      "extracts_desc": "description" in seg,',
          '      "calls_xhs": "post_video_xhs" in seg and "description" in seg.split("case 1:")[1].split("case 2:")[0],',
          '      "calls_tencent": "post_video_tencent" in seg and "description" in seg.split("case 2:")[1].split("case 3:")[0],',
          '      "calls_douyin": "post_video_DouYin" in seg and "description" in seg.split("case 3:")[1].split("case 4:")[0],',
          '      "calls_ks": "post_video_ks" in seg and "description" in seg.split("case 4:")[1].split("case _:")[0],',
          '    }',
          'print(json.dumps(out))',
        ].join('\n');
        const astRes = runCommandSync(PYTHON_EXE, ['-c', astScript]);
        assert.equal(astRes.status, 0, `AST inspection failed: ${astRes.stderr}`);
        const info = JSON.parse(astRes.stdout.trim());
        const okAll = ['postVideo', 'postVideoBatch'].every(
          (fn) =>
            info[fn]?.extracts_desc &&
            info[fn]?.calls_xhs &&
            info[fn]?.calls_tencent &&
            info[fn]?.calls_douyin &&
            info[fn]?.calls_ks
        );
        if (!okAll) {
          pendingIfOffline(ctx, `M3 sau_backend.py description forwarding not yet complete: ${JSON.stringify(info)}`);
        }
        assert.equal(okAll, true);
      },
    },
    {
      id: 'T1-F7-04',
      feature: 'F7',
      name: 'XiaoHongShu fill_tags loops up to 6 tags with try/except fallback',
      async run(ctx) {
        const script = [
          'import ast, json',
          "src = open('sau-engine/uploader/xiaohongshu_uploader/main.py', 'r', encoding='utf-8').read()",
          'tree = ast.parse(src)',
          'res = {"has_loop": False, "has_limit_6": False, "has_try_except": False}',
          'for node in ast.walk(tree):',
          '  if isinstance(node, ast.AsyncFunctionDef) and node.name == "fill_tags":',
          '    seg = ast.get_source_segment(src, node) or ""',
          '    res["has_loop"] = any(isinstance(n, ast.For) for n in ast.walk(node))',
          '    res["has_try_except"] = any(isinstance(n, ast.Try) for n in ast.walk(node))',
          '    res["has_limit_6"] = ":6" in seg or "[:6]" in seg or "range(6" in seg or ">= 6" in seg',
          'print(json.dumps(res))',
        ].join('\n');
        const r = runCommandSync(PYTHON_EXE, ['-c', script]);
        assert.equal(r.status, 0, `XHS AST check failed: ${r.stderr}`);
        const parsed = JSON.parse(r.stdout.trim());
        if (!parsed.has_loop || !parsed.has_limit_6 || !parsed.has_try_except) {
          pendingIfOffline(ctx, `M3 XHS fill_tags multi-tag loop not yet updated: ${JSON.stringify(parsed)}`);
        }
        assert.equal(parsed.has_loop && parsed.has_limit_6 && parsed.has_try_except, true);
      },
    },
    {
      id: 'T1-F7-05',
      feature: 'F7',
      name: 'Douyin safely guards empty tags and Kuaishou & Tencent handle desc before hashtags',
      async run(ctx) {
        const script = [
          'import ast, json',
          'def cls_init_has_arg(path, cls_name, arg_name):',
          '  tree = ast.parse(open(path, "r", encoding="utf-8").read())',
          '  cls = next((n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == cls_name), None)',
          '  if not cls: return False',
          '  fn = next((n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name == "__init__"), None)',
          '  if not fn: return False',
          '  names = [a.arg for a in fn.args.posonlyargs + fn.args.args + fn.args.kwonlyargs]',
          '  return arg_name in names',
          "dy_src = open('sau-engine/uploader/douyin_uploader/main.py', 'r', encoding='utf-8').read()",
          "ks_src = open('sau-engine/uploader/ks_uploader/main.py', 'r', encoding='utf-8').read()",
          "tc_src = open('sau-engine/uploader/tencent_uploader/main.py', 'r', encoding='utf-8').read()",
          'out = {',
          '  "douyin_empty_tag_guard": ("if not self.tags" in dy_src or "for tag in self.tags" in dy_src or "self.tags or []" in dy_src),',
          '  "ks_accepts_desc": cls_init_has_arg("sau-engine/uploader/ks_uploader/main.py", "KSVideo", "desc") and "self.desc" in ks_src,',
          '  "tencent_accepts_desc": cls_init_has_arg("sau-engine/uploader/tencent_uploader/main.py", "TencentVideo", "desc") and "self.desc" in tc_src,',
          '}',
          'print(json.dumps(out))',
        ].join('\n');
        const r = runCommandSync(PYTHON_EXE, ['-c', script]);
        assert.equal(r.status, 0, `Uploader inspection failed: ${r.stderr}`);
        const parsed = JSON.parse(r.stdout.trim());
        if (!parsed.ks_accepts_desc || !parsed.tencent_accepts_desc) {
          pendingIfOffline(ctx, `M3 Kuaishou/Tencent desc support not yet added: ${JSON.stringify(parsed)}`);
        }
        assert.equal(parsed.douyin_empty_tag_guard, true);
        assert.equal(parsed.ks_accepts_desc, true);
        assert.equal(parsed.tencent_accepts_desc, true);
      },
    },

    // ================= F8: 零依赖 stdio MCP 与 mcp_config.json 配置 (6 checks) =================
    {
      id: 'T1-F8-01',
      feature: 'F8',
      name: 'mcp/video-publisher-mcp.mjs passes node --check and responds to stdio JSON-RPC initialize',
      async run(ctx) {
        if (!fs.existsSync(MCP_SCRIPT_PATH)) {
          pendingIfOffline(ctx, 'M3 mcp/video-publisher-mcp.mjs does not exist yet');
        }
        const chk = runCommandSync(process.execPath, ['--check', MCP_SCRIPT_PATH]);
        assert.equal(chk.status, 0, `node --check failed: ${chk.stderr}`);

        const client = new McpStdioClient(MCP_SCRIPT_PATH, { WORKBENCH_BASE_URL: ctx.baseUrl });
        try {
          client.start();
          const resp = await client.initialize();
          assert.equal(resp.jsonrpc, '2.0');
          assert.ok(resp.result?.protocolVersion);
          assert.ok(resp.result?.capabilities?.tools);
          assert.ok(resp.result?.serverInfo?.name);
        } finally {
          await client.close();
        }
      },
    },
    {
      id: 'T1-F8-02',
      feature: 'F8',
      name: 'MCP tools/list exposes exact 5 required tools with valid inputSchema',
      async run(ctx) {
        if (!fs.existsSync(MCP_SCRIPT_PATH)) {
          pendingIfOffline(ctx, 'M3 mcp/video-publisher-mcp.mjs does not exist yet');
        }
        const client = new McpStdioClient(MCP_SCRIPT_PATH, { WORKBENCH_BASE_URL: ctx.baseUrl });
        try {
          client.start();
          await client.initialize();
          const listResp = await client.request('tools/list', {});
          const tools = listResp.result?.tools;
          assert.ok(Array.isArray(tools));
          const expected = new Set([
            'check_workbench_status',
            'list_publish_accounts',
            'prepare_publish_copy',
            'publish_video_to_platforms',
            'get_publish_history',
          ]);
          const got = new Set(tools.map((t) => t.name));
          assert.deepEqual(got, expected, `Tool set mismatch: ${[...got].join(',')}`);
          for (const t of tools) {
            assert.ok(t.inputSchema && t.inputSchema.type === 'object', `Tool ${t.name} missing object inputSchema`);
          }
        } finally {
          await client.close();
        }
      },
    },
    {
      id: 'T1-F8-03',
      feature: 'F8',
      name: 'MCP tools/call check_workbench_status reports reachable 18910 & SAU 5409 status',
      async run(ctx) {
        if (!fs.existsSync(MCP_SCRIPT_PATH)) {
          pendingIfOffline(ctx, 'M3 mcp/video-publisher-mcp.mjs does not exist yet');
        }
        const client = new McpStdioClient(MCP_SCRIPT_PATH, { WORKBENCH_BASE_URL: ctx.baseUrl });
        try {
          client.start();
          await client.initialize();
          const callResp = await client.request('tools/call', {
            name: 'check_workbench_status',
            arguments: {},
          });
          throwIfMcpOfflineOrPreM3(ctx, callResp, 'T1-F8-03 check_workbench_status');
          assert.notEqual(callResp.result?.isError, true);
          const data = parseMcpToolJson(callResp);
          const raw = JSON.stringify(data || callResp.result);
          assert.ok(/5409|running|installed/i.test(raw), 'Expected SAU status details in check_workbench_status output');
        } finally {
          await client.close();
        }
      },
    },
    {
      id: 'T1-F8-04',
      feature: 'F8',
      name: 'MCP tools/call list_publish_accounts lists platform accounts without leaking secrets',
      async run(ctx) {
        if (!fs.existsSync(MCP_SCRIPT_PATH)) {
          pendingIfOffline(ctx, 'M3 mcp/video-publisher-mcp.mjs does not exist yet');
        }
        const client = new McpStdioClient(MCP_SCRIPT_PATH, { WORKBENCH_BASE_URL: ctx.baseUrl });
        try {
          client.start();
          await client.initialize();
          const callResp = await client.request('tools/call', {
            name: 'list_publish_accounts',
            arguments: { validate: false },
          });
          throwIfMcpOfflineOrPreM3(ctx, callResp, 'T1-F8-04 list_publish_accounts');
          assert.notEqual(callResp.result?.isError, true);
          const data = parseMcpToolJson(callResp);
          const serialized = JSON.stringify(data || callResp.result);
          assert.equal(scanForSecrets(serialized, 'list_publish_accounts').length, 0);
          assert.ok(/account|douyin|kuaishou|type/i.test(serialized));
        } finally {
          await client.close();
        }
      },
    },
    {
      id: 'T1-F8-05',
      feature: 'F8',
      name: 'MCP prepare_publish_copy & get_publish_history return valid structured outputs',
      async run(ctx) {
        if (!fs.existsSync(MCP_SCRIPT_PATH)) {
          pendingIfOffline(ctx, 'M3 mcp/video-publisher-mcp.mjs does not exist yet');
        }
        const client = new McpStdioClient(MCP_SCRIPT_PATH, { WORKBENCH_BASE_URL: ctx.baseUrl });
        try {
          client.start();
          await client.initialize();
          const copyResp = await client.request('tools/call', {
            name: 'prepare_publish_copy',
            arguments: {
              title: '测试标题',
              description: '话题前简介内容',
              tags: ['干货', '效率'],
            },
          });
          throwIfMcpOfflineOrPreM3(ctx, copyResp, 'T1-F8-05 prepare_publish_copy');
          assert.notEqual(copyResp.result?.isError, true);
          const copyText = JSON.stringify(parseMcpToolJson(copyResp) || copyResp.result);
          assert.ok(copyText.includes('测试标题'));
          assert.ok(copyText.includes('话题前简介内容'));

          const histResp = await client.request('tools/call', {
            name: 'get_publish_history',
            arguments: { limit: 5 },
          });
          throwIfMcpOfflineOrPreM3(ctx, histResp, 'T1-F8-05 get_publish_history');
          assert.notEqual(histResp.result?.isError, true);
          const histData = parseMcpToolJson(histResp);
          assert.ok(histData && (Array.isArray(histData.records) || Array.isArray(histData.data) || Array.isArray(histData)));
        } finally {
          await client.close();
        }
      },
    },
    {
      id: 'T1-F8-06',
      feature: 'F8',
      name: 'mcp_config.json registers video_publisher & MCP publish_video_to_platforms(dryRun=true) simulates safely',
      async run(ctx) {
        if (!fs.existsSync(MCP_SCRIPT_PATH)) {
          pendingIfOffline(ctx, 'M3 mcp/video-publisher-mcp.mjs does not exist yet');
        }
        const cfg = JSON.parse(fs.readFileSync(MCP_CONFIG_PATH, 'utf8'));
        const vp = cfg?.mcpServers?.video_publisher;
        if (!vp) {
          pendingIfOffline(ctx, 'M3 video_publisher entry not yet added to mcp_config.json');
        }
        assert.match(String(vp.command), /node\.exe$/i);
        assert.ok(Array.isArray(vp.args) && vp.args.some((a) => /video-publisher-mcp\.mjs$/i.test(String(a))));

        const mp4 = createSyntheticMp4('e2e_mcp_dry.mp4');
        const client = new McpStdioClient(MCP_SCRIPT_PATH, { WORKBENCH_BASE_URL: ctx.baseUrl });
        try {
          client.start();
          await client.initialize();
          const pubResp = await client.request('tools/call', {
            name: 'publish_video_to_platforms',
            arguments: {
              dryRun: true,
              filePath: mp4.filePath,
              platforms: [3, 4],
              title: 'MCP 安全试发测试标题',
              description: '话题前简介测试',
              tags: ['农业', '效率'],
            },
          });
          throwIfMcpOfflineOrPreM3(ctx, pubResp, 'T1-F8-06 publish_video_to_platforms');
          assert.notEqual(pubResp.result?.isError, true);
          const data = parseMcpToolJson(pubResp);
          const raw = JSON.stringify(data || pubResp.result);
          assert.ok(/dryRun|dry_run|simulated|预览|试发/i.test(raw), 'Expected dryRun simulation marker in output');
        } finally {
          await client.close();
          mp4.cleanup();
        }
      },
    },

    // ================= F9: Antigravity video-auto-publisher 技能与体检门禁 (5 checks) =================
    {
      id: 'T1-F9-01',
      feature: 'F9',
      name: 'SKILL.md exists with valid YAML frontmatter (name: video-auto-publisher, description <=1024)',
      async run(ctx) {
        if (!fs.existsSync(SKILL_MD_PATH)) {
          pendingIfOffline(ctx, 'M4 C:\\Users\\win10\\.gemini\\config\\skills\\video-auto-publisher\\SKILL.md not created yet');
        }
        const md = fs.readFileSync(SKILL_MD_PATH, 'utf8');
        const parsed = parseSkillFrontmatter(md);
        assert.equal(parsed.valid, true, parsed.reason);
        assert.equal(parsed.fields.name, 'video-auto-publisher');
        const desc = parsed.fields.description || '';
        assert.ok(desc.length > 0 && desc.length <= 1024);
        assert.ok(!/[<>]/.test(desc), 'description must not contain < or >');
      },
    },
    {
      id: 'T1-F9-02',
      feature: 'F9',
      name: 'SKILL.md documents MCP-first + 18910 HTTP fallback, account validation, and 4-platform copy splitting',
      async run(ctx) {
        if (!fs.existsSync(SKILL_MD_PATH)) {
          pendingIfOffline(ctx, 'M4 SKILL.md not created yet');
        }
        const md = fs.readFileSync(SKILL_MD_PATH, 'utf8');
        assert.ok(md.includes('video_publisher'), 'Must mention video_publisher MCP');
        assert.ok(md.includes('18910'), 'Must mention 18910 HTTP fallback');
        assert.ok(/账号|account/i.test(md), 'Must mention account validation');
        for (const plat of ['抖音', '小红书', '微信视频号', '快手']) {
          assert.ok(md.includes(plat), `Must document platform ${plat}`);
        }
        assert.ok(/标题/.test(md) && /标签/.test(md) && (/简介|description/i.test(md)));
      },
    },
    {
      id: 'T1-F9-03',
      feature: 'F9',
      name: 'SKILL.md documents confirmation guard ("直接发" bypass) & immediate/draft/scheduled modes',
      async run(ctx) {
        if (!fs.existsSync(SKILL_MD_PATH)) {
          pendingIfOffline(ctx, 'M4 SKILL.md not created yet');
        }
        const md = fs.readFileSync(SKILL_MD_PATH, 'utf8');
        assert.ok(md.includes('直接发'), 'Must document "直接发" confirmation bypass rule');
        assert.ok(/确认/.test(md), 'Must require user confirmation by default');
        assert.ok(/草稿|isDraft/i.test(md), 'Must document draft option');
        assert.ok(/定时|enableTimer/i.test(md), 'Must document scheduled publish option');
      },
    },
    {
      id: 'T1-F9-04',
      feature: 'F9',
      name: 'skill-doctor audit passes with Exit Code 0, Level A PASS, zero Critical issues',
      async run(ctx) {
        if (!fs.existsSync(SKILL_MD_PATH)) {
          pendingIfOffline(ctx, 'M4 skill directory not created yet');
        }
        const res = runCommandSync(PYTHON_EXE, [SKILL_DOCTOR_SCRIPT, 'audit', SKILL_DIR, '--json', '--no-cache']);
        assert.equal(res.status, 0, `doctor.py exited ${res.status}: ${res.stdout}\n${res.stderr}`);
        const jsonReport = JSON.parse(res.stdout);
        assert.equal(
          jsonReport.summary?.level_matrix?.level_a_format,
          'PASS',
          `Expected summary.level_matrix.level_a_format === 'PASS', got: ${JSON.stringify(jsonReport.summary?.level_matrix)}`
        );
        assert.equal(jsonReport.summary?.critical_count, 0, 'Expected critical_count === 0');
      },
    },
    {
      id: 'T1-F9-05',
      feature: 'F9',
      name: 'Any helper scripts under skill scripts/ pass py_compile / node --check',
      async run(ctx) {
        if (!fs.existsSync(SKILL_MD_PATH)) {
          pendingIfOffline(ctx, 'M4 skill directory not created yet');
        }
        const scriptsDir = path.join(SKILL_DIR, 'scripts');
        if (!fs.existsSync(scriptsDir)) return; // optional per spec
        const pyFiles = listFilesRecursive(scriptsDir, (f) => f.endsWith('.py'));
        const jsFiles = listFilesRecursive(scriptsDir, (f) => /\.(mjs|js)$/.test(f));
        if (pyFiles.length > 0) {
          const r = runCommandSync(PYTHON_EXE, ['-m', 'py_compile', ...pyFiles]);
          assert.equal(r.status, 0, `Skill script py_compile failed: ${r.stderr}`);
        }
        for (const jf of jsFiles) {
          const r = runCommandSync(process.execPath, ['--check', jf]);
          assert.equal(r.status, 0, `Skill script node --check failed (${jf}): ${r.stderr}`);
        }
      },
    },

    // ================= F10: 既有架构兼容、浅色 UI 规范与安全底线 (5 checks) =================
    {
      id: 'T1-F10-01',
      feature: 'F10',
      name: 'Core health & legacy endpoints return HTTP 200 without errors',
      async run(ctx) {
        const endpoints = [
          '/api/health',
          '/api/overview',
          '/api/sources',
          '/api/contents?limit=5',
          '/api/tasks',
          '/api/radar/cockpit',
        ];
        for (const ep of endpoints) {
          const res = await httpJson(ctx, `${ctx.baseUrl}${ep}`);
          assert.equal(res.status, 200, `${ep} returned ${res.status}`);
        }
        const h = await httpJson(ctx, `${ctx.baseUrl}/api/health`);
        assert.equal(h.json?.ok, true);
        const ov = await httpJson(ctx, `${ctx.baseUrl}/api/overview`);
        assert.ok(ov.json?.stats);
      },
    },
    {
      id: 'T1-F10-02',
      feature: 'F10',
      name: 'Built SPA / serves HTML with #root and reachable /assets/*.js & /assets/*.css',
      async run(ctx) {
        const res = await httpJson(ctx, `${ctx.baseUrl}/`);
        assert.equal(res.status, 200);
        assert.ok(/text\/html/i.test(res.headers.get('content-type') || ''));
        assert.ok(res.text.includes('<div id="root">'));
        const assetMatches = [...res.text.matchAll(/(?:src|href)=["'](\/assets\/[^"']+)["']/g)].map((m) => m[1]);
        assert.ok(assetMatches.length >= 1, 'Expected at least 1 built asset reference in index.html');
        for (const asset of assetMatches) {
          const aRes = await httpJson(ctx, `${ctx.baseUrl}${asset}`);
          if (aRes.status === 404 && ctx.offlineCheck) {
            const diskAsset = path.join(PROJECT_ROOT, 'frontend', 'dist', asset.replace(/^\/+/, ''));
            if (fs.existsSync(diskAsset)) {
              pendingIfOffline(
                ctx,
                `frontend/dist rebuilt (${asset} exists on disk); live 18910 needs restart to serve updated assets`
              );
            }
          }
          assert.equal(aRes.status, 200, `Asset ${asset} returned ${aRes.status}`);
        }
      },
    },
    {
      id: 'T1-F10-03',
      feature: 'F10',
      name: 'Frontend styles.css & dist assets comply with light theme and forbid border-left: 3px & nested bordered cards',
      async run() {
        const scan = scanCssCompliance(PROJECT_ROOT);
        assert.equal(scan.lightVarsPresent, true, 'Light theme variables (--bg, --surface) missing');
        assert.deepEqual(scan.violations, [], `CSS violations: ${scan.violations.join('; ')}`);
      },
    },
    {
      id: 'T1-F10-04',
      feature: 'F10',
      name: 'Settings, browsers & SAU account endpoints mask API keys and never leak raw cookies',
      async run(ctx) {
        const [setRes, brRes, accRes] = await Promise.all([
          httpJson(ctx, `${ctx.baseUrl}/api/settings`),
          httpJson(ctx, `${ctx.baseUrl}/api/browsers`),
          httpJson(ctx, `${ctx.baseUrl}/api/sau/accounts`),
        ]);
        assert.equal(setRes.status, 200);
        const keyVal = setRes.json?.settings?.ai_api_key;
        assert.ok(keyVal === undefined || keyVal === '' || keyVal === '********', 'ai_api_key must be masked');
        assert.equal(brRes.status, 200);
        assert.equal(accRes.status, 200);

        for (const [lbl, txt] of [
          ['/api/settings', setRes.text],
          ['/api/browsers', brRes.text],
          ['/api/sau/accounts', accRes.text],
        ]) {
          const leaks = scanForSecrets(txt, lbl);
          assert.deepEqual(leaks, [], `Secret leak detected: ${leaks.join('; ')}`);
        }
      },
    },
    {
      id: 'T1-F10-05',
      feature: 'F10',
      name: 'Legacy SAU endpoints return 200 and mcp_config.json backup exists alongside mcp_config.json',
      async run(ctx) {
        for (const ep of ['/api/sau/files', '/api/sau/publish-history', '/api/sau/title-templates']) {
          const res = await httpJson(ctx, `${ctx.baseUrl}${ep}`);
          assert.equal(res.status, 200, `${ep} returned ${res.status}`);
          assert.equal(res.json?.code, 200);
        }
        assert.equal(fs.existsSync(MCP_CONFIG_PATH), true, `Missing mcp_config.json at ${MCP_CONFIG_PATH}`);
        const cfg = JSON.parse(fs.readFileSync(MCP_CONFIG_PATH, 'utf8'));
        const hasVideoPublisher = Boolean(cfg?.mcpServers?.video_publisher);
        const cfgDir = path.dirname(MCP_CONFIG_PATH);
        const freshCutoffMs = Date.parse('2026-11-28T00:00:00Z');
        const backups = fs.existsSync(cfgDir)
          ? fs
              .readdirSync(cfgDir)
              .filter((f) => /^mcp_config\.json\.bak/i.test(f))
              .map((f) => {
                const full = path.join(cfgDir, f);
                const stat = fs.statSync(full);
                const text = fs.readFileSync(full, 'utf8');
                return {
                  name: f,
                  freshMs: Math.max(stat.mtimeMs, stat.birthtimeMs || 0),
                  hasVideoPublisher: text.includes('video_publisher'),
                };
              })
          : [];

        if (!hasVideoPublisher) {
          const hasFreshBackup = backups.some((b) => b.freshMs >= freshCutoffMs);
          if (!hasFreshBackup) {
            pendingIfOffline(ctx, 'M3 mcp_config.json video_publisher & fresh .bak* backup not yet created');
          }
        } else {
          const freshPreEditBackup = backups.some((b) => b.freshMs >= freshCutoffMs && !b.hasVideoPublisher);
          assert.ok(
            freshPreEditBackup,
            `Expected fresh pre-M3 mcp_config.json.bak* (>= 2026-11-28, without video_publisher); found: ${backups.map((b) => b.name).join(', ')}`
          );
        }
      },
    },
  ];
}
