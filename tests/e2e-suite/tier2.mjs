import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
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
  createTempPathWithExtension,
  httpJson,
  isFastifyRouteNotFound,
  isM1Deployed,
  isM3ImportDeployed,
  isRouteMissing,
  listFilesRecursive,
  parseMcpToolJson,
  parseSkillFrontmatter,
  pendingIfOffline,
  pickCreatorAndContentIds,
  runCommandSync,
  scanCssCompliance,
  scanForSecrets,
} from './lib/helpers.mjs';

export function getTier2Checks() {
  return [
    // ================= F1 Boundaries (5 checks) =================
    {
      id: 'T2-F1-01',
      feature: 'F1',
      name: 'Feed default excludes RSS while ?includeRss=1 includes RSS source items',
      async run(ctx) {
        const defRes = await httpJson(ctx, `${ctx.baseUrl}/api/radar/creators/feed?days=0&limit=100`);
        assert.equal(defRes.status, 200);
        if (!defRes.json?.todayUpdates || typeof defRes.json?.total !== 'number') {
          pendingIfOffline(ctx, 'M1 feed includeRss / total behavior not yet deployed');
        }
        const rssRes = await httpJson(ctx, `${ctx.baseUrl}/api/radar/creators/feed?days=0&limit=100&includeRss=1`);
        assert.equal(rssRes.status, 200);
        const defCreatorTypes = new Set(defRes.json.creators.map((c) => c.source_type));
        assert.ok(!defCreatorTypes.has('rss'), 'Default feed must exclude source_type=rss');

        const srcRes = await httpJson(ctx, `${ctx.baseUrl}/api/sources`);
        const hasRssSource = Array.isArray(srcRes.json) && srcRes.json.some((s) => s.source_type === 'rss');
        if (hasRssSource) {
          assert.ok(rssRes.json.total > defRes.json.total, 'total(includeRss=1) must exceed total(includeRss=0)');
        }
      },
    },
    {
      id: 'T2-F1-02',
      feature: 'F1',
      name: 'Explicit ?includeRss=0 excludes RSS across creators, todayUpdates, todayLeaderboard, and items',
      async run(ctx) {
        const res = await httpJson(ctx, `${ctx.baseUrl}/api/radar/creators/feed?includeRss=0&days=0&limit=50`);
        assert.equal(res.status, 200);
        if (!res.json?.todayUpdates || !res.json?.todayLeaderboard) {
          pendingIfOffline(ctx, 'M1 todayUpdates/todayLeaderboard not yet deployed');
        }
        for (const c of res.json.creators) {
          assert.notEqual(c.source_type, 'rss');
        }
        const allowedIds = new Set(res.json.creators.map((c) => Number(c.id)));
        for (const list of [res.json.items, res.json.todayUpdates.items, res.json.todayLeaderboard.items]) {
          for (const it of list) {
            assert.ok(allowedIds.has(Number(it.source_id)), `Non-creator item ${it.id} (source=${it.source_id}) leaked`);
          }
        }
      },
    },
    {
      id: 'T2-F1-03',
      feature: 'F1',
      name: 'todayUpdates handles both todayCount === 0 fallback and todayCount > 0 live updates cleanly',
      async run(ctx) {
        const res = await httpJson(ctx, `${ctx.baseUrl}/api/radar/creators/feed`);
        assert.equal(res.status, 200);
        const tu = res.json?.todayUpdates;
        if (!tu) {
          pendingIfOffline(ctx, 'M1 todayUpdates not yet deployed');
        }
        if (tu.todayCount === 0) {
          assert.equal(tu.hasTodayNew, false);
          if (res.json.creators.some((c) => Number(c.content_count) > 0)) {
            assert.ok(tu.items.length >= 1, 'Expected fallback latest per-creator updates when todayCount === 0');
          }
        } else {
          assert.equal(tu.hasTodayNew, true);
          assert.ok(tu.items.length >= 1);
        }
      },
    },
    {
      id: 'T2-F1-04',
      feature: 'F1',
      name: 'Feed ?search=__NO_SUCH_TERM_XYZ_999__ returns empty items without 500 error',
      async run(ctx) {
        const res = await httpJson(
          ctx,
          `${ctx.baseUrl}/api/radar/creators/feed?search=${encodeURIComponent('__NO_SUCH_TERM_XYZ_999__')}`
        );
        assert.equal(res.status, 200);
        if (typeof res.json?.total !== 'number' || typeof res.json?.hasMore !== 'boolean') {
          pendingIfOffline(ctx, 'M1 feed search not yet deployed');
        }
        assert.deepEqual(res.json.items, []);
        assert.equal(res.json.total, 0);
        assert.equal(res.json.hasMore, false);
        assert.ok(Array.isArray(res.json.creators));
      },
    },
    {
      id: 'T2-F1-05',
      feature: 'F1',
      name: 'Feed ?creatorId=999999 returns empty items cleanly without 500 error',
      async run(ctx) {
        const res = await httpJson(ctx, `${ctx.baseUrl}/api/radar/creators/feed?creatorId=999999&days=0`);
        assert.equal(res.status, 200);
        if (typeof res.json?.total !== 'number' || typeof res.json?.hasMore !== 'boolean') {
          pendingIfOffline(ctx, 'M1 feed total/hasMore not yet deployed');
        }
        assert.deepEqual(res.json.items, []);
        assert.equal(res.json.total, 0);
        assert.equal(res.json.hasMore, false);
      },
    },

    // ================= F2 Boundaries (5 checks) =================
    {
      id: 'T2-F2-01',
      feature: 'F2',
      name: 'todayLeaderboard fallbackLabel & isFallback align with todayCount === 0 vs > 0',
      async run(ctx) {
        const res = await httpJson(ctx, `${ctx.baseUrl}/api/radar/creators/feed`);
        assert.equal(res.status, 200);
        const tu = res.json?.todayUpdates;
        const lb = res.json?.todayLeaderboard;
        if (!tu || !lb) {
          pendingIfOffline(ctx, 'M1 todayUpdates/todayLeaderboard not yet deployed');
        }
        if (tu.todayCount === 0) {
          assert.equal(lb.isFallback, true);
          assert.ok(typeof lb.fallbackLabel === 'string' && lb.fallbackLabel.trim().length > 0);
          assert.ok(lb.items.length >= 1, 'Expected fallback leaderboard items when todayCount === 0');
        } else {
          assert.equal(lb.isFallback, false);
          assert.ok(lb.items.length >= 1);
        }
      },
    },
    {
      id: 'T2-F2-02',
      feature: 'F2',
      name: 'Douyin items with latest_views === null produce finite heatScore >= 0 and clean heatBasis (no NaN)',
      async run(ctx) {
        const res = await httpJson(ctx, `${ctx.baseUrl}/api/radar/creators/feed?days=0&limit=50`);
        assert.equal(res.status, 200);
        const lb = res.json?.todayLeaderboard;
        const tu = res.json?.todayUpdates;
        if (!lb || !tu) {
          pendingIfOffline(ctx, 'M1 todayLeaderboard not yet deployed');
        }
        const creators = Array.isArray(res.json?.creators) ? res.json.creators : [];
        const allItems = Array.isArray(res.json?.items) ? res.json.items : [];
        const hasDouyinCreator =
          creators.some((c) => c.platform === 'douyin' && Number(c.content_count) > 0) ||
          allItems.some((it) => it.platform === 'douyin' || it.latest_views === null);

        const douyinInFeed = allItems.filter((it) => it.platform === 'douyin' || it.latest_views === null);
        const douyinInLb = lb.items.filter((it) => it.platform === 'douyin' || it.latest_views === null);
        if (hasDouyinCreator) {
          assert.ok(
            douyinInFeed.length >= 1,
            'Expected at least one Douyin / latest_views===null creator item in feed.items when Douyin creator exists'
          );
          const douyinInTodayUpdates = (tu.items || []).some(
            (it) => it.platform === 'douyin' || it.latest_views === null
          );
          const douyinExpectedInLb =
            (tu.todayCount > 0 && douyinInTodayUpdates) ||
            (lb.isFallback === true && /历史/.test(String(lb.fallbackLabel || '')));
          if (douyinExpectedInLb) {
            assert.ok(
              douyinInLb.length >= 1,
              'Expected at least one Douyin / latest_views===null item in todayLeaderboard.items'
            );
          }
        }
        for (const it of lb.items) {
          assert.equal(typeof it.heatScore, 'number');
          assert.ok(Number.isFinite(it.heatScore) && it.heatScore >= 0, `Invalid heatScore: ${it.heatScore}`);
          assert.ok(typeof it.heatBasis === 'string' && it.heatBasis.trim().length > 0, 'heatBasis must be non-empty');
          assert.ok(!/NaN|undefined|null/i.test(String(it.heatBasis)), `Bad heatBasis: ${it.heatBasis}`);
        }
      },
    },
    {
      id: 'T2-F2-03',
      feature: 'F2',
      name: 'Zero RSS items appear in todayLeaderboard.items',
      async run(ctx) {
        const [feedRes, srcRes] = await Promise.all([
          httpJson(ctx, `${ctx.baseUrl}/api/radar/creators/feed`),
          httpJson(ctx, `${ctx.baseUrl}/api/sources`),
        ]);
        assert.equal(feedRes.status, 200);
        const lb = feedRes.json?.todayLeaderboard;
        if (!lb) {
          pendingIfOffline(ctx, 'M1 todayLeaderboard not yet deployed');
        }
        const rssIds = new Set((srcRes.json || []).filter((s) => s.source_type === 'rss').map((s) => Number(s.id)));
        for (const it of lb.items) {
          assert.ok(!rssIds.has(Number(it.source_id)), `RSS item ${it.id} leaked into todayLeaderboard`);
        }
      },
    },
    {
      id: 'T2-F2-04',
      feature: 'F2',
      name: 'GET /api/radar/creators/leaderboard?onlyBreakout=true&days=1 returns 200 { items }',
      async run(ctx) {
        const res = await httpJson(ctx, `${ctx.baseUrl}/api/radar/creators/leaderboard?onlyBreakout=true&days=1`);
        assert.equal(res.status, 200);
        assert.ok(Array.isArray(res.json?.items));
      },
    },
    {
      id: 'T2-F2-05',
      feature: 'F2',
      name: 'GET /api/radar/creators/leaderboard clamps extreme limit=0 and limit=500 safely',
      async run(ctx) {
        for (const limit of [0, 500]) {
          const res = await httpJson(ctx, `${ctx.baseUrl}/api/radar/creators/leaderboard?limit=${limit}`);
          assert.equal(res.status, 200, `limit=${limit} returned ${res.status}`);
          assert.ok(Array.isArray(res.json?.items));
        }
      },
    },

    // ================= F3 Boundaries (5 checks) =================
    {
      id: 'T2-F3-01',
      feature: 'F3',
      name: 'POST /api/radar/intel/999999/r2-analyze returns controlled 4xx/5xx JSON { error }',
      async run(ctx) {
        const res = await httpJson(ctx, `${ctx.baseUrl}/api/radar/intel/999999/r2-analyze`, {
          method: 'POST',
          body: {},
        });
        if (isFastifyRouteNotFound(res) || (isRouteMissing(res) && !(await isM1Deployed(ctx)))) {
          pendingIfOffline(ctx, 'M1 POST /api/radar/intel/:id/r2-analyze not yet deployed');
        }
        assert.ok(!isFastifyRouteNotFound(res), 'r2-analyze route is not registered');
        assert.ok(res.status >= 400 && res.status < 600);
        assert.ok(res.json && typeof res.json.error === 'string' && res.json.error.length > 0);
      },
    },
    {
      id: 'T2-F3-02',
      feature: 'F3',
      name: 'POST /api/radar/intel/:id/r2-analyze on Douyin item (views=null) completes cleanly without fabricating views',
      async run(ctx) {
        const { douyinItems, items } = await pickCreatorAndContentIds(ctx);
        const target = douyinItems[0] || items[0];
        assert.ok(target);
        const res = await httpJson(ctx, `${ctx.baseUrl}/api/radar/intel/${target.id}/r2-analyze`, {
          method: 'POST',
          body: { force: false },
          timeoutMs: 90000,
        });
        if (isRouteMissing(res)) {
          pendingIfOffline(ctx, 'M1 POST /api/radar/intel/:id/r2-analyze not yet deployed');
        }
        assert.equal(res.status, 200, `Douyin r2-analyze failed: ${res.text}`);
        assert.equal(res.json?.ok, true);
        const a = res.json?.analysis;
        assert.ok(a && typeof a.basisSource === 'string' && a.basisSource.length > 0);
        assert.ok(typeof a.heatVerdict === 'string' && a.heatVerdict.length > 0);
      },
    },
    {
      id: 'T2-F3-03',
      feature: 'F3',
      name: 'POST /api/radar/creators/compare-remix handles { contentIds: [] } fallback and empty { creatorId: 999999 } gracefully without 500 crash',
      async run(ctx) {
        const res = await httpJson(ctx, `${ctx.baseUrl}/api/radar/creators/compare-remix`, {
          method: 'POST',
          body: { contentIds: [] },
          timeoutMs: 90000,
        });
        if (isRouteMissing(res)) {
          pendingIfOffline(ctx, 'M1 POST /api/radar/creators/compare-remix not yet deployed');
        }
        assert.ok(res.status === 400 || res.status === 200, `Unexpected status ${res.status}`);
        if (res.status === 200) {
          assert.equal(res.json?.ok, true);
          const rankings = res.json?.rankings;
          assert.ok(Array.isArray(rankings));
          if (rankings.length === 0) {
            assert.equal(res.json?.bestContentId, null);
          } else {
            assert.equal(res.json?.bestContentId, rankings[0].contentId);
          }
        } else {
          assert.ok(res.json?.error);
        }

        const emptyPoolRes = await httpJson(ctx, `${ctx.baseUrl}/api/radar/creators/compare-remix`, {
          method: 'POST',
          body: { creatorId: 999999 },
          timeoutMs: 30000,
        });
        assert.equal(emptyPoolRes.status, 200, `Expected 200 for nonexistent creatorId pool, got ${emptyPoolRes.status}`);
        assert.equal(emptyPoolRes.json?.ok, true);
        assert.equal(emptyPoolRes.json?.bestContentId, null);
        assert.deepEqual(emptyPoolRes.json?.rankings, []);
      },
    },
    {
      id: 'T2-F3-04',
      feature: 'F3',
      name: 'POST /api/radar/creators/compare-remix with single item [id] returns 400 or 200 with 1 ranking (no 500)',
      async run(ctx) {
        const { items } = await pickCreatorAndContentIds(ctx);
        assert.ok(items.length >= 1);
        const res = await httpJson(ctx, `${ctx.baseUrl}/api/radar/creators/compare-remix`, {
          method: 'POST',
          body: { contentIds: [items[0].id] },
          timeoutMs: 90000,
        });
        if (isRouteMissing(res)) {
          pendingIfOffline(ctx, 'M1 POST /api/radar/creators/compare-remix not yet deployed');
        }
        assert.ok(res.status === 400 || res.status === 200, `Unexpected status ${res.status}: ${res.text}`);
        if (res.status === 200) {
          assert.ok(Array.isArray(res.json?.rankings) && res.json.rankings.length === 1);
        }
      },
    },
    {
      id: 'T2-F3-05',
      feature: 'F3',
      name: 'Repeated POST /api/radar/intel/:id/r2-analyze with force=false uses cache consistently',
      async run(ctx) {
        const { biliItems, items } = await pickCreatorAndContentIds(ctx);
        const target = biliItems[0] || items[0];
        const r1 = await httpJson(ctx, `${ctx.baseUrl}/api/radar/intel/${target.id}/r2-analyze`, {
          method: 'POST',
          body: { force: false },
          timeoutMs: 90000,
        });
        if (isRouteMissing(r1)) {
          pendingIfOffline(ctx, 'M1 POST /api/radar/intel/:id/r2-analyze not yet deployed');
        }
        assert.equal(r1.status, 200);
        const r2 = await httpJson(ctx, `${ctx.baseUrl}/api/radar/intel/${target.id}/r2-analyze`, {
          method: 'POST',
          body: { force: false },
          timeoutMs: 30000,
        });
        assert.equal(r2.status, 200);
        assert.equal(r2.json.analysis.contentId, r1.json.analysis.contentId);
        assert.equal(r2.json.analysis.whatItSays, r1.json.analysis.whatItSays);
        assert.equal(r2.json.analysis.heatVerdict, r1.json.analysis.heatVerdict);
        assert.equal(r2.json.analysis.remixSuitability, r1.json.analysis.remixSuitability);
      },
    },

    // ================= F4 Boundaries (5 checks) =================
    {
      id: 'T2-F4-01',
      feature: 'F4',
      name: 'Pagination beyond 30 items (?days=0&offset=30&limit=30) returns remaining creator items',
      async run(ctx) {
        const res = await httpJson(ctx, `${ctx.baseUrl}/api/radar/creators/feed?days=0&offset=30&limit=30`);
        assert.equal(res.status, 200);
        if (typeof res.json?.offset !== 'number' || typeof res.json?.total !== 'number') {
          pendingIfOffline(ctx, 'M1 offset/total pagination not yet deployed');
        }
        assert.equal(res.json.offset, 30);
        if (res.json.total > 30) {
          assert.ok(res.json.items.length >= Math.min(30, res.json.total - 30));
          assert.equal(res.json.hasMore, res.json.total > 60);
        }
      },
    },
    {
      id: 'T2-F4-02',
      feature: 'F4',
      name: 'Extreme limit=9999 is safely capped (<= 200) without error',
      async run(ctx) {
        const res = await httpJson(ctx, `${ctx.baseUrl}/api/radar/creators/feed?days=0&limit=9999`);
        assert.equal(res.status, 200);
        if (typeof res.json?.limit !== 'number') {
          pendingIfOffline(ctx, 'M1 limit field not yet deployed on feed');
        }
        assert.ok(res.json.limit <= 200 && res.json.limit >= 1, `Expected limit <= 200, got ${res.json.limit}`);
      },
    },
    {
      id: 'T2-F4-03',
      feature: 'F4',
      name: 'Out-of-range offset=99999 returns empty items and hasMore=false',
      async run(ctx) {
        const res = await httpJson(ctx, `${ctx.baseUrl}/api/radar/creators/feed?days=0&offset=99999&limit=30`);
        assert.equal(res.status, 200);
        if (typeof res.json?.hasMore !== 'boolean' || typeof res.json?.offset !== 'number') {
          pendingIfOffline(ctx, 'M1 offset/hasMore not yet deployed on feed');
        }
        assert.deepEqual(res.json.items, []);
        assert.equal(res.json.hasMore, false);
      },
    },
    {
      id: 'T2-F4-04',
      feature: 'F4',
      name: 'Negative pagination (?days=0&offset=-5&limit=-10) is clamped safely',
      async run(ctx) {
        const res = await httpJson(ctx, `${ctx.baseUrl}/api/radar/creators/feed?days=0&offset=-5&limit=-10`);
        assert.equal(res.status, 200);
        if (typeof res.json?.offset !== 'number' || typeof res.json?.limit !== 'number') {
          pendingIfOffline(ctx, 'M1 offset/limit clamping not yet deployed on feed');
        }
        assert.ok(res.json.offset >= 0);
        assert.ok(res.json.limit >= 1);
        assert.ok(res.json.items.length >= 1);
      },
    },
    {
      id: 'T2-F4-05',
      feature: 'F4',
      name: 'All creator items (?days=0&limit=200) obey COALESCE(published_at, discovered_at) DESC, id DESC tie-breaker',
      async run(ctx) {
        const res = await httpJson(ctx, `${ctx.baseUrl}/api/radar/creators/feed?days=0&limit=200`);
        assert.equal(res.status, 200);
        assert.ok(Array.isArray(res.json?.items) && res.json.items.length >= 2);
        assertSortedNewestFirst(res.json.items, 'full_history_200');
      },
    },
    {
      id: 'T2-F4-06',
      feature: 'F4',
      name: 'POST /api/radar/creators/999999/fetch-history returns 404 & invalid id abc returns 400',
      async run(ctx) {
        const res404 = await httpJson(ctx, `${ctx.baseUrl}/api/radar/creators/999999/fetch-history`, {
          method: 'POST',
          body: { maxPages: 1 },
        });
        if (isFastifyRouteNotFound(res404) || (isRouteMissing(res404) && !(await isM1Deployed(ctx)))) {
          pendingIfOffline(ctx, 'M1 POST /api/radar/creators/:id/fetch-history not yet deployed');
        }
        assert.ok(!isFastifyRouteNotFound(res404), 'fetch-history route is not registered');
        assert.equal(res404.status, 404, `Expected 404 for nonexistent creator, got ${res404.status}`);
        assert.ok(res404.json?.error);

        const res400 = await httpJson(ctx, `${ctx.baseUrl}/api/radar/creators/abc/fetch-history`, {
          method: 'POST',
          body: { maxPages: 1 },
        });
        assert.equal(res400.status, 400, `Expected 400 for non-numeric creator id, got ${res400.status}`);
        assert.ok(res400.json?.error);
      },
    },

    // ================= F5 Boundaries (5 checks) =================
    {
      id: 'T2-F5-01',
      feature: 'F5',
      name: 'POST /api/radar/intel/999999/comments/topics returns controlled 404/400 error',
      async run(ctx) {
        const res = await httpJson(ctx, `${ctx.baseUrl}/api/radar/intel/999999/comments/topics`, {
          method: 'POST',
          body: { autoCrawl: false },
        });
        if (isFastifyRouteNotFound(res) || (isRouteMissing(res) && !(await isM1Deployed(ctx)))) {
          pendingIfOffline(ctx, 'M1 POST /api/radar/intel/:id/comments/topics not yet deployed');
        }
        assert.ok(!isFastifyRouteNotFound(res), 'comments/topics route is not registered');
        assert.ok(res.status === 404 || res.status === 400);
        assert.ok(res.json?.error);
      },
    },
    {
      id: 'T2-F5-02',
      feature: 'F5',
      name: 'POST /api/radar/intel/:id/comments/topics with { autoCrawl: false } on 0-comment item does not hallucinate topics',
      async run(ctx) {
        const { items } = await pickCreatorAndContentIds(ctx);
        let zeroCommentItem = null;
        for (const cand of items.slice(0, 15)) {
          const det = await httpJson(ctx, `${ctx.baseUrl}/api/radar/intel/${cand.id}/detail`);
          if (det.status === 200 && Array.isArray(det.json?.comments) && det.json.comments.length === 0) {
            zeroCommentItem = cand;
            break;
          }
        }
        assert.ok(zeroCommentItem, 'Expected at least 1 creator item with 0 stored comments');
        const res = await httpJson(ctx, `${ctx.baseUrl}/api/radar/intel/${zeroCommentItem.id}/comments/topics`, {
          method: 'POST',
          body: { autoCrawl: false },
        });
        if (isRouteMissing(res)) {
          pendingIfOffline(ctx, 'M1 POST /api/radar/intel/:id/comments/topics not yet deployed');
        }
        assert.ok(res.status === 200 || res.status === 400, `Unexpected status ${res.status}`);
        if (res.status === 200) {
          assert.equal(res.json?.commentsCount, 0);
          assert.deepEqual(res.json?.topics, []);
        }
      },
    },
    {
      id: 'T2-F5-03',
      feature: 'F5',
      name: 'POST /api/radar/comments/topics/999999/save-board returns 404/400 without creating board row',
      async run(ctx) {
        const res = await httpJson(ctx, `${ctx.baseUrl}/api/radar/comments/topics/999999/save-board`, {
          method: 'POST',
        });
        if (isFastifyRouteNotFound(res) || (isRouteMissing(res) && !(await isM1Deployed(ctx)))) {
          pendingIfOffline(ctx, 'M1 POST /api/radar/comments/topics/:topicId/save-board not yet deployed');
        }
        assert.ok(!isFastifyRouteNotFound(res), 'save-board route is not registered');
        assert.ok(res.status === 404 || res.status === 400);
        assert.ok(res.json?.error);
      },
    },
    {
      id: 'T2-F5-04',
      feature: 'F5',
      name: 'POST /api/radar/board rejects whitespace-only title with 400',
      async run(ctx) {
        const res = await httpJson(ctx, `${ctx.baseUrl}/api/radar/board`, {
          method: 'POST',
          body: { title: '   ' },
        });
        assert.equal(res.status, 400);
        assert.ok(String(res.json?.error || '').includes('标题'));
      },
    },
    {
      id: 'T2-F5-05',
      feature: 'F5',
      name: 'Repeated save-board on same topicId is idempotent / safe without 500 error (cleaned up)',
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
        assert.ok(topics.length >= 1, 'Need at least 1 topic');
        const topicId = topics[0].id;
        const createdIds = new Set();
        try {
          const s1 = await httpJson(ctx, `${ctx.baseUrl}/api/radar/comments/topics/${topicId}/save-board`, {
            method: 'POST',
          });
          if (isRouteMissing(s1)) {
            pendingIfOffline(ctx, 'M1 save-board route not yet deployed');
          }
          assert.equal(s1.status, 200);
          assert.equal(s1.json?.ok, true);
          assert.ok(s1.json?.boardItem?.id > 0);
          if (s1.json?.boardItem?.id && !topics[0].savedBoardId) createdIds.add(s1.json.boardItem.id);

          const s2 = await httpJson(ctx, `${ctx.baseUrl}/api/radar/comments/topics/${topicId}/save-board`, {
            method: 'POST',
          });
          assert.equal(s2.status, 200);
          assert.equal(s2.json?.ok, true);
          assert.ok(s2.json?.boardItem?.id > 0);
          if (s2.json?.boardItem?.id && !topics[0].savedBoardId) createdIds.add(s2.json.boardItem.id);
          assert.equal(
            Number(s2.json.boardItem.id),
            Number(s1.json.boardItem.id),
            `Repeated save-board must be idempotent: first id=${s1.json.boardItem.id}, second id=${s2.json.boardItem.id}`
          );
        } finally {
          for (const bid of createdIds) {
            await cleanupBoardItem(ctx.baseUrl, bid);
          }
        }
      },
    },

    // ================= F6 Boundaries (6 checks) =================
    {
      id: 'T2-F6-01',
      feature: 'F6',
      name: 'POST /api/sau/import-local-file rejects {} and empty filePath with 400',
      async run(ctx) {
        for (const payload of [{}, { filePath: '' }]) {
          const res = await httpJson(ctx, `${ctx.baseUrl}/api/sau/import-local-file`, {
            method: 'POST',
            body: payload,
          });
          if (isRouteMissing(res)) {
            pendingIfOffline(ctx, 'M3 POST /api/sau/import-local-file not yet deployed');
          }
          assert.equal(res.status, 400, `Expected 400 for ${JSON.stringify(payload)}, got ${res.status}`);
        }
      },
    },
    {
      id: 'T2-F6-02',
      feature: 'F6',
      name: 'POST /api/sau/import-local-file rejects nonexistent file path with 400/404',
      async run(ctx) {
        const res = await httpJson(ctx, `${ctx.baseUrl}/api/sau/import-local-file`, {
          method: 'POST',
          body: { filePath: 'C:\\nonexistent_e2e_file_999999.mp4' },
        });
        if (isFastifyRouteNotFound(res) || (isRouteMissing(res) && !(await isM3ImportDeployed(ctx)))) {
          pendingIfOffline(ctx, 'M3 POST /api/sau/import-local-file not yet deployed');
        }
        assert.ok(!isFastifyRouteNotFound(res), '/api/sau/import-local-file route is not registered');
        assert.ok(res.status === 400 || res.status === 404, `Expected 400/404, got ${res.status}`);
      },
    },
    {
      id: 'T2-F6-03',
      feature: 'F6',
      name: 'POST /api/sau/import-local-file rejects directory path with 400',
      async run(ctx) {
        const mp4 = createSyntheticMp4('dir_holder.mp4');
        try {
          const res = await httpJson(ctx, `${ctx.baseUrl}/api/sau/import-local-file`, {
            method: 'POST',
            body: { filePath: mp4.dir },
          });
          if (isRouteMissing(res)) {
            pendingIfOffline(ctx, 'M3 POST /api/sau/import-local-file not yet deployed');
          }
          assert.equal(res.status, 400, `Expected 400 for directory path, got ${res.status}`);
        } finally {
          mp4.cleanup();
        }
      },
    },
    {
      id: 'T2-F6-04',
      feature: 'F6',
      name: 'POST /api/sau/import-local-file rejects unsupported .txt extension with 400',
      async run(ctx) {
        const bad = createTempPathWithExtension('bad_video.txt', 'not a video');
        try {
          const res = await httpJson(ctx, `${ctx.baseUrl}/api/sau/import-local-file`, {
            method: 'POST',
            body: { filePath: bad.filePath },
          });
          if (isRouteMissing(res)) {
            pendingIfOffline(ctx, 'M3 POST /api/sau/import-local-file not yet deployed');
          }
          assert.equal(res.status, 400, `Expected 400 for .txt file, got ${res.status}`);
        } finally {
          bad.cleanup();
        }
      },
    },
    {
      id: 'T2-F6-05',
      feature: 'F6',
      name: 'POST /api/sau/import-local-file blocks or sanitizes path traversal in custom filename',
      async run(ctx) {
        const mp4 = createSyntheticMp4('trav_src.mp4');
        let importedId = null;
        try {
          const res = await httpJson(ctx, `${ctx.baseUrl}/api/sau/import-local-file`, {
            method: 'POST',
            body: { filePath: mp4.filePath, filename: '../../evil.mp4' },
          });
          if (isRouteMissing(res)) {
            pendingIfOffline(ctx, 'M3 POST /api/sau/import-local-file not yet deployed');
          }
          if (res.status === 200) {
            importedId = res.json?.data?.id;
            const stored = String(res.json?.data?.filepath || '');
            assert.ok(!stored.includes('..') && !stored.includes('/') && !stored.includes('\\'), `Unsafe stored filepath: ${stored}`);
          } else {
            assert.equal(res.status, 400);
          }
        } finally {
          if (importedId) await cleanupSauFile(ctx.baseUrl, importedId);
          mp4.cleanup();
        }
      },
    },
    {
      id: 'T2-F6-06',
      feature: 'F6',
      name: 'GET /api/sau/file blocks path traversal and DELETE /api/sau/files/abc rejects non-numeric ID',
      async run(ctx) {
        const [dlRes, delRes] = await Promise.all([
          httpJson(ctx, `${ctx.baseUrl}/api/sau/file?filename=../../sau_backend.py`),
          httpJson(ctx, `${ctx.baseUrl}/api/sau/files/abc`, { method: 'DELETE' }),
        ]);
        assert.equal(dlRes.status, 400, `Expected 400 on file traversal, got ${dlRes.status}`);
        assert.equal(delRes.status, 400, `Expected 400 on non-numeric file id, got ${delRes.status}`);
      },
    },

    // ================= F7 Boundaries (5 checks) =================
    {
      id: 'T2-F7-01',
      feature: 'F7',
      name: 'XHS fill_tags caps at 6 tags and MCP prepare_publish_copy caps XHS tags at <=6',
      async run(ctx) {
        const xhsScript = [
          'import ast, json',
          "src = open('sau-engine/uploader/xiaohongshu_uploader/main.py', 'r', encoding='utf-8').read()",
          'tree = ast.parse(src)',
          'ok = False',
          'for n in ast.walk(tree):',
          '  if isinstance(n, ast.AsyncFunctionDef) and n.name == "fill_tags":',
          '    seg = ast.get_source_segment(src, n) or ""',
          '    ok = ":6" in seg or "[:6]" in seg or "range(6" in seg',
          'print(json.dumps({"xhs_cap_6": ok}))',
        ].join('\n');
        const pyRes = runCommandSync(PYTHON_EXE, ['-c', xhsScript]);
        assert.equal(pyRes.status, 0);
        if (!JSON.parse(pyRes.stdout.trim()).xhs_cap_6) {
          pendingIfOffline(ctx, 'M3 XHS fill_tags 6-tag cap not yet implemented');
        }
        if (!fs.existsSync(MCP_SCRIPT_PATH)) {
          pendingIfOffline(ctx, 'M3 mcp/video-publisher-mcp.mjs not yet created');
        }
        const client = new McpStdioClient(MCP_SCRIPT_PATH, { WORKBENCH_BASE_URL: ctx.baseUrl });
        try {
          client.start();
          await client.initialize();
          const resp = await client.request('tools/call', {
            name: 'prepare_publish_copy',
            arguments: {
              title: '9标签测试',
              description: '简介',
              tags: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9'],
            },
          });
          assert.notEqual(resp.result?.isError, true);
          const data = parseMcpToolJson(resp);
          const xhsEntry = data?.xiaohongshu || data?.byPlatform?.[1] || data?.byPlatform?.['1'] || data?.platforms?.xiaohongshu;
          if (xhsEntry && Array.isArray(xhsEntry.tags)) {
            assert.ok(xhsEntry.tags.length <= 6, `Expected XHS tags <= 6, got ${xhsEntry.tags.length}`);
          }
        } finally {
          await client.close();
        }
      },
    },
    {
      id: 'T2-F7-02',
      feature: 'F7',
      name: 'prepare_publish_copy strips # prefixes, trims whitespace, and removes empty tags',
      async run(ctx) {
        if (!fs.existsSync(MCP_SCRIPT_PATH)) {
          pendingIfOffline(ctx, 'M3 mcp/video-publisher-mcp.mjs not yet created');
        }
        const client = new McpStdioClient(MCP_SCRIPT_PATH, { WORKBENCH_BASE_URL: ctx.baseUrl });
        try {
          client.start();
          await client.initialize();
          const resp = await client.request('tools/call', {
            name: 'prepare_publish_copy',
            arguments: {
              title: '标签清洗测试',
              description: '简介',
              tags: ['#AI工具', '  剪辑  ', '', '###'],
            },
          });
          assert.notEqual(resp.result?.isError, true);
          const raw = JSON.stringify(parseMcpToolJson(resp) || resp.result);
          assert.ok(!raw.includes('##'), `Double ## detected in output: ${raw}`);
          assert.ok(raw.includes('AI工具') && raw.includes('剪辑'));
        } finally {
          await client.close();
        }
      },
    },
    {
      id: 'T2-F7-03',
      feature: 'F7',
      name: 'prepare_publish_copy handles empty description cleanly and preserves multi-line description',
      async run(ctx) {
        if (!fs.existsSync(MCP_SCRIPT_PATH)) {
          pendingIfOffline(ctx, 'M3 mcp/video-publisher-mcp.mjs not yet created');
        }
        const client = new McpStdioClient(MCP_SCRIPT_PATH, { WORKBENCH_BASE_URL: ctx.baseUrl });
        try {
          client.start();
          await client.initialize();
          const emptyDesc = await client.request('tools/call', {
            name: 'prepare_publish_copy',
            arguments: { title: '无简介测试', description: '', tags: ['测试'] },
          });
          assert.notEqual(emptyDesc.result?.isError, true);
          const emptyStr = JSON.stringify(parseMcpToolJson(emptyDesc) || emptyDesc.result);
          assert.ok(!/\bundefined\b|\bnull\b/.test(emptyStr.replace(/"description":null/g, '')), `Unexpected undefined/null in ${emptyStr}`);

          const multiDesc = await client.request('tools/call', {
            name: 'prepare_publish_copy',
            arguments: { title: '多行简介测试', description: '第一段\n第二段', tags: ['测试'] },
          });
          assert.notEqual(multiDesc.result?.isError, true);
          const multiStr = JSON.stringify(parseMcpToolJson(multiDesc) || multiDesc.result);
          assert.ok(multiStr.includes('第一段') && multiStr.includes('第二段'));
        } finally {
          await client.close();
        }
      },
    },
    {
      id: 'T2-F7-04',
      feature: 'F7',
      name: 'POST /api/publish/ai-generate rejects short script (< 8 chars) with 400',
      async run(ctx) {
        const res = await httpJson(ctx, `${ctx.baseUrl}/api/publish/ai-generate`, {
          method: 'POST',
          body: { script: '太短' },
        });
        assert.equal(res.status, 400);
        assert.ok(res.json?.error);
      },
    },
    {
      id: 'T2-F7-05',
      feature: 'F7',
      name: 'POST /api/sau/post-video rejects invalid type=99, empty fileList, and empty accountList with 400',
      async run(ctx) {
        const badPayloads = [
          { type: 99, title: 'x', fileList: ['a.mp4'], accountList: ['acc.json'] },
          { type: 3, title: 'x', fileList: [], accountList: ['acc.json'] },
          { type: 3, title: 'x', fileList: ['a.mp4'], accountList: [] },
        ];
        for (const body of badPayloads) {
          const res = await httpJson(ctx, `${ctx.baseUrl}/api/sau/post-video`, { method: 'POST', body });
          assert.equal(res.status, 400, `Expected 400 for ${JSON.stringify(body)}, got ${res.status}`);
        }
      },
    },

    // ================= F8 Boundaries (6 checks) =================
    {
      id: 'T2-F8-01',
      feature: 'F8',
      name: 'MCP publish_video_to_platforms blocks isDraft=true on unsupported platforms (1, 3, 4)',
      async run(ctx) {
        if (!fs.existsSync(MCP_SCRIPT_PATH)) {
          pendingIfOffline(ctx, 'M3 mcp/video-publisher-mcp.mjs not yet created');
        }
        const mp4 = createSyntheticMp4('e2e_draft_block.mp4');
        const client = new McpStdioClient(MCP_SCRIPT_PATH, { WORKBENCH_BASE_URL: ctx.baseUrl });
        try {
          client.start();
          await client.initialize();
          for (const plat of [1, 3, 4]) {
            const resp = await client.request('tools/call', {
              name: 'publish_video_to_platforms',
              arguments: {
                dryRun: true,
                isDraft: true,
                platforms: [plat],
                filePath: mp4.filePath,
                title: '草稿拦截测试',
                description: '测试',
                tags: ['测试'],
              },
            });
            const data = parseMcpToolJson(resp);
            const raw = JSON.stringify(data || resp.result);
            assert.match(
              raw,
              /draft|草稿|不支持|unsupported|blocked|仅支持微信视频号/i,
              `Platform ${plat} with isDraft=true must return draft-rejection message (even if isError=true), got: ${raw}`
            );
          }
        } finally {
          await client.close();
          mp4.cleanup();
        }
      },
    },
    {
      id: 'T2-F8-02',
      feature: 'F8',
      name: 'MCP publish_video_to_platforms refuses live execution when dryRun is false/omitted without confirmed=true',
      async run(ctx) {
        if (!fs.existsSync(MCP_SCRIPT_PATH)) {
          pendingIfOffline(ctx, 'M3 mcp/video-publisher-mcp.mjs not yet created');
        }
        const sentinelFilePath = 'C:\\__e2e_sentinel_nonexistent__.mp4';
        const client = new McpStdioClient(MCP_SCRIPT_PATH, { WORKBENCH_BASE_URL: ctx.baseUrl });
        try {
          client.start();
          await client.initialize();
          const resp = await client.request('tools/call', {
            name: 'publish_video_to_platforms',
            arguments: {
              dryRun: false,
              platforms: [3],
              filePath: sentinelFilePath,
              title: '未确认拦截测试',
            },
          });
          const raw = JSON.stringify(parseMcpToolJson(resp) || resp.result);
          assert.match(
            raw,
            /confirm|确认|dryRun/i,
            `Expected live publish without confirmation to return confirm/dryRun refusal message, got: ${raw}`
          );
        } finally {
          await client.close();
        }
      },
    },
    {
      id: 'T2-F8-03',
      feature: 'F8',
      name: 'MCP tools/call with unknown tool name returns isError=true and keeps process alive',
      async run(ctx) {
        if (!fs.existsSync(MCP_SCRIPT_PATH)) {
          pendingIfOffline(ctx, 'M3 mcp/video-publisher-mcp.mjs not yet created');
        }
        const client = new McpStdioClient(MCP_SCRIPT_PATH, { WORKBENCH_BASE_URL: ctx.baseUrl });
        try {
          client.start();
          await client.initialize();
          const resp = await client.request('tools/call', {
            name: 'nonexistent_tool_xyz',
            arguments: {},
          });
          assert.equal(resp.result?.isError, true);
          const ping = await client.request('ping');
          assert.equal(ping.jsonrpc, '2.0');
        } finally {
          await client.close();
        }
      },
    },
    {
      id: 'T2-F8-04',
      feature: 'F8',
      name: 'MCP tools/call with non-object arguments returns isError=true without crashing',
      async run(ctx) {
        if (!fs.existsSync(MCP_SCRIPT_PATH)) {
          pendingIfOffline(ctx, 'M3 mcp/video-publisher-mcp.mjs not yet created');
        }
        const client = new McpStdioClient(MCP_SCRIPT_PATH, { WORKBENCH_BASE_URL: ctx.baseUrl });
        try {
          client.start();
          await client.initialize();
          const resp = await client.request('tools/call', {
            name: 'prepare_publish_copy',
            arguments: ['bad'],
          });
          assert.equal(resp.result?.isError, true);
        } finally {
          await client.close();
        }
      },
    },
    {
      id: 'T2-F8-05',
      feature: 'F8',
      name: 'MCP returns -32601 on unknown JSON-RPC method and survives malformed JSON lines',
      async run(ctx) {
        if (!fs.existsSync(MCP_SCRIPT_PATH)) {
          pendingIfOffline(ctx, 'M3 mcp/video-publisher-mcp.mjs not yet created');
        }
        const client = new McpStdioClient(MCP_SCRIPT_PATH, { WORKBENCH_BASE_URL: ctx.baseUrl });
        try {
          client.start();
          await client.initialize();
          const unk = await client.request('foo/bar_unknown');
          assert.equal(unk.error?.code, -32601);
          client.sendRawLine('{bad json');
          const ping = await client.request('ping');
          assert.equal(ping.jsonrpc, '2.0');
        } finally {
          await client.close();
        }
      },
    },
    {
      id: 'T2-F8-06',
      feature: 'F8',
      name: 'MCP publish_video_to_platforms allows isDraft=true + dryRun=true on Tencent Channels (platform 2)',
      async run(ctx) {
        if (!fs.existsSync(MCP_SCRIPT_PATH)) {
          pendingIfOffline(ctx, 'M3 mcp/video-publisher-mcp.mjs not yet created');
        }
        const mp4 = createSyntheticMp4('e2e_tencent_draft.mp4');
        const client = new McpStdioClient(MCP_SCRIPT_PATH, { WORKBENCH_BASE_URL: ctx.baseUrl });
        try {
          client.start();
          await client.initialize();
          const resp = await client.request('tools/call', {
            name: 'publish_video_to_platforms',
            arguments: {
              dryRun: true,
              isDraft: true,
              platforms: [2],
              filePath: mp4.filePath,
              title: '视频号草稿试发',
              description: '简介内容',
              tags: ['干货'],
            },
          });
          assert.notEqual(resp.result?.isError, true);
        } finally {
          await client.close();
          mp4.cleanup();
        }
      },
    },

    // ================= F9 Boundaries (5 checks) =================
    {
      id: 'T2-F9-01',
      feature: 'F9',
      name: 'SKILL.md name strictly matches folder name video-auto-publisher (hyphen-case <=64)',
      async run(ctx) {
        if (!fs.existsSync(SKILL_MD_PATH)) {
          pendingIfOffline(ctx, 'M4 SKILL.md not created yet');
        }
        const parsed = parseSkillFrontmatter(fs.readFileSync(SKILL_MD_PATH, 'utf8'));
        assert.equal(parsed.valid, true, parsed.reason);
        const name = parsed.fields.name || '';
        assert.equal(name, 'video-auto-publisher');
        assert.match(name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
        assert.ok(name.length <= 64);
      },
    },
    {
      id: 'T2-F9-02',
      feature: 'F9',
      name: 'SKILL.md description is 25..1024 chars and contains zero < or > chars',
      async run(ctx) {
        if (!fs.existsSync(SKILL_MD_PATH)) {
          pendingIfOffline(ctx, 'M4 SKILL.md not created yet');
        }
        const parsed = parseSkillFrontmatter(fs.readFileSync(SKILL_MD_PATH, 'utf8'));
        assert.equal(parsed.valid, true, parsed.reason);
        const desc = parsed.fields.description || '';
        assert.ok(desc.length >= 25 && desc.length <= 1024, `Invalid description length: ${desc.length}`);
        assert.ok(!/[<>]/.test(desc));
      },
    },
    {
      id: 'T2-F9-03',
      feature: 'F9',
      name: 'Every local relative Markdown link in SKILL.md resolves to an existing file on disk',
      async run(ctx) {
        if (!fs.existsSync(SKILL_MD_PATH)) {
          pendingIfOffline(ctx, 'M4 SKILL.md not created yet');
        }
        const md = fs.readFileSync(SKILL_MD_PATH, 'utf8');
        const linkRe = /\[[^\]]+\]\(([^)]+)\)/g;
        for (const m of md.matchAll(linkRe)) {
          const target = m[1].trim().split('#')[0];
          if (!target || /^https?:\/\//i.test(target) || target.startsWith('mailto:')) continue;
          const resolved = path.resolve(SKILL_DIR, target);
          assert.ok(fs.existsSync(resolved), `Broken relative link in SKILL.md: ${target}`);
        }
      },
    },
    {
      id: 'T2-F9-04',
      feature: 'F9',
      name: 'Skill folder contains zero plaintext secrets and explicitly enforces confirmation gate',
      async run(ctx) {
        if (!fs.existsSync(SKILL_MD_PATH)) {
          pendingIfOffline(ctx, 'M4 skill directory not created yet');
        }
        const files = listFilesRecursive(SKILL_DIR, (f) => /\.(md|py|mjs|js|json|txt|yaml|yml)$/i.test(f));
        for (const f of files) {
          const leaks = scanForSecrets(fs.readFileSync(f, 'utf8'), path.basename(f));
          assert.deepEqual(leaks, [], `Secret leak in skill file: ${leaks.join('; ')}`);
        }
        const md = fs.readFileSync(SKILL_MD_PATH, 'utf8');
        assert.ok(md.includes('直接发') && /确认/.test(md));
      },
    },
    {
      id: 'T2-F9-05',
      feature: 'F9',
      name: 'doctor.py audit JSON confirms Level A PASS, Level B PASS, Level C PASS/N/A, Exit Code 0',
      async run(ctx) {
        if (!fs.existsSync(SKILL_MD_PATH)) {
          pendingIfOffline(ctx, 'M4 skill directory not created yet');
        }
        const res = runCommandSync(PYTHON_EXE, [SKILL_DOCTOR_SCRIPT, 'audit', SKILL_DIR, '--json', '--no-cache']);
        assert.equal(res.status, 0, `doctor.py exited ${res.status}: ${res.stdout}\n${res.stderr}`);
        const r = JSON.parse(res.stdout);
        const matrix = r.summary?.level_matrix;
        assert.ok(matrix, `doctor.py JSON missing summary.level_matrix: ${res.stdout}`);
        assert.equal(matrix.level_a_format, 'PASS', `Expected level_a_format=PASS, got ${matrix.level_a_format}`);
        assert.equal(matrix.level_b_discovery, 'PASS', `Expected level_b_discovery=PASS, got ${matrix.level_b_discovery}`);
        assert.ok(
          matrix.level_c_explicit === 'PASS' || matrix.level_c_explicit === 'N/A',
          `Expected level_c_explicit PASS or N/A, got ${matrix.level_c_explicit}`
        );
        assert.equal(r.summary?.critical_count, 0, `Expected critical_count === 0, got ${r.summary?.critical_count}`);
      },
    },

    // ================= F10 Boundaries (5 checks) =================
    {
      id: 'T2-F10-01',
      feature: 'F10',
      name: 'Zero border-left: 3px rules in frontend/src/*.css, *.tsx, or frontend/dist/assets/*.css',
      async run() {
        const scan = scanCssCompliance(PROJECT_ROOT);
        const bl = scan.violations.filter((v) => v.includes('border-left'));
        assert.deepEqual(bl, []);
      },
    },
    {
      id: 'T2-F10-02',
      feature: 'F10',
      name: 'Zero nested bordered card rules and light theme variables preserved',
      async run() {
        const scan = scanCssCompliance(PROJECT_ROOT);
        assert.equal(scan.lightVarsPresent, true);
        const nested = scan.violations.filter((v) => v.includes('Nested'));
        assert.deepEqual(nested, []);
      },
    },
    {
      id: 'T2-F10-03',
      feature: 'F10',
      name: 'Source files contain zero hardcoded plaintext API keys or raw cookies',
      async run() {
        const targets = [
          'src/api/routes.ts',
          'src/api/radarRoutes.ts',
          'sau-engine/sau_backend.py',
          'mcp/video-publisher-mcp.mjs',
        ];
        for (const rel of targets) {
          const full = path.join(PROJECT_ROOT, rel);
          if (!fs.existsSync(full)) continue;
          const leaks = scanForSecrets(fs.readFileSync(full, 'utf8'), rel);
          assert.deepEqual(leaks, [], `Secret leak in ${rel}: ${leaks.join('; ')}`);
        }
      },
    },
    {
      id: 'T2-F10-04',
      feature: 'F10',
      name: 'Live API responses (/api/settings, /api/radar/integrations, /api/sau/accounts) leak zero secrets',
      async run(ctx) {
        for (const ep of ['/api/settings', '/api/radar/integrations', '/api/sau/accounts']) {
          const res = await httpJson(ctx, `${ctx.baseUrl}${ep}`);
          assert.equal(res.status, 200, `${ep} returned ${res.status}`);
          const leaks = scanForSecrets(res.text, ep);
          assert.deepEqual(leaks, [], `Secret leak in ${ep}: ${leaks.join('; ')}`);
        }
      },
    },
    {
      id: 'T2-F10-05',
      feature: 'F10',
      name: 'Existing unit tests (npm test) pass & legacy multipart POST /api/sau/upload rejects empty request with 400',
      async run(ctx) {
        const cmd = process.platform === 'win32' ? 'cmd.exe' : 'npm';
        const args = process.platform === 'win32' ? ['/c', 'npm', 'test'] : ['test'];
        const tRes = runCommandSync(cmd, args, { timeoutMs: 90000 });
        assert.equal(tRes.status, 0, `npm test failed:\n${tRes.stdout}\n${tRes.stderr}`);

        const form = new FormData();
        const upRes = await httpJson(ctx, `${ctx.baseUrl}/api/sau/upload`, {
          method: 'POST',
          body: form,
        });
        assert.equal(upRes.status, 400, `Expected 400 on empty multipart /api/sau/upload, got ${upRes.status}`);
      },
    },
  ];
}
