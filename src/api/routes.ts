import type { FastifyInstance } from 'fastify';
import { PATHS, PLATFORM_PROFILES, PORT, resolveChromiumExecutable, type ProfilePlatform } from '../config.js';
import { backupDatabase, getDb } from '../db/database.js';
import { getAdapter, listAdapters } from '../adapters/index.js';
import { recognizeSourceUrl } from '../adapters/urlRecognizer.js';
import {
  closeLoginWindow,
  listBrowserProfilesWithRuntime,
  openLoginWindow,
  updateProfileStatus,
} from '../browser/profileManager.js';
import { cancelCollection, enqueueCollection } from '../scheduler/taskRunner.js';
import { readRecentLogs } from '../utils/logger.js';
import {
  getSauStatus,
  installSauEngine,
  proxySauFileDownload,
  proxySauJson,
  proxySauMultipartUpload,
  proxySauSseLogin,
  setConfiguredSauDir,
  startSauBackend,
  stopSauBackend,
} from '../services/sauBridge.js';

export function registerRoutes(app: FastifyInstance, shutdownHandler: () => Promise<void>) {
  app.get('/api/health', async () => {
    const execPath = resolveChromiumExecutable();
    return {
      ok: true,
      pid: process.pid,
      port: PORT,
      dbFile: PATHS.dbFile,
      profilesRoot: PATHS.profilesRoot,
      chromiumAvailable: Boolean(execPath),
      chromiumPath: execPath || 'playwright-default',
      now: new Date().toISOString(),
    };
  });

  app.get('/api/overview', async () => {
    const db = getDb();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayIso = todayStart.toISOString();

    const totalSources = (db.prepare('SELECT COUNT(*) AS c FROM sources').get() as { c: number }).c;
    const websiteCount = (db.prepare("SELECT COUNT(*) AS c FROM sources WHERE platform IN ('website', 'rss')").get() as { c: number }).c;
    const creatorCount = totalSources - websiteCount;
    const todayNew = (db.prepare('SELECT COUNT(*) AS c FROM contents WHERE discovered_at >= ?').get(todayIso) as { c: number }).c;
    const unreadCount = (db.prepare('SELECT COUNT(*) AS c FROM contents WHERE is_read = 0').get() as { c: number }).c;
    const totalContents = (db.prepare('SELECT COUNT(*) AS c FROM contents').get() as { c: number }).c;
    const favCount = (db.prepare('SELECT COUNT(*) AS c FROM contents WHERE is_favorite = 1').get() as { c: number }).c;
    const successCount = (db.prepare("SELECT COUNT(*) AS c FROM collections WHERE status = 'success'").get() as { c: number }).c;
    const failedCount = (db.prepare("SELECT COUNT(*) AS c FROM collections WHERE status = 'failed'").get() as { c: number }).c;
    const authAlertCount = (db.prepare('SELECT COUNT(*) AS c FROM browser_profiles WHERE needs_attention = 1').get() as { c: number }).c;

    const adapters = listAdapters().map((a) => ({
      platform: a.platform,
      displayName: a.displayName,
      defaultCapability: a.defaultCapability,
    }));
    const profiles = listBrowserProfilesWithRuntime();
    const recentFailures = db
      .prepare(`
        SELECT c.id, c.source_id, s.name AS source_name, s.platform, c.status, c.error_message, c.finished_at
        FROM collections c
        JOIN sources s ON s.id = c.source_id
        WHERE c.status IN ('failed', 'auth_required')
        ORDER BY c.created_at DESC
        LIMIT 8
      `)
      .all();

    return {
      stats: {
        totalSources,
        websiteCount,
        creatorCount,
        todayNew,
        unreadCount,
        totalContents,
        favCount,
        successCount,
        failedCount,
        authAlertCount,
      },
      adapters,
      profiles,
      recentFailures,
    };
  });

  app.get('/api/categories', async () => {
    const db = getDb();
    return db.prepare('SELECT * FROM categories ORDER BY sort_order ASC, id ASC').all();
  });

  app.post<{ Body: { name: string } }>('/api/categories', async (req, reply) => {
    const name = (req.body?.name || '').trim();
    if (!name) return reply.code(400).send({ error: '分类名称不能为空' });
    const db = getDb();
    const res = db
      .prepare('INSERT OR IGNORE INTO categories (name, sort_order, created_at) VALUES (?, 99, ?)')
      .run(name, new Date().toISOString());
    const row = db.prepare('SELECT * FROM categories WHERE name = ?').get(name);
    return { created: res.changes > 0, category: row };
  });

  app.post<{ Body: { url: string; platform?: string } }>('/api/sources/probe', async (req, reply) => {
    const rawUrl = (req.body?.url || '').trim();
    if (!rawUrl) return reply.code(400).send({ error: '请输入有效链接' });
    const recognized = recognizeSourceUrl(rawUrl);
    const platform = req.body?.platform || recognized.platform;
    const adapter = getAdapter(platform);
    const availability = await adapter.checkAvailability(recognized.normalizedUrl);
    return {
      recognized: { ...recognized, platform },
      availability,
    };
  });

  app.get('/api/sources', async () => {
    const db = getDb();
    return db
      .prepare(`
        SELECT s.*, c.name AS category_name,
          (SELECT COUNT(*) FROM contents ct WHERE ct.source_id = s.id) AS content_count
        FROM sources s
        LEFT JOIN categories c ON c.id = s.category_id
        ORDER BY s.priority ASC, s.id DESC
      `)
      .all();
  });

  app.post<{
    Body: {
      name?: string;
      url: string;
      platform?: string;
      source_type?: string;
      category_id?: number | null;
      priority?: number;
      interval_minutes?: number;
      notes?: string;
      check_immediately?: boolean;
    };
  }>('/api/sources', async (req, reply) => {
    const rawUrl = (req.body?.url || '').trim();
    if (!rawUrl) return reply.code(400).send({ error: '主页链接不能为空' });

    const recognized = recognizeSourceUrl(rawUrl);
    const platform = (req.body.platform || recognized.platform).trim();
    const sourceType = (req.body.source_type || recognized.sourceType).trim();
    const adapter = getAdapter(platform);
    const probe = await adapter.checkAvailability(recognized.normalizedUrl);

    let finalName = (req.body.name || '').trim();
    if (!finalName) {
      finalName = probe.detectedTitle || new URL(recognized.normalizedUrl).hostname;
    }

    const db = getDb();
    const now = new Date().toISOString();
    const defaultInterval = platform === 'website' || platform === 'rss' ? 60 : 120;
    const interval = Math.max(5, Number(req.body.interval_minutes || defaultInterval));
    const priority = Number(req.body.priority || 2);

    const res = db
      .prepare(`
        INSERT INTO sources (
          name, platform, url, source_type, category_id, priority,
          interval_minutes, status, capability_status, notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
      `)
      .run(
        finalName,
        platform,
        recognized.normalizedUrl,
        sourceType,
        req.body.category_id || null,
        priority,
        interval,
        probe.capabilityStatus,
        (req.body.notes || '').trim(),
        now,
        now
      );

    const sourceId = Number(res.lastInsertRowid);
    let queuedTask = null;
    if (req.body.check_immediately !== false) {
      queuedTask = enqueueCollection(sourceId, 'manual');
    }
    const created = db.prepare('SELECT * FROM sources WHERE id = ?').get(sourceId);
    return { source: created, probe, queuedTask };
  });

  app.patch<{
    Params: { id: string };
    Body: {
      name?: string;
      url?: string;
      platform?: string;
      category_id?: number | null;
      priority?: number;
      interval_minutes?: number;
      status?: 'active' | 'paused';
      notes?: string;
    };
  }>('/api/sources/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const db = getDb();
    const existing = db.prepare('SELECT * FROM sources WHERE id = ?').get(id);
    if (!existing) return reply.code(404).send({ error: '监控对象不存在' });

    const b = req.body || {};
    db.prepare(`
      UPDATE sources SET
        name = COALESCE(?, name),
        url = COALESCE(?, url),
        platform = COALESCE(?, platform),
        category_id = ?,
        priority = COALESCE(?, priority),
        interval_minutes = COALESCE(?, interval_minutes),
        status = COALESCE(?, status),
        notes = COALESCE(?, notes),
        updated_at = ?
      WHERE id = ?
    `).run(
      b.name ?? null,
      b.url ?? null,
      b.platform ?? null,
      b.category_id !== undefined ? b.category_id : (existing as { category_id: number | null }).category_id,
      b.priority ?? null,
      b.interval_minutes ? Math.max(5, Number(b.interval_minutes)) : null,
      b.status ?? null,
      b.notes ?? null,
      new Date().toISOString(),
      id
    );
    return db.prepare('SELECT * FROM sources WHERE id = ?').get(id);
  });

  app.delete<{ Params: { id: string } }>('/api/sources/:id', async (req) => {
    const id = Number(req.params.id);
    const db = getDb();
    const res = db.prepare('DELETE FROM sources WHERE id = ?').run(id);
    return { deleted: res.changes > 0 };
  });

  app.post<{ Params: { id: string } }>('/api/sources/:id/check', async (req) => {
    const id = Number(req.params.id);
    return enqueueCollection(id, 'manual');
  });

  app.get<{
    Querystring: {
      platform?: string;
      sourceId?: string;
      categoryId?: string;
      isFavorite?: string;
      isRead?: string;
      q?: string;
      days?: string;
      limit?: string;
      offset?: string;
    };
  }>('/api/contents', async (req) => {
    const db = getDb();
    const q = req.query;
    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (q.platform && q.platform !== 'all') {
      conditions.push('c.platform = ?');
      params.push(q.platform);
    }
    if (q.sourceId) {
      conditions.push('c.source_id = ?');
      params.push(Number(q.sourceId));
    }
    if (q.categoryId) {
      conditions.push('s.category_id = ?');
      params.push(Number(q.categoryId));
    }
    if (q.isFavorite === '1' || q.isFavorite === 'true') {
      conditions.push('c.is_favorite = 1');
    }
    if (q.isRead === '0' || q.isRead === 'false') {
      conditions.push('c.is_read = 0');
    } else if (q.isRead === '1' || q.isRead === 'true') {
      conditions.push('c.is_read = 1');
    }
    if (q.days && Number(q.days) > 0) {
      const cutoff = new Date(Date.now() - Number(q.days) * 86400 * 1000).toISOString();
      conditions.push('c.discovered_at >= ?');
      params.push(cutoff);
    }
    if (q.q && q.q.trim()) {
      const term = q.q.trim();
      const likePattern = `%${term}%`;
      conditions.push('(c.title LIKE ? OR c.summary LIKE ? OR c.body LIKE ? OR c.author LIKE ?)');
      params.push(likePattern, likePattern, likePattern, likePattern);
    }

    const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(100, Math.max(1, Number(q.limit || 30)));
    const offset = Math.max(0, Number(q.offset || 0));

    const items = db
      .prepare(`
        SELECT
          c.id, c.source_id, c.platform, c.platform_item_id, c.canonical_url,
          c.title, c.author, c.summary, c.cover_url, c.tags_json,
          c.published_at, c.discovered_at, c.is_read, c.is_favorite,
          s.name AS source_name,
          (SELECT views FROM content_metrics m WHERE m.content_id = c.id ORDER BY m.captured_at DESC LIMIT 1) AS latest_views,
          (SELECT likes FROM content_metrics m WHERE m.content_id = c.id ORDER BY m.captured_at DESC LIMIT 1) AS latest_likes,
          (SELECT comments FROM content_metrics m WHERE m.content_id = c.id ORDER BY m.captured_at DESC LIMIT 1) AS latest_comments,
          (SELECT shares FROM content_metrics m WHERE m.content_id = c.id ORDER BY m.captured_at DESC LIMIT 1) AS latest_shares
        FROM contents c
        JOIN sources s ON s.id = c.source_id
        ${whereSql}
        ORDER BY COALESCE(c.published_at, c.discovered_at) DESC, c.id DESC
        LIMIT ? OFFSET ?
      `)
      .all(...params, limit, offset);

    const totalRow = db
      .prepare(`
        SELECT COUNT(*) AS total
        FROM contents c
        JOIN sources s ON s.id = c.source_id
        ${whereSql}
      `)
      .get(...params) as { total: number };

    return { items, total: totalRow.total, limit, offset };
  });

  app.get<{ Params: { id: string } }>('/api/contents/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const db = getDb();
    const item = db
      .prepare(`
        SELECT c.*, s.name AS source_name, s.url AS source_url
        FROM contents c
        JOIN sources s ON s.id = c.source_id
        WHERE c.id = ?
      `)
      .get(id);
    if (!item) return reply.code(404).send({ error: '内容不存在' });

    const metricsHistory = db
      .prepare('SELECT * FROM content_metrics WHERE content_id = ? ORDER BY captured_at ASC')
      .all(id);

    return { item, metricsHistory };
  });

  app.patch<{ Params: { id: string }; Body: { is_read?: boolean; is_favorite?: boolean } }>(
    '/api/contents/:id',
    async (req, reply) => {
      const id = Number(req.params.id);
      const db = getDb();
      const existing = db.prepare('SELECT id, is_read, is_favorite FROM contents WHERE id = ?').get(id) as
        | { id: number; is_read: number; is_favorite: number }
        | undefined;
      if (!existing) return reply.code(404).send({ error: '内容不存在' });

      const isRead = req.body.is_read !== undefined ? (req.body.is_read ? 1 : 0) : existing.is_read;
      const isFav = req.body.is_favorite !== undefined ? (req.body.is_favorite ? 1 : 0) : existing.is_favorite;
      db.prepare('UPDATE contents SET is_read = ?, is_favorite = ? WHERE id = ?').run(isRead, isFav, id);
      return { id, is_read: Boolean(isRead), is_favorite: Boolean(isFav) };
    }
  );

  app.get('/api/browsers', async () => {
    return listBrowserProfilesWithRuntime();
  });

  app.post<{ Params: { platform: string }; Body: { url?: string } }>(
    '/api/browsers/:platform/login-window',
    async (req, reply) => {
      const p = req.params.platform as ProfilePlatform;
      if (!PLATFORM_PROFILES.includes(p)) return reply.code(400).send({ error: '未知浏览器平台配置' });
      return openLoginWindow(p, req.body?.url);
    }
  );

  app.post<{ Params: { platform: string } }>('/api/browsers/:platform/close', async (req, reply) => {
    const p = req.params.platform as ProfilePlatform;
    if (!PLATFORM_PROFILES.includes(p)) return reply.code(400).send({ error: '未知浏览器平台配置' });
    return closeLoginWindow(p);
  });

  app.post<{ Params: { platform: string } }>('/api/browsers/:platform/check-login', async (req, reply) => {
    const p = req.params.platform as ProfilePlatform;
    if (!PLATFORM_PROFILES.includes(p)) return reply.code(400).send({ error: '未知浏览器平台配置' });
    const adapter = getAdapter(p === 'other' ? 'website' : p);
    const res = await adapter.checkLoginStatus();
    if (p === 'other') {
      updateProfileStatus('other', { login_status: 'optional', capability_status: '已接入并验证', needs_attention: 0 });
    }
    return res;
  });

  app.get('/api/tasks', async () => {
    const db = getDb();
    const tasks = db
      .prepare(`
        SELECT c.*, s.name AS source_name, s.platform, s.url AS source_url, s.interval_minutes, s.last_checked_at
        FROM collections c
        JOIN sources s ON s.id = c.source_id
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT 80
      `)
      .all();
    return tasks;
  });

  app.get<{ Params: { id: string } }>('/api/tasks/:id/logs', async (req) => {
    const id = Number(req.params.id);
    const db = getDb();
    return db.prepare('SELECT * FROM collection_logs WHERE collection_id = ? ORDER BY id ASC').all(id);
  });

  app.post<{ Params: { id: string } }>('/api/tasks/:id/cancel', async (req) => {
    return cancelCollection(Number(req.params.id));
  });

  app.get('/api/settings', async () => {
    const db = getDb();
    const rows = db.prepare('SELECT key, value FROM app_settings').all() as Array<{ key: string; value: string }>;
    const settings: Record<string, string> = {};
    for (const r of rows) settings[r.key] = r.value;
    return {
      settings,
      paths: PATHS,
      recentLogs: readRecentLogs(100),
    };
  });

  app.patch<{ Body: Record<string, string> }>('/api/settings', async (req) => {
    const db = getDb();
    const now = new Date().toISOString();
    const upsert = db.prepare(`
      INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    for (const [k, v] of Object.entries(req.body || {})) {
      upsert.run(k, String(v), now);
    }
    return { ok: true };
  });

  app.post('/api/backup', async () => {
    return backupDatabase();
  });

  app.post('/api/system/shutdown', async () => {
    setTimeout(() => {
      void shutdownHandler();
    }, 200);
    return { ok: true, message: '工作台服务正在安全关闭...' };
  });

  // ==================== SAU 视频一键发布融合接口 ====================
  app.get('/api/sau/status', async () => {
    return getSauStatus();
  });

  app.post<{ Body: { sauDir?: string } }>('/api/sau/config', async (req, reply) => {
    const dir = String(req.body?.sauDir || '').trim();
    if (!dir) {
      return reply.code(400).send({ ok: false, message: '请提供有效的发布项目目录路径' });
    }
    const saved = setConfiguredSauDir(dir);
    return { ok: true, sauDir: saved, status: await getSauStatus() };
  });

  app.post<{ Body: { sauDir?: string } }>('/api/sau/install', async (req) => {
    return installSauEngine(req.body?.sauDir);
  });

  app.post('/api/sau/start', async () => {
    return startSauBackend();
  });

  app.post('/api/sau/stop', async () => {
    return stopSauBackend(false);
  });

  app.get('/api/sau/accounts', async (_req, reply) => {
    const res = await proxySauJson('GET', '/getAccounts');
    return reply.code(res.status).send(res.payload);
  });

  app.post('/api/sau/accounts/validate', async (_req, reply) => {
    const res = await proxySauJson('GET', '/getValidAccounts', undefined, 120000);
    return reply.code(res.status).send(res.payload);
  });

  app.delete<{ Params: { id: string } }>('/api/sau/accounts/:id', async (req, reply) => {
    if (!/^\d+$/.test(req.params.id)) {
      return reply.code(400).send({ code: 400, msg: '非法账号 ID', data: null });
    }
    const res = await proxySauJson('GET', `/deleteAccount?id=${encodeURIComponent(req.params.id)}`);
    return reply.code(res.status).send(res.payload);
  });

  app.get<{ Querystring: { type?: string; id?: string } }>('/api/sau/login', async (req, reply) => {
    const type = String(req.query?.type || '');
    const id = String(req.query?.id || '');
    if (!['1', '2', '3', '4'].includes(type) || !id) {
      return reply.code(400).send({ code: 400, msg: '缺少或非法的平台类型/账号名称', data: null });
    }
    const qs = new URLSearchParams({ type, id }).toString();
    await proxySauSseLogin(req, reply, qs);
  });

  app.get('/api/sau/files', async (_req, reply) => {
    const res = await proxySauJson('GET', '/getFiles');
    return reply.code(res.status).send(res.payload);
  });

  app.delete<{ Params: { id: string } }>('/api/sau/files/:id', async (req, reply) => {
    if (!/^\d+$/.test(req.params.id)) {
      return reply.code(400).send({ code: 400, msg: '非法素材 ID', data: null });
    }
    const res = await proxySauJson('GET', `/deleteFile?id=${encodeURIComponent(req.params.id)}`);
    return reply.code(res.status).send(res.payload);
  });

  app.get<{ Querystring: { filename?: string } }>('/api/sau/file', async (req, reply) => {
    const filename = String(req.query?.filename || '');
    if (!filename) {
      return reply.code(400).send({ code: 400, msg: '缺少 filename 参数', data: null });
    }
    await proxySauFileDownload(req, reply, `/getFile?filename=${encodeURIComponent(filename)}`);
  });

  app.post('/api/sau/post-video', async (req, reply) => {
    const res = await proxySauJson('POST', '/postVideo', req.body, 300000);
    return reply.code(res.status).send(res.payload);
  });

  app.post('/api/sau/post-video-batch', async (req, reply) => {
    const res = await proxySauJson('POST', '/postVideoBatch', req.body, 300000);
    return reply.code(res.status).send(res.payload);
  });

  app.get('/api/sau/publish-history', async (req, reply) => {
    const limit = Number((req.query as { limit?: string })?.limit || 50) || 50;
    const res = await proxySauJson('GET', `/getPublishHistory?limit=${limit}`);
    return reply.code(res.status).send(res.payload);
  });

  app.delete<{ Params: { id: string } }>('/api/sau/publish-history/:id', async (req, reply) => {
    if (!/^\d+$/.test(req.params.id)) {
      return reply.code(400).send({ code: 400, msg: '非法记录 ID', data: null });
    }
    const res = await proxySauJson('GET', `/deletePublishRecord?id=${encodeURIComponent(req.params.id)}`);
    return reply.code(res.status).send(res.payload);
  });

  app.get('/api/sau/title-templates', async (req, reply) => {
    const q = (req.query as { category?: string; keyword?: string }) || {};
    const qs = new URLSearchParams();
    if (q.category) qs.set('category', q.category);
    if (q.keyword) qs.set('keyword', q.keyword);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    const res = await proxySauJson('GET', `/getTitleTemplates${suffix}`);
    return reply.code(res.status).send(res.payload);
  });

  app.post('/api/sau/title-templates', async (req, reply) => {
    const res = await proxySauJson('POST', '/saveTitleTemplate', req.body);
    return reply.code(res.status).send(res.payload);
  });

  app.delete<{ Params: { id: string } }>('/api/sau/title-templates/:id', async (req, reply) => {
    if (!/^\d+$/.test(req.params.id)) {
      return reply.code(400).send({ code: 400, msg: '非法模板 ID', data: null });
    }
    const res = await proxySauJson('GET', `/deleteTitleTemplate?id=${encodeURIComponent(req.params.id)}`);
    return reply.code(res.status).send(res.payload);
  });

  app.register(async (scoped) => {
    scoped.addContentTypeParser('multipart/form-data', (_req, payload, done) => {
      done(null, payload);
    });
    scoped.post('/api/sau/upload', async (req, reply) => {
      await proxySauMultipartUpload(req, reply);
    });
  });
}
