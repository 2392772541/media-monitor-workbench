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
  isRouteMissing,
  parseMcpToolJson,
  parseSkillFrontmatter,
  pendingIfOffline,
  pickCreatorAndContentIds,
  runCommandSync,
  scanCssCompliance,
  scanForSecrets,
  throwIfMcpOfflineOrPreM3,
} from './lib/helpers.mjs';

export function getTier4Checks() {
  return [
    {
      id: 'T4-01',
      feature: 'F1+F2+F3+F10',
      name: 'Scenario 1: 早间巡检流 — 每日更新 + 热度榜 + 单条R2分析 + 双条二创对比 + 健康与安全核验',
      async run(ctx) {
        const feedRes = await httpJson(ctx, `${ctx.baseUrl}/api/radar/creators/feed`);
        assert.equal(feedRes.status, 200);
        const f = feedRes.json;
        if (!f?.todayUpdates || !f?.todayLeaderboard || f.creators?.some((c) => c.source_type === undefined)) {
          pendingIfOffline(ctx, 'M1 morning inspection feed fields not yet deployed');
        }
        // Verify RSS excluded
        for (const c of f.creators) {
          assert.equal(c.source_type, 'creator');
        }
        // Verify todayUpdates & todayLeaderboard consistency
        if (f.todayUpdates.todayCount === 0) {
          assert.equal(f.todayUpdates.hasTodayNew, false);
          assert.equal(f.todayLeaderboard.isFallback, true);
          assert.ok(f.todayLeaderboard.fallbackLabel.trim().length > 0);
        } else {
          assert.equal(f.todayUpdates.hasTodayNew, true);
          assert.equal(f.todayLeaderboard.isFallback, false);
        }
        assert.ok(f.todayLeaderboard.items.length >= 1, 'Need >= 1 leaderboard item for scenario');
        for (const it of f.todayLeaderboard.items) {
          assert.ok(Number.isFinite(it.heatScore) && it.heatScore >= 0);
          assert.ok(!/NaN|undefined/i.test(String(it.heatBasis)));
        }

        const top1 = f.todayLeaderboard.items[0];
        const top2 =
          f.todayLeaderboard.items[1] ||
          (f.items || []).find((it) => Number(it.id) !== Number(top1.id));
        assert.ok(top2, 'Need a second creator item for compare-remix');
        const r2Res = await httpJson(ctx, `${ctx.baseUrl}/api/radar/intel/${top1.id}/r2-analyze`, {
          method: 'POST',
          body: { force: false },
          timeoutMs: 90000,
        });
        if (isRouteMissing(r2Res)) pendingIfOffline(ctx, 'M1 r2-analyze not yet deployed');
        assert.equal(r2Res.status, 200);
        const a = r2Res.json?.analysis;
        assert.ok(a?.whatItSays && a?.heatVerdict && a?.remixSuitability);

        const cmpRes = await httpJson(ctx, `${ctx.baseUrl}/api/radar/creators/compare-remix`, {
          method: 'POST',
          body: { contentIds: [top1.id, top2.id] },
          timeoutMs: 90000,
        });
        if (isRouteMissing(cmpRes)) pendingIfOffline(ctx, 'M1 compare-remix not yet deployed');
        assert.equal(cmpRes.status, 200);
        assert.ok([top1.id, top2.id].includes(Number(cmpRes.json?.bestContentId)));
        assert.ok(Array.isArray(cmpRes.json?.rankings) && cmpRes.json.rankings.length === 2);

        const ovRes = await httpJson(ctx, `${ctx.baseUrl}/api/overview`);
        assert.equal(ovRes.status, 200);
        assert.deepEqual(scanForSecrets(JSON.stringify([f, r2Res.json, cmpRes.json, ovRes.json]), 'T4-01'), []);
      },
    },
    {
      id: 'T4-02',
      feature: 'F3+F4+F10',
      name: 'Scenario 2: 博主深度考古流 — 跨30条分页 + 分博主全历史严格新到旧 + 长尾老视频R2分析',
      async run(ctx) {
        const p1 = await httpJson(ctx, `${ctx.baseUrl}/api/radar/creators/feed?days=0&offset=0&limit=30`);
        assert.equal(p1.status, 200);
        if (typeof p1.json?.total !== 'number' || typeof p1.json?.offset !== 'number') {
          pendingIfOffline(ctx, 'M1 creator history pagination not yet deployed');
        }
        assert.ok(p1.json.total > 30, `Expected >30 total creator items, got ${p1.json.total}`);
        assertSortedNewestFirst(p1.json.items, 'T4-02_page1');

        const p2 = await httpJson(ctx, `${ctx.baseUrl}/api/radar/creators/feed?days=0&offset=30&limit=30`);
        assert.equal(p2.status, 200);
        assert.ok(p2.json.items.length >= 1);
        assertSortedNewestFirst(p2.json.items, 'T4-02_page2');
        const p1Ids = new Set(p1.json.items.map((x) => x.id));
        for (const it of p2.json.items) {
          assert.ok(!p1Ids.has(it.id), `Duplicate id ${it.id} across pages`);
        }

        const { douyinCreator, biliCreator } = await pickCreatorAndContentIds(ctx);
        for (const c of [douyinCreator, biliCreator].filter(Boolean)) {
          const cFeed = await httpJson(
            ctx,
            `${ctx.baseUrl}/api/radar/creators/feed?creatorId=${c.id}&days=0&limit=50`
          );
          assert.equal(cFeed.status, 200);
          assert.equal(cFeed.json.items.length, Math.min(50, cFeed.json.total));
          assertSortedNewestFirst(cFeed.json.items, `T4-02_${c.name}`);
        }

        const tailItem = p2.json.items[p2.json.items.length - 1];
        const r2 = await httpJson(ctx, `${ctx.baseUrl}/api/radar/intel/${tailItem.id}/r2-analyze`, {
          method: 'POST',
          body: { force: false },
          timeoutMs: 90000,
        });
        if (isRouteMissing(r2)) pendingIfOffline(ctx, 'M1 r2-analyze not yet deployed');
        assert.equal(r2.status, 200);
        assert.ok(r2.json?.analysis?.whatItSays && r2.json?.analysis?.heatVerdict && r2.json?.analysis?.remixSuitability);
      },
    },
    {
      id: 'T4-03',
      feature: 'F3+F5+F10',
      name: 'Scenario 3: 评论区选题闭环流 — 采集/读取评论 -> 提炼热门话题 -> 存入选题板 -> 回读 -> 清理',
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
        const ct = await httpJson(ctx, `${ctx.baseUrl}/api/radar/intel/${chosen.id}/comments/topics`, {
          method: 'POST',
          body: { autoCrawl: true, force: false },
          timeoutMs: 90000,
        });
        if (isRouteMissing(ct)) pendingIfOffline(ctx, 'M1 comments/topics not yet deployed');
        assert.equal(ct.status, 200);
        assert.ok(ct.json.commentsCount > 0, 'Expected commentsCount > 0');
        assert.ok(Array.isArray(ct.json.topics) && ct.json.topics.length >= 1);
        const firstTopic = ct.json.topics[0];
        assert.ok(Array.isArray(firstTopic.evidenceComments) && firstTopic.creationIdeaTitle);

        const wasAlreadySaved = Boolean(firstTopic.savedBoardId);
        let boardId = null;
        try {
          const save = await httpJson(ctx, `${ctx.baseUrl}/api/radar/comments/topics/${firstTopic.id}/save-board`, {
            method: 'POST',
          });
          if (isRouteMissing(save)) pendingIfOffline(ctx, 'M1 save-board not yet deployed');
          assert.equal(save.status, 200);
          boardId = save.json?.boardItem?.id;
          assert.ok(Number(boardId) > 0);

          const board = await httpJson(ctx, `${ctx.baseUrl}/api/radar/board`);
          assert.equal(board.status, 200);
          assert.ok((board.json?.items || []).some((b) => Number(b.id) === Number(boardId)));

          if (!wasAlreadySaved) {
            const del = await httpJson(ctx, `${ctx.baseUrl}/api/radar/board/${boardId}`, { method: 'DELETE' });
            assert.equal(del.status, 200);
            const boardAfter = await httpJson(ctx, `${ctx.baseUrl}/api/radar/board`);
            assert.ok(!(boardAfter.json?.items || []).some((b) => Number(b.id) === Number(boardId)));
            boardId = null;
          }
        } finally {
          if (boardId && !wasAlreadySaved) {
            await cleanupBoardItem(ctx.baseUrl, boardId);
          }
        }
      },
    },
    {
      id: 'T4-04',
      feature: 'F6+F7+F8+F10',
      name: 'Scenario 4: 全自动本地导入与四平台安全试发流 — 合成MP4 -> 本地导入 -> MCP全流程(dryRun) -> 彻底清理',
      async run(ctx) {
        if (!fs.existsSync(MCP_SCRIPT_PATH)) {
          pendingIfOffline(ctx, 'M3 mcp/video-publisher-mcp.mjs not yet created');
        }
        const preFilesRes = await httpJson(ctx, `${ctx.baseUrl}/api/sau/files`);
        assert.equal(preFilesRes.status, 200);
        const preFileIds = new Set((preFilesRes.json?.data || []).map((f) => Number(f.id)));
        const preHistRes = await httpJson(ctx, `${ctx.baseUrl}/api/sau/publish-history?limit=20`);
        assert.equal(preHistRes.status, 200);
        const preHistCount = (preHistRes.json?.data || []).length;

        const mp4 = createSyntheticMp4('e2e_t4_04.mp4');
        const client = new McpStdioClient(MCP_SCRIPT_PATH, { WORKBENCH_BASE_URL: ctx.baseUrl });
        let importedId = null;
        try {
          const imp = await httpJson(ctx, `${ctx.baseUrl}/api/sau/import-local-file`, {
            method: 'POST',
            body: { filePath: mp4.filePath, filename: 'e2e_t4_04.mp4' },
          });
          if (isRouteMissing(imp)) pendingIfOffline(ctx, 'M3 /api/sau/import-local-file not yet deployed');
          assert.equal(imp.status, 200);
          importedId = imp.json?.data?.id;
          const storedFile = imp.json?.data?.filepath;
          assert.ok(importedId && storedFile);

          const filesNow = await httpJson(ctx, `${ctx.baseUrl}/api/sau/files`);
          assert.ok((filesNow.json?.data || []).some((f) => Number(f.id) === Number(importedId)));

          client.start();
          await client.initialize();
          const st = await client.request('tools/call', { name: 'check_workbench_status', arguments: {} });
          throwIfMcpOfflineOrPreM3(ctx, st, 'T4-04 check_workbench_status');
          assert.notEqual(st.result?.isError, true);

          const acc = await client.request('tools/call', { name: 'list_publish_accounts', arguments: { validate: false } });
          throwIfMcpOfflineOrPreM3(ctx, acc, 'T4-04 list_publish_accounts');
          assert.notEqual(acc.result?.isError, true);
          assert.deepEqual(scanForSecrets(JSON.stringify(acc), 'T4-04_accounts'), []);

          const copy = await client.request('tools/call', {
            name: 'prepare_publish_copy',
            arguments: {
              title: '全链路试发测试标题',
              description: '话题前的一小段干货简介',
              tags: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'],
            },
          });
          throwIfMcpOfflineOrPreM3(ctx, copy, 'T4-04 prepare_publish_copy');
          assert.notEqual(copy.result?.isError, true);

          const dryPub = await client.request('tools/call', {
            name: 'publish_video_to_platforms',
            arguments: {
              dryRun: true,
              isDraft: false,
              platforms: [1, 2, 3, 4],
              fileList: [storedFile],
              title: '全链路试发测试标题',
              description: '话题前的一小段干货简介',
              tags: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'],
            },
          });
          throwIfMcpOfflineOrPreM3(ctx, dryPub, 'T4-04 publish_video_to_platforms(dryRun)');
          assert.notEqual(dryPub.result?.isError, true);

          const draftBlock = await client.request('tools/call', {
            name: 'publish_video_to_platforms',
            arguments: {
              dryRun: true,
              isDraft: true,
              platforms: [3],
              fileList: [storedFile],
              title: '抖音草稿拦截',
            },
          });
          const blockRaw = JSON.stringify(parseMcpToolJson(draftBlock) || draftBlock.result);
          assert.ok(
            draftBlock.result?.isError === true || /draft|草稿|不支持|unsupported|blocked/i.test(blockRaw),
            'Douyin isDraft=true must be blocked'
          );

          // Delete imported SAU file & verify clean removal
          const del = await httpJson(ctx, `${ctx.baseUrl}/api/sau/files/${importedId}`, { method: 'DELETE' });
          assert.equal(del.status, 200);
          importedId = null;

          const postFiles = await httpJson(ctx, `${ctx.baseUrl}/api/sau/files`);
          const residualTestFiles = (postFiles.json?.data || []).filter((f) => !preFileIds.has(Number(f.id)));
          assert.equal(residualTestFiles.length, 0, 'Leftover SAU test files detected');

          const postHist = await httpJson(ctx, `${ctx.baseUrl}/api/sau/publish-history?limit=20`);
          assert.equal((postHist.json?.data || []).length, preHistCount, 'dryRun must not create live publish records');
        } finally {
          await client.close();
          if (importedId) await cleanupSauFile(ctx.baseUrl, importedId);
          mp4.cleanup();
        }
      },
    },
    {
      id: 'T4-05',
      feature: 'F8+F9+F10',
      name: 'Scenario 5: 技能与全系统就绪体检流 — SKILL.md + doctor.py + mcp_config.json + CSS/SPA + py_compile/node --check + 零泄密',
      async run(ctx) {
        if (!fs.existsSync(SKILL_MD_PATH) || !fs.existsSync(MCP_SCRIPT_PATH)) {
          pendingIfOffline(ctx, 'M3/M4 skill or MCP artifact not yet created');
        }
        // 1. SKILL.md frontmatter & sections
        const md = fs.readFileSync(SKILL_MD_PATH, 'utf8');
        const parsed = parseSkillFrontmatter(md);
        assert.equal(parsed.valid, true, parsed.reason);
        assert.equal(parsed.fields.name, 'video-auto-publisher');
        assert.ok(md.includes('video_publisher') && md.includes('18910') && md.includes('直接发'));

        // 2. skill-doctor audit
        const doc = runCommandSync(PYTHON_EXE, [SKILL_DOCTOR_SCRIPT, 'audit', SKILL_DIR, '--json', '--no-cache']);
        assert.equal(doc.status, 0, `doctor.py audit failed: ${doc.stdout}\n${doc.stderr}`);

        // 3. mcp_config.json & backup
        const cfg = JSON.parse(fs.readFileSync(MCP_CONFIG_PATH, 'utf8'));
        assert.ok(cfg?.mcpServers?.video_publisher, 'video_publisher missing in mcp_config.json');
        const cfgDir = path.dirname(MCP_CONFIG_PATH);
        const freshCutoffMs = Date.parse('2026-11-28T00:00:00Z');
        const freshBackups = fs
          .readdirSync(cfgDir)
          .filter((f) => /^mcp_config\.json\.bak/i.test(f))
          .filter((f) => {
            const full = path.join(cfgDir, f);
            const stat = fs.statSync(full);
            return (
              Math.max(stat.mtimeMs, stat.birthtimeMs || 0) >= freshCutoffMs &&
              !fs.readFileSync(full, 'utf8').includes('video_publisher')
            );
          });
        assert.ok(freshBackups.length >= 1, 'Fresh pre-M3 mcp_config.json backup (>= 2026-11-28, without video_publisher) missing');

        // 4. CSS compliance & SPA serving
        const css = scanCssCompliance(PROJECT_ROOT);
        assert.equal(css.ok, true, `CSS compliance failed: ${css.violations.join('; ')}`);
        const spa = await httpJson(ctx, `${ctx.baseUrl}/`);
        assert.equal(spa.status, 200);
        assert.ok(spa.text.includes('<div id="root">'));

        // 5. py_compile, node --check & secret scan
        const py = runCommandSync(PYTHON_EXE, [
          '-m',
          'py_compile',
          'sau-engine/sau_backend.py',
          'sau-engine/myUtils/postVideo.py',
          'sau-engine/uploader/xiaohongshu_uploader/main.py',
          'sau-engine/uploader/tencent_uploader/main.py',
          'sau-engine/uploader/douyin_uploader/main.py',
          'sau-engine/uploader/ks_uploader/main.py',
        ]);
        assert.equal(py.status, 0, `py_compile failed: ${py.stderr}`);
        const nd = runCommandSync(process.execPath, ['--check', MCP_SCRIPT_PATH]);
        assert.equal(nd.status, 0, `node --check failed: ${nd.stderr}`);

        const setRes = await httpJson(ctx, `${ctx.baseUrl}/api/settings`);
        assert.equal(setRes.status, 200);
        assert.deepEqual(scanForSecrets(setRes.text, 'T4-05_settings'), []);
      },
    },
  ];
}
