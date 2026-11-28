import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  MCP_SCRIPT_PATH,
  SKILL_MD_PATH,
  McpStdioClient,
  assertSortedNewestFirst,
  cleanupBoardItem,
  cleanupSauFile,
  createSyntheticMp4,
  httpJson,
  isRouteMissing,
  parseMcpToolJson,
  pendingIfOffline,
  pickCreatorAndContentIds,
  scanForSecrets,
  throwIfMcpOfflineOrPreM3,
} from './lib/helpers.mjs';

export function getTier3Checks() {
  return [
    {
      id: 'T3-01',
      feature: 'F1+F2+F3',
      name: 'Feed todayLeaderboard top items -> r2-analyze -> compare-remix -> persisted in feed',
      async run(ctx) {
        const feedRes = await httpJson(ctx, `${ctx.baseUrl}/api/radar/creators/feed?days=0&limit=50`);
        assert.equal(feedRes.status, 200);
        const lb = feedRes.json?.todayLeaderboard;
        if (!lb || !Array.isArray(lb.items)) {
          pendingIfOffline(ctx, 'M1 todayLeaderboard not yet deployed');
        }
        assert.ok(lb.items.length >= 1, 'Need >= 1 item in todayLeaderboard');
        const id1 = lb.items[0].id;
        const fallbackCandidate = (feedRes.json?.items || []).find((it) => Number(it.id) !== Number(id1));
        const id2 = lb.items[1]?.id || fallbackCandidate?.id;
        assert.ok(id2, 'Need >= 2 distinct creator items across todayLeaderboard/feed for compare-remix flow');

        const r2Res = await httpJson(ctx, `${ctx.baseUrl}/api/radar/intel/${id1}/r2-analyze`, {
          method: 'POST',
          body: { force: false },
          timeoutMs: 90000,
        });
        if (isRouteMissing(r2Res)) pendingIfOffline(ctx, 'M1 r2-analyze not yet deployed');
        assert.equal(r2Res.status, 200);

        const cmpRes = await httpJson(ctx, `${ctx.baseUrl}/api/radar/creators/compare-remix`, {
          method: 'POST',
          body: { contentIds: [id1, id2] },
          timeoutMs: 90000,
        });
        if (isRouteMissing(cmpRes)) pendingIfOffline(ctx, 'M1 compare-remix not yet deployed');
        assert.equal(cmpRes.status, 200);
        assert.ok([id1, id2].includes(Number(cmpRes.json?.bestContentId)));

        const feedAfter = await httpJson(ctx, `${ctx.baseUrl}/api/radar/creators/feed?days=0&limit=50`);
        const updated = (feedAfter.json?.items || []).find((it) => Number(it.id) === Number(id1));
        assert.ok(updated && updated.r2_analysis && updated.r2_analysis.whatItSays);
      },
    },
    {
      id: 'T3-02',
      feature: 'F4+F3',
      name: 'Tail historical video (offset=30) -> r2-analyze succeeds on older content',
      async run(ctx) {
        const pageRes = await httpJson(ctx, `${ctx.baseUrl}/api/radar/creators/feed?days=0&offset=30&limit=30`);
        assert.equal(pageRes.status, 200);
        if (typeof pageRes.json?.offset !== 'number' || typeof pageRes.json?.total !== 'number') {
          pendingIfOffline(ctx, 'M1 pagination offset/total not yet deployed');
        }
        const tailItems = pageRes.json.items || [];
        assert.ok(tailItems.length >= 1, 'Expected tail items at offset=30');
        const oldest = tailItems[tailItems.length - 1];

        const r2Res = await httpJson(ctx, `${ctx.baseUrl}/api/radar/intel/${oldest.id}/r2-analyze`, {
          method: 'POST',
          body: { force: false },
          timeoutMs: 90000,
        });
        if (isRouteMissing(r2Res)) pendingIfOffline(ctx, 'M1 r2-analyze not yet deployed');
        assert.equal(r2Res.status, 200);
        assert.ok(r2Res.json?.analysis?.whatItSays);
        assert.ok(r2Res.json?.analysis?.heatVerdict);
        assert.ok(r2Res.json?.analysis?.remixSuitability);
      },
    },
    {
      id: 'T3-03',
      feature: 'F3+F5',
      name: 'Same Bilibili creator video -> r2-analyze AND comments/topics both succeed',
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
        assert.ok(chosen);
        const r2 = await httpJson(ctx, `${ctx.baseUrl}/api/radar/intel/${chosen.id}/r2-analyze`, {
          method: 'POST',
          body: { force: false },
          timeoutMs: 90000,
        });
        if (isRouteMissing(r2)) pendingIfOffline(ctx, 'M1 r2-analyze not yet deployed');
        assert.equal(r2.status, 200);

        const ct = await httpJson(ctx, `${ctx.baseUrl}/api/radar/intel/${chosen.id}/comments/topics`, {
          method: 'POST',
          body: { autoCrawl: true, force: false },
          timeoutMs: 90000,
        });
        if (isRouteMissing(ct)) pendingIfOffline(ctx, 'M1 comments/topics not yet deployed');
        assert.equal(ct.status, 200);
        assert.equal(ct.json?.ok, true);
        assert.ok(Array.isArray(ct.json?.topics));
      },
    },
    {
      id: 'T3-04',
      feature: 'F5+F10',
      name: 'Comment topic -> save-board -> verify in GET /api/radar/board -> DELETE cleanup leaves zero DB pollution',
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
        if (isRouteMissing(tRes)) pendingIfOffline(ctx, 'M1 comments/topics not yet deployed');
        assert.equal(tRes.status, 200);
        const topics = tRes.json?.topics || [];
        assert.ok(topics.length >= 1);
        const topic = topics[0];
        const wasAlreadySaved = Boolean(topic.savedBoardId);
        let savedId = null;
        try {
          const sRes = await httpJson(ctx, `${ctx.baseUrl}/api/radar/comments/topics/${topic.id}/save-board`, {
            method: 'POST',
          });
          if (isRouteMissing(sRes)) pendingIfOffline(ctx, 'M1 save-board not yet deployed');
          assert.equal(sRes.status, 200);
          savedId = sRes.json?.boardItem?.id;
          assert.ok(Number(savedId) > 0 && sRes.json?.boardItem?.title);

          const boardRes = await httpJson(ctx, `${ctx.baseUrl}/api/radar/board`);
          assert.equal(boardRes.status, 200);
          assert.ok((boardRes.json?.items || []).some((b) => Number(b.id) === Number(savedId)));

          if (!wasAlreadySaved) {
            const delRes = await httpJson(ctx, `${ctx.baseUrl}/api/radar/board/${savedId}`, { method: 'DELETE' });
            assert.equal(delRes.status, 200);
            const boardAfter = await httpJson(ctx, `${ctx.baseUrl}/api/radar/board`);
            assert.ok(!(boardAfter.json?.items || []).some((b) => Number(b.id) === Number(savedId)));
            savedId = null;
          }
        } finally {
          if (savedId && !wasAlreadySaved) {
            await cleanupBoardItem(ctx.baseUrl, savedId);
          }
        }
      },
    },
    {
      id: 'T3-05',
      feature: 'F6+F7+F8',
      name: 'Synthetic .mp4 -> import-local-file -> MCP prepare_publish_copy(8 tags) -> dryRun publish -> cleanup',
      async run(ctx) {
        if (!fs.existsSync(MCP_SCRIPT_PATH)) {
          pendingIfOffline(ctx, 'M3 mcp/video-publisher-mcp.mjs not yet created');
        }
        const mp4 = createSyntheticMp4('e2e_t3_05.mp4');
        const client = new McpStdioClient(MCP_SCRIPT_PATH, { WORKBENCH_BASE_URL: ctx.baseUrl });
        let importedId = null;
        try {
          const impRes = await httpJson(ctx, `${ctx.baseUrl}/api/sau/import-local-file`, {
            method: 'POST',
            body: { filePath: mp4.filePath, filename: 'e2e_t3_05.mp4' },
          });
          if (isRouteMissing(impRes)) pendingIfOffline(ctx, 'M3 /api/sau/import-local-file not yet deployed');
          assert.equal(impRes.status, 200);
          importedId = impRes.json?.data?.id;
          const storedFile = impRes.json?.data?.filepath;
          assert.ok(importedId && storedFile);

          client.start();
          await client.initialize();
          const copyResp = await client.request('tools/call', {
            name: 'prepare_publish_copy',
            arguments: {
              title: 'T3联合发布标题',
              description: '话题前完整简介段落',
              tags: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'],
            },
          });
          throwIfMcpOfflineOrPreM3(ctx, copyResp, 'T3-05 prepare_publish_copy');
          assert.notEqual(copyResp.result?.isError, true);
          const copyData = parseMcpToolJson(copyResp);
          const xhsCopy =
            copyData?.xiaohongshu ||
            copyData?.byPlatform?.[1] ||
            copyData?.byPlatform?.['1'] ||
            copyData?.platforms?.['1'] ||
            copyData?.platforms?.[1] ||
            copyData?.platforms?.xiaohongshu;
          assert.ok(
            xhsCopy && Array.isArray(xhsCopy.tags),
            `Expected Xiaohongshu platform copy with tags array in prepare_publish_copy output, got: ${JSON.stringify(copyData)}`
          );
          assert.ok(xhsCopy.tags.length <= 6, `Expected XHS tags <= 6, got ${xhsCopy.tags.length}`);

          const pubResp = await client.request('tools/call', {
            name: 'publish_video_to_platforms',
            arguments: {
              dryRun: true,
              platforms: [1, 2, 3, 4],
              fileList: [storedFile],
              title: 'T3联合发布标题',
              description: '话题前完整简介段落',
              tags: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'],
            },
          });
          throwIfMcpOfflineOrPreM3(ctx, pubResp, 'T3-05 publish_video_to_platforms');
          assert.notEqual(pubResp.result?.isError, true);
          const pubRaw = JSON.stringify(parseMcpToolJson(pubResp) || pubResp.result);
          assert.ok(pubRaw.includes('话题前完整简介段落'));
        } finally {
          await client.close();
          if (importedId) await cleanupSauFile(ctx.baseUrl, importedId);
          mp4.cleanup();
        }
      },
    },
    {
      id: 'T3-06',
      feature: 'F8+F9',
      name: 'SKILL.md tool names & HTTP fallback endpoints match MCP tools/list and live 18910 routes',
      async run(ctx) {
        if (!fs.existsSync(SKILL_MD_PATH) || !fs.existsSync(MCP_SCRIPT_PATH)) {
          pendingIfOffline(ctx, 'M3/M4 MCP script or SKILL.md not yet created');
        }
        const md = fs.readFileSync(SKILL_MD_PATH, 'utf8');
        const client = new McpStdioClient(MCP_SCRIPT_PATH, { WORKBENCH_BASE_URL: ctx.baseUrl });
        try {
          client.start();
          await client.initialize();
          const toolsResp = await client.request('tools/list', {});
          const names = (toolsResp.result?.tools || []).map((t) => t.name);
          for (const tool of names) {
            assert.ok(md.includes(tool), `SKILL.md missing MCP tool name: ${tool}`);
          }
        } finally {
          await client.close();
        }
        // Verify fallback HTTP routes are registered on 18910 (never sending valid live publish payload)
        for (const [method, ep, body] of [
          ['GET', '/api/sau/accounts', undefined],
          ['GET', '/api/sau/publish-history', undefined],
          ['POST', '/api/sau/import-local-file', {}],
          ['POST', '/api/sau/post-video', {}],
        ]) {
          const r = await httpJson(ctx, `${ctx.baseUrl}${ep}`, { method, body });
          assert.ok(!isRouteMissing(r), `Fallback endpoint ${method} ${ep} returned 404 route-not-found`);
        }
      },
    },
    {
      id: 'T3-07',
      feature: 'F1+F4+F10',
      name: 'RSS exists in /api/sources & /api/contents while excluded from default creator feed',
      async run(ctx) {
        const [srcRes, contRes, feedRes] = await Promise.all([
          httpJson(ctx, `${ctx.baseUrl}/api/sources`),
          httpJson(ctx, `${ctx.baseUrl}/api/contents?limit=10`),
          httpJson(ctx, `${ctx.baseUrl}/api/radar/creators/feed?days=0&limit=50`),
        ]);
        assert.equal(srcRes.status, 200);
        assert.equal(contRes.status, 200);
        assert.equal(feedRes.status, 200);
        assert.ok(Array.isArray(contRes.json?.items || contRes.json));
        if (!feedRes.json?.todayUpdates || feedRes.json.creators.some((c) => c.source_type === undefined)) {
          pendingIfOffline(ctx, 'M1 creator source_type separation not yet deployed');
        }
        const rssSources = (srcRes.json || []).filter((s) => s.source_type === 'rss');
        if (rssSources.length > 0) {
          const feedCreatorIds = new Set(feedRes.json.creators.map((c) => Number(c.id)));
          for (const rs of rssSources) {
            assert.ok(!feedCreatorIds.has(Number(rs.id)), `RSS source ${rs.name} leaked into default feed creators`);
          }
        }
      },
    },
    {
      id: 'T3-08',
      feature: 'F2+F4',
      name: 'todayLeaderboard ranks creator pool (with Douyin views=null safe) while main feed stays newest-first',
      async run(ctx) {
        const res = await httpJson(ctx, `${ctx.baseUrl}/api/radar/creators/feed?days=0&limit=100`);
        assert.equal(res.status, 200);
        if (!res.json?.todayLeaderboard) {
          pendingIfOffline(ctx, 'M1 todayLeaderboard not yet deployed');
        }
        const creatorIds = new Set(res.json.creators.map((c) => Number(c.id)));
        for (const it of res.json.todayLeaderboard.items) {
          assert.ok(creatorIds.has(Number(it.source_id)), `Leaderboard item ${it.id} must come from creator pool`);
          assert.ok(Number.isFinite(it.heatScore) && it.heatScore >= 0);
        }
        assertSortedNewestFirst(res.json.items, 'feed_main_100');
      },
    },
    {
      id: 'T3-09',
      feature: 'F6+F10',
      name: 'import-local-file + /api/sau/file coexist safely with legacy multipart /api/sau/upload -> cleanup',
      async run(ctx) {
        const mp4 = createSyntheticMp4('e2e_t3_09.mp4');
        let importedId = null;
        try {
          const impRes = await httpJson(ctx, `${ctx.baseUrl}/api/sau/import-local-file`, {
            method: 'POST',
            body: { filePath: mp4.filePath, filename: 'e2e_t3_09.mp4' },
          });
          if (isRouteMissing(impRes)) pendingIfOffline(ctx, 'M3 /api/sau/import-local-file not yet deployed');
          assert.equal(impRes.status, 200);
          importedId = impRes.json?.data?.id;
          const storedPath = impRes.json?.data?.filepath;
          assert.ok(importedId && storedPath);

          const dl = await httpJson(ctx, `${ctx.baseUrl}/api/sau/file?filename=${encodeURIComponent(storedPath)}`);
          assert.equal(dl.status, 200);

          const up = await httpJson(ctx, `${ctx.baseUrl}/api/sau/upload`, { method: 'POST', body: new FormData() });
          assert.equal(up.status, 400);
        } finally {
          if (importedId) await cleanupSauFile(ctx.baseUrl, importedId);
          mp4.cleanup();
        }
      },
    },
    {
      id: 'T3-10',
      feature: 'F7+F9',
      name: 'AI publish-copy generation feeds MCP prepare_publish_copy cleanly across all 4 platforms',
      async run(ctx) {
        if (!fs.existsSync(MCP_SCRIPT_PATH)) {
          pendingIfOffline(ctx, 'M3 mcp/video-publisher-mcp.mjs not yet created');
        }
        const aiRes = await httpJson(ctx, `${ctx.baseUrl}/api/publish/ai-generate`, {
          method: 'POST',
          body: {
            script: '种植玉米追肥最容易踩的三个坑：第一只看氮肥不看钾肥，第二浇水前撒施挥发快，第三忽视中微量元素导致秃尖。',
          },
          timeoutMs: 90000,
        });
        assert.equal(aiRes.status, 200);
        const dy = aiRes.json?.byPlatform?.['3'] || aiRes.json?.byPlatform?.[3];
        assert.ok(dy && dy.title);

        const client = new McpStdioClient(MCP_SCRIPT_PATH, { WORKBENCH_BASE_URL: ctx.baseUrl });
        try {
          client.start();
          await client.initialize();
          const prep = await client.request('tools/call', {
            name: 'prepare_publish_copy',
            arguments: {
              title: dy.title,
              description: dy.description || '玉米追肥干货要点',
              tags: dy.tags?.length ? dy.tags : ['玉米种植', '农资干货'],
            },
          });
          throwIfMcpOfflineOrPreM3(ctx, prep, 'T3-10 prepare_publish_copy');
          assert.notEqual(prep.result?.isError, true);
          const data = parseMcpToolJson(prep);
          const raw = JSON.stringify(data || prep.result);
          assert.ok(!raw.includes('##'));
          const xhs =
            data?.xiaohongshu ||
            data?.byPlatform?.[1] ||
            data?.byPlatform?.['1'] ||
            data?.platforms?.['1'] ||
            data?.platforms?.[1] ||
            data?.platforms?.xiaohongshu;
          assert.ok(
            xhs && Array.isArray(xhs.tags),
            `Expected Xiaohongshu platform copy with tags array in prepare_publish_copy output, got: ${JSON.stringify(data)}`
          );
          assert.ok(xhs.tags.length <= 6, `Expected XHS tags <= 6, got ${xhs.tags.length}`);
        } finally {
          await client.close();
        }
      },
    },
    {
      id: 'T3-11',
      feature: 'F1+F5',
      name: 'Running comments/topics updates comment_count & comment_topics_count in creator feed',
      async run(ctx) {
        const { biliCreator, biliItems, items } = await pickCreatorAndContentIds(ctx);
        let chosen = biliItems[0] || items[0];
        for (const cand of [...biliItems.slice(0, 5), ...items.slice(0, 3)]) {
          const det = await httpJson(ctx, `${ctx.baseUrl}/api/radar/intel/${cand.id}/detail`);
          if (det.status === 200 && Array.isArray(det.json?.comments) && det.json.comments.length > 0) {
            chosen = cand;
            break;
          }
        }
        const ct = await httpJson(ctx, `${ctx.baseUrl}/api/radar/intel/${chosen.id}/comments/topics`, {
          method: 'POST',
          body: { autoCrawl: true, force: false },
          timeoutMs: 90000,
        });
        if (isRouteMissing(ct)) pendingIfOffline(ctx, 'M1 comments/topics not yet deployed');
        assert.equal(ct.status, 200);

        const feedRes = await httpJson(
          ctx,
          `${ctx.baseUrl}/api/radar/creators/feed?creatorId=${chosen.source_id || biliCreator?.id}&days=0&limit=50`
        );
        assert.equal(feedRes.status, 200);
        const found = (feedRes.json?.items || []).find((x) => Number(x.id) === Number(chosen.id));
        assert.ok(found);
        assert.equal(typeof found.comment_count, 'number');
        assert.equal(typeof found.comment_topics_count, 'number');
        if (ct.json.commentsCount > 0) {
          assert.ok(found.comment_topics_count >= 1);
        }
      },
    },
    {
      id: 'T3-12',
      feature: 'F8+F10',
      name: 'MCP status/accounts/history + GET /api/settings pass secret & cookie leak scan',
      async run(ctx) {
        if (!fs.existsSync(MCP_SCRIPT_PATH)) {
          pendingIfOffline(ctx, 'M3 mcp/video-publisher-mcp.mjs not yet created');
        }
        const setRes = await httpJson(ctx, `${ctx.baseUrl}/api/settings`);
        assert.equal(setRes.status, 200);
        assert.deepEqual(scanForSecrets(setRes.text, '/api/settings'), []);

        const client = new McpStdioClient(MCP_SCRIPT_PATH, { WORKBENCH_BASE_URL: ctx.baseUrl });
        try {
          client.start();
          await client.initialize();
          for (const [tool, args] of [
            ['check_workbench_status', {}],
            ['list_publish_accounts', { validate: false }],
            ['get_publish_history', { limit: 10 }],
          ]) {
            const resp = await client.request('tools/call', { name: tool, arguments: args });
            throwIfMcpOfflineOrPreM3(ctx, resp, `T3-12 ${tool}`);
            assert.notEqual(resp.result?.isError, true);
            const leaks = scanForSecrets(JSON.stringify(resp), `mcp:${tool}`);
            assert.deepEqual(leaks, [], `Secret leak in ${tool}: ${leaks.join('; ')}`);
          }
        } finally {
          await client.close();
        }
      },
    },
  ];
}
