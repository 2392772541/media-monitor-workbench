export const MIGRATION_V1_SQL = `
  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    platform TEXT NOT NULL,
    url TEXT NOT NULL,
    source_type TEXT NOT NULL DEFAULT 'website',
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    priority INTEGER NOT NULL DEFAULT 2,
    interval_minutes INTEGER NOT NULL DEFAULT 60,
    status TEXT NOT NULL DEFAULT 'active',
    capability_status TEXT NOT NULL DEFAULT '已接入并验证',
    last_checked_at TEXT,
    last_content_at TEXT,
    last_error TEXT,
    notes TEXT DEFAULT '',
    config_json TEXT DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS contents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    platform_item_id TEXT,
    canonical_url TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    title TEXT NOT NULL,
    author TEXT DEFAULT '',
    summary TEXT DEFAULT '',
    body TEXT DEFAULT '',
    cover_url TEXT DEFAULT '',
    tags_json TEXT DEFAULT '[]',
    published_at TEXT,
    page_updated_at TEXT,
    discovered_at TEXT NOT NULL,
    is_read INTEGER NOT NULL DEFAULT 0,
    is_favorite INTEGER NOT NULL DEFAULT 0,
    raw_meta_json TEXT DEFAULT '{}',
    UNIQUE(platform, canonical_url)
  );

  CREATE INDEX IF NOT EXISTS idx_contents_source ON contents(source_id, discovered_at DESC);
  CREATE INDEX IF NOT EXISTS idx_contents_platform_item ON contents(platform, platform_item_id);
  CREATE INDEX IF NOT EXISTS idx_contents_hash ON contents(platform, content_hash);
  CREATE INDEX IF NOT EXISTS idx_contents_discovered ON contents(discovered_at DESC);
  CREATE INDEX IF NOT EXISTS idx_contents_fav ON contents(is_favorite, discovered_at DESC);

  CREATE VIRTUAL TABLE IF NOT EXISTS contents_fts USING fts5(
    title,
    author,
    summary,
    body,
    content='contents',
    content_rowid='id'
  );

  CREATE TRIGGER IF NOT EXISTS contents_ai AFTER INSERT ON contents BEGIN
    INSERT INTO contents_fts(rowid, title, author, summary, body)
    VALUES (new.id, new.title, new.author, new.summary, new.body);
  END;

  CREATE TRIGGER IF NOT EXISTS contents_ad AFTER DELETE ON contents BEGIN
    INSERT INTO contents_fts(contents_fts, rowid, title, author, summary, body)
    VALUES ('delete', old.id, old.title, old.author, old.summary, old.body);
  END;

  CREATE TRIGGER IF NOT EXISTS contents_au AFTER UPDATE ON contents BEGIN
    INSERT INTO contents_fts(contents_fts, rowid, title, author, summary, body)
    VALUES ('delete', old.id, old.title, old.author, old.summary, old.body);
    INSERT INTO contents_fts(rowid, title, author, summary, body)
    VALUES (new.id, new.title, new.author, new.summary, new.body);
  END;

  CREATE TABLE IF NOT EXISTS content_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_id INTEGER NOT NULL REFERENCES contents(id) ON DELETE CASCADE,
    views INTEGER,
    likes INTEGER,
    comments INTEGER,
    shares INTEGER,
    favorites INTEGER,
    captured_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_metrics_content ON content_metrics(content_id, captured_at DESC);

  CREATE TABLE IF NOT EXISTS collections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    trigger_type TEXT NOT NULL DEFAULT 'manual',
    status TEXT NOT NULL DEFAULT 'queued',
    started_at TEXT,
    finished_at TEXT,
    items_found INTEGER NOT NULL DEFAULT 0,
    items_new INTEGER NOT NULL DEFAULT 0,
    items_updated INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_collections_source ON collections(source_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS collection_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    level TEXT NOT NULL DEFAULT 'INFO',
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS browser_profiles (
    platform TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    profile_dir TEXT NOT NULL,
    login_status TEXT NOT NULL DEFAULT 'unknown',
    capability_status TEXT NOT NULL DEFAULT '需要登录',
    last_checked_at TEXT,
    last_used_at TEXT,
    needs_attention INTEGER NOT NULL DEFAULT 0,
    note TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;
