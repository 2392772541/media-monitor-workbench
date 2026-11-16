import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { PATHS, PLATFORM_PROFILES, getSafeProfileDir } from '../config.js';
import { log } from '../utils/logger.js';
import { MIGRATION_V1_SQL } from './schema.js';

let dbInstance: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!dbInstance) {
    fs.mkdirSync(path.dirname(PATHS.dbFile), { recursive: true });
    dbInstance = new DatabaseSync(PATHS.dbFile);
    dbInstance.exec('PRAGMA journal_mode = WAL;');
    dbInstance.exec('PRAGMA foreign_keys = ON;');
    dbInstance.exec('PRAGMA busy_timeout = 5000;');
    runMigrations(dbInstance);
  }
  return dbInstance;
}

export function closeDb(): void {
  if (dbInstance) {
    try {
      dbInstance.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      dbInstance.close();
    } catch (err) {
      log('WARN', 'db', `Close DB warning: ${(err as Error).message}`);
    }
    dbInstance = null;
  }
}

function runMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map((r) => r.version)
  );

  const migrations: Array<{ version: number; name: string; sql: string }> = [
    { version: 1, name: 'initial_schema', sql: MIGRATION_V1_SQL },
  ];

  for (const m of migrations) {
    if (!applied.has(m.version)) {
      db.exec('BEGIN;');
      try {
        db.exec(m.sql);
        db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
          m.version,
          m.name,
          new Date().toISOString()
        );
        db.exec('COMMIT;');
        log('INFO', 'db', `Applied migration v${m.version}: ${m.name}`);
      } catch (err) {
        db.exec('ROLLBACK;');
        throw err;
      }
    }
  }

  seedDefaults(db);
}

function seedDefaults(db: DatabaseSync): void {
  const now = new Date().toISOString();
  const defaultCats = ['默认分类', '科技资讯', '行业网站', '视频博主', '个人博客'];
  const insertCat = db.prepare('INSERT OR IGNORE INTO categories (name, sort_order, created_at) VALUES (?, ?, ?)');
  defaultCats.forEach((name, idx) => insertCat.run(name, idx, now));

  const platformDisplay: Record<string, { name: string; cap: string; note: string }> = {
    douyin: { name: '抖音', cap: '需要登录', note: '独立浏览器配置，首次需扫码登录后方可访问受限主页' },
    kuaishou: { name: '快手', cap: '需要登录', note: '独立浏览器配置，支持扫码维护登录状态' },
    'wechat-channels': { name: '微信视频号', cap: '需要登录', note: '受微信生态限制，需扫码登录视频号助手/网页端并验证权限范围' },
    x: { name: 'X (Twitter)', cap: '需要登录', note: '独立浏览器配置，登录后可查看关注或公开博主时间线' },
    youtube: { name: 'YouTube', cap: '已接入并验证', note: '优先通过公开频道 RSS 获取，同时支持独立浏览器上下文' },
    other: { name: '通用动态网页', cap: '已接入并验证', note: '用于需要 JS 渲染的普通网站或独立页面' },
  };

  const insertProfile = db.prepare(`
    INSERT OR IGNORE INTO browser_profiles
      (platform, display_name, profile_dir, login_status, capability_status, note)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const p of PLATFORM_PROFILES) {
    const meta = platformDisplay[p];
    insertProfile.run(
      p,
      meta.name,
      getSafeProfileDir(p),
      p === 'other' || p === 'youtube' ? 'optional' : 'unknown',
      meta.cap,
      meta.note
    );
  }

  const defaults: Record<string, string> = {
    default_website_interval: '60',
    default_creator_interval: '120',
    browser_mode: 'headless',
    scheduler_enabled: 'true',
    auto_backup_enabled: 'true',
  };
  const insertSet = db.prepare('INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)');
  for (const [k, v] of Object.entries(defaults)) {
    insertSet.run(k, v, now);
  }
}

export function canonicalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = '';
    const dropParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'spm', 'from', 'vd_source'];
    for (const key of dropParams) {
      u.searchParams.delete(key);
    }
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.toString();
  } catch {
    return raw.trim();
  }
}

export function computeContentHash(title: string, bodyOrSummary: string, canonicalUrl: string): string {
  return crypto
    .createHash('sha256')
    .update(`${title.trim()}|${bodyOrSummary.trim().slice(0, 500)}|${canonicalUrl}`)
    .digest('hex');
}

export interface UpsertContentInput {
  sourceId: number;
  platform: string;
  platformItemId?: string | null;
  url: string;
  title: string;
  author?: string;
  summary?: string;
  body?: string;
  coverUrl?: string;
  tags?: string[];
  publishedAt?: string | null;
  pageUpdatedAt?: string | null;
  rawMeta?: Record<string, unknown>;
  metrics?: {
    views?: number | null;
    likes?: number | null;
    comments?: number | null;
    shares?: number | null;
    favorites?: number | null;
  };
}

export function upsertContentWithMetrics(input: UpsertContentInput): { contentId: number; isNew: boolean; metricsUpdated: boolean } {
  const db = getDb();
  const now = new Date().toISOString();
  const canonicalUrl = canonicalizeUrl(input.url);
  const contentHash = computeContentHash(input.title, input.body || input.summary || '', canonicalUrl);

  let existing: { id: number; title: string; body: string } | undefined;

  if (input.platformItemId) {
    existing = db
      .prepare('SELECT id, title, body FROM contents WHERE platform = ? AND platform_item_id = ? LIMIT 1')
      .get(input.platform, input.platformItemId) as { id: number; title: string; body: string } | undefined;
  }
  if (!existing) {
    existing = db
      .prepare('SELECT id, title, body FROM contents WHERE platform = ? AND canonical_url = ? LIMIT 1')
      .get(input.platform, canonicalUrl) as { id: number; title: string; body: string } | undefined;
  }
  if (!existing) {
    existing = db
      .prepare('SELECT id, title, body FROM contents WHERE platform = ? AND content_hash = ? LIMIT 1')
      .get(input.platform, contentHash) as { id: number; title: string; body: string } | undefined;
  }

  let contentId: number;
  let isNew = false;

  if (!existing) {
    const res = db
      .prepare(`
        INSERT INTO contents (
          source_id, platform, platform_item_id, canonical_url, content_hash,
          title, author, summary, body, cover_url, tags_json,
          published_at, page_updated_at, discovered_at, raw_meta_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.sourceId,
        input.platform,
        input.platformItemId || null,
        canonicalUrl,
        contentHash,
        input.title.trim() || '(无标题)',
        (input.author || '').trim(),
        (input.summary || '').trim(),
        (input.body || '').trim(),
        input.coverUrl || '',
        JSON.stringify(input.tags || []),
        input.publishedAt || null,
        input.pageUpdatedAt || null,
        now,
        JSON.stringify(input.rawMeta || {})
      );
    contentId = Number(res.lastInsertRowid);
    isNew = true;
  } else {
    contentId = existing.id;
    const nextTitle = input.title.trim() || existing.title;
    const nextBody = (input.body || '').trim().length > existing.body.length ? (input.body || '').trim() : existing.body;
    db.prepare(`
      UPDATE contents SET
        title = ?,
        body = ?,
        cover_url = CASE WHEN ? != '' THEN ? ELSE cover_url END,
        page_updated_at = COALESCE(?, page_updated_at)
      WHERE id = ?
    `).run(nextTitle, nextBody, input.coverUrl || '', input.coverUrl || '', input.pageUpdatedAt || null, contentId);
  }

  let metricsUpdated = false;
  if (input.metrics && Object.values(input.metrics).some((v) => v !== null && v !== undefined)) {
    const m = input.metrics;
    const latest = db
      .prepare(`
        SELECT views, likes, comments, shares, favorites
        FROM content_metrics WHERE content_id = ? ORDER BY captured_at DESC LIMIT 1
      `)
      .get(contentId) as
      | { views: number | null; likes: number | null; comments: number | null; shares: number | null; favorites: number | null }
      | undefined;

    const changed =
      !latest ||
      latest.views !== (m.views ?? null) ||
      latest.likes !== (m.likes ?? null) ||
      latest.comments !== (m.comments ?? null) ||
      latest.shares !== (m.shares ?? null) ||
      latest.favorites !== (m.favorites ?? null);

    if (changed) {
      db.prepare(`
        INSERT INTO content_metrics (content_id, views, likes, comments, shares, favorites, captured_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        contentId,
        m.views ?? null,
        m.likes ?? null,
        m.comments ?? null,
        m.shares ?? null,
        m.favorites ?? null,
        now
      );
      metricsUpdated = true;
    }
  }

  return { contentId, isNew, metricsUpdated };
}

export function backupDatabase(): { backupPath: string; sizeBytes: number } {
  const db = getDb();
  fs.mkdirSync(PATHS.backupsDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(PATHS.backupsDir, `workbench-backup-${ts}.db`);
  const escaped = backupPath.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escaped}';`);
  const stat = fs.statSync(backupPath);
  log('INFO', 'db', `Database backed up to ${backupPath} (${stat.size} bytes)`);
  return { backupPath, sizeBytes: stat.size };
}
