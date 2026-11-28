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

// V2 增量迁移：建设「选题监控中心」全部业务表与扩展字段（100% 保留 V1 兼容）
export const MIGRATION_V2_SQL = `
  -- 1. 扩展监控对象（博主档案与历史表现基线）
  ALTER TABLE sources ADD COLUMN follower_count INTEGER;
  ALTER TABLE sources ADD COLUMN avatar_url TEXT NOT NULL DEFAULT '';
  ALTER TABLE sources ADD COLUMN bio TEXT NOT NULL DEFAULT '';
  ALTER TABLE sources ADD COLUMN baseline_views REAL;
  ALTER TABLE sources ADD COLUMN baseline_likes REAL;
  ALTER TABLE sources ADD COLUMN baseline_comments REAL;
  ALTER TABLE sources ADD COLUMN baseline_engagement REAL;
  ALTER TABLE sources ADD COLUMN baseline_sample_size INTEGER NOT NULL DEFAULT 0;

  -- 2. 扩展内容表（类型、通义听悟口播转录、聚簇与异常爆款指数）
  ALTER TABLE contents ADD COLUMN content_type TEXT NOT NULL DEFAULT 'article';
  ALTER TABLE contents ADD COLUMN transcript TEXT NOT NULL DEFAULT '';
  ALTER TABLE contents ADD COLUMN transcript_status TEXT NOT NULL DEFAULT 'none';
  ALTER TABLE contents ADD COLUMN transcript_source TEXT NOT NULL DEFAULT '';
  ALTER TABLE contents ADD COLUMN cluster_id INTEGER;
  ALTER TABLE contents ADD COLUMN breakout_score REAL;
  ALTER TABLE contents ADD COLUMN breakout_ratio REAL;
  ALTER TABLE contents ADD COLUMN growth_rate_per_hour REAL;
  ALTER TABLE contents ADD COLUMN breakout_reason TEXT NOT NULL DEFAULT '';

  CREATE INDEX IF NOT EXISTS idx_contents_cluster ON contents(cluster_id);
  CREATE INDEX IF NOT EXISTS idx_contents_breakout ON contents(breakout_score DESC);
  CREATE INDEX IF NOT EXISTS idx_contents_type ON contents(content_type, discovered_at DESC);

  -- 3. 多自媒体账号定位与自定义 6 维评分权重
  CREATE TABLE IF NOT EXISTS creator_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    platform_focus TEXT NOT NULL DEFAULT '抖音 / B站 / 视频号',
    niche TEXT NOT NULL DEFAULT '',
    target_audience TEXT NOT NULL DEFAULT '',
    content_direction TEXT NOT NULL DEFAULT '',
    personal_expertise TEXT NOT NULL DEFAULT '',
    style_preferences TEXT NOT NULL DEFAULT '',
    is_active INTEGER NOT NULL DEFAULT 0,
    weight_match INTEGER NOT NULL DEFAULT 25,
    weight_heat INTEGER NOT NULL DEFAULT 25,
    weight_diff INTEGER NOT NULL DEFAULT 20,
    weight_experience INTEGER NOT NULL DEFAULT 15,
    weight_timeliness INTEGER NOT NULL DEFAULT 10,
    weight_feasibility INTEGER NOT NULL DEFAULT 5,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- 4. 真实评论区采集表（对接最新版 MediaCrawler）
  CREATE TABLE IF NOT EXISTS content_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_id INTEGER NOT NULL REFERENCES contents(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    platform_comment_id TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL,
    likes INTEGER,
    published_at TEXT,
    captured_at TEXT NOT NULL,
    UNIQUE(content_id, platform_comment_id)
  );
  CREATE INDEX IF NOT EXISTS idx_comments_content ON content_comments(content_id, likes DESC);

  -- 5. 事件/话题聚类表（将多个博主讨论的同一事件合并为一个话题，保留全部原始来源）
  CREATE TABLE IF NOT EXISTS topic_clusters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    trend_stage TEXT NOT NULL DEFAULT 'rising',
    heat_score REAL NOT NULL DEFAULT 0,
    source_count INTEGER NOT NULL DEFAULT 1,
    first_seen_at TEXT NOT NULL,
    latest_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_clusters_heat ON topic_clusters(heat_score DESC, latest_at DESC);

  -- 6. AI 请求回执与缓存表（防止重复分析产生无效调用和费用）
  CREATE TABLE IF NOT EXISTS ai_receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cache_key TEXT NOT NULL UNIQUE,
    purpose TEXT NOT NULL,
    model TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ok',
    response_json TEXT NOT NULL DEFAULT '{}',
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    latency_ms INTEGER,
    error_message TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ai_receipts_purpose ON ai_receipts(purpose, created_at DESC);

  -- 7. 内容级 AI 深度分析结果
  CREATE TABLE IF NOT EXISTS content_analyses (
    content_id INTEGER PRIMARY KEY REFERENCES contents(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    content_fingerprint TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '行业动态',
    summary_zh TEXT NOT NULL DEFAULT '',
    core_points_json TEXT NOT NULL DEFAULT '[]',
    audience_needs_json TEXT NOT NULL DEFAULT '[]',
    comment_pain_points_json TEXT NOT NULL DEFAULT '[]',
    diff_angles_json TEXT NOT NULL DEFAULT '[]',
    trend_judgement TEXT NOT NULL DEFAULT '',
    content_form_advice TEXT NOT NULL DEFAULT '',
    evidence_note TEXT NOT NULL DEFAULT '',
    analyzed_at TEXT NOT NULL
  );

  -- 8. 账号 × 内容 智能选题推荐与 5 类反馈状态
  CREATE TABLE IF NOT EXISTS topic_recommendations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES creator_accounts(id) ON DELETE CASCADE,
    content_id INTEGER NOT NULL REFERENCES contents(id) ON DELETE CASCADE,
    cluster_id INTEGER,
    recommended_title TEXT NOT NULL,
    core_viewpoint TEXT NOT NULL DEFAULT '',
    recommend_reason TEXT NOT NULL DEFAULT '',
    heat_evidence TEXT NOT NULL DEFAULT '',
    reference_sources_json TEXT NOT NULL DEFAULT '[]',
    suitable_format TEXT NOT NULL DEFAULT '',
    target_audience TEXT NOT NULL DEFAULT '',
    diff_angle TEXT NOT NULL DEFAULT '',
    creation_advice TEXT NOT NULL DEFAULT '',
    score_total REAL NOT NULL DEFAULT 0,
    score_match REAL NOT NULL DEFAULT 0,
    score_heat REAL NOT NULL DEFAULT 0,
    score_diff REAL NOT NULL DEFAULT 0,
    score_experience REAL NOT NULL DEFAULT 0,
    score_timeliness REAL NOT NULL DEFAULT 0,
    score_feasibility REAL NOT NULL DEFAULT 0,
    score_breakdown_json TEXT NOT NULL DEFAULT '{}',
    feedback_status TEXT NOT NULL DEFAULT 'none',
    feedback_note TEXT NOT NULL DEFAULT '',
    feedback_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(account_id, content_id)
  );
  CREATE INDEX IF NOT EXISTS idx_recs_account_score ON topic_recommendations(account_id, score_total DESC, updated_at DESC);

  -- 9. 自定义话题追踪（话题雷达）
  CREATE TABLE IF NOT EXISTS tracked_topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    domain TEXT NOT NULL DEFAULT '',
    keywords_json TEXT NOT NULL DEFAULT '[]',
    related_terms_json TEXT NOT NULL DEFAULT '[]',
    exclude_terms_json TEXT NOT NULL DEFAULT '[]',
    description TEXT NOT NULL DEFAULT '',
    interval_minutes INTEGER NOT NULL DEFAULT 120,
    alert_threshold INTEGER NOT NULL DEFAULT 3,
    status TEXT NOT NULL DEFAULT 'active',
    last_scanned_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS topic_matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_id INTEGER NOT NULL REFERENCES tracked_topics(id) ON DELETE CASCADE,
    content_id INTEGER NOT NULL REFERENCES contents(id) ON DELETE CASCADE,
    match_mode TEXT NOT NULL DEFAULT 'rule',
    relevance_score REAL NOT NULL DEFAULT 0,
    match_reason TEXT NOT NULL DEFAULT '',
    matched_at TEXT NOT NULL,
    UNIQUE(topic_id, content_id)
  );
  CREATE INDEX IF NOT EXISTS idx_topic_matches_topic ON topic_matches(topic_id, matched_at DESC);

  -- 10. 多平台行业热榜快照
  CREATE TABLE IF NOT EXISTS hot_board_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL,
    board_name TEXT NOT NULL,
    rank_no INTEGER NOT NULL DEFAULT 0,
    item_id TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    hot_value REAL,
    hot_label TEXT NOT NULL DEFAULT '',
    author TEXT NOT NULL DEFAULT '',
    cover_url TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    content_type TEXT NOT NULL DEFAULT 'hot_topic',
    account_relevance_score REAL,
    account_relevance_reason TEXT NOT NULL DEFAULT '',
    content_id INTEGER REFERENCES contents(id) ON DELETE SET NULL,
    captured_at TEXT NOT NULL,
    UNIQUE(platform, board_name, item_id)
  );
  CREATE INDEX IF NOT EXISTS idx_hot_board_captured ON hot_board_items(platform, captured_at DESC, rank_no ASC);

  -- 11. 个人选题库（服务端持久化 + 6 状态流转 + 复盘数据）
  CREATE TABLE IF NOT EXISTS topic_board (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER REFERENCES creator_accounts(id) ON DELETE SET NULL,
    source_content_id INTEGER REFERENCES contents(id) ON DELETE SET NULL,
    recommendation_id INTEGER REFERENCES topic_recommendations(id) ON DELETE SET NULL,
    cluster_id INTEGER,
    title TEXT NOT NULL,
    core_angle TEXT NOT NULL DEFAULT '',
    tags_json TEXT NOT NULL DEFAULT '[]',
    notes TEXT NOT NULL DEFAULT '',
    priority TEXT NOT NULL DEFAULT 'medium',
    status TEXT NOT NULL DEFAULT 'to_research',
    source_url TEXT NOT NULL DEFAULT '',
    reference_json TEXT NOT NULL DEFAULT '[]',
    published_url TEXT NOT NULL DEFAULT '',
    review_views INTEGER,
    review_likes INTEGER,
    review_favorites INTEGER,
    review_comments INTEGER,
    review_notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_topic_board_status ON topic_board(status, updated_at DESC);

  -- 12. 通义听悟音频转录任务表
  CREATE TABLE IF NOT EXISTS tingwu_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_id INTEGER NOT NULL REFERENCES contents(id) ON DELETE CASCADE,
    audio_path TEXT NOT NULL DEFAULT '',
    output_dir TEXT NOT NULL DEFAULT '',
    transcript_path TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'queued',
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tingwu_jobs_content ON tingwu_jobs(content_id, created_at DESC);
`;

// V3 增量迁移：新增对标博主 R2 三项统一分析表与 R4 评论区热门话题转选题表
export const MIGRATION_V3_SQL = `
  CREATE TABLE IF NOT EXISTS content_r2_analyses (
    content_id INTEGER PRIMARY KEY REFERENCES contents(id) ON DELETE CASCADE,
    what_it_says TEXT NOT NULL DEFAULT '',
    heat_verdict TEXT NOT NULL DEFAULT '',
    heat_level TEXT NOT NULL DEFAULT 'normal',
    remix_suitability TEXT NOT NULL DEFAULT '',
    remix_score REAL NOT NULL DEFAULT 0,
    remix_angle TEXT NOT NULL DEFAULT '',
    basis_source TEXT NOT NULL DEFAULT '标题简介+真实数据',
    model TEXT NOT NULL DEFAULT '',
    fingerprint TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_r2_analyses_score ON content_r2_analyses(remix_score DESC, updated_at DESC);

  CREATE TABLE IF NOT EXISTS comment_topic_ideas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_id INTEGER NOT NULL REFERENCES contents(id) ON DELETE CASCADE,
    topic TEXT NOT NULL,
    heat_note TEXT NOT NULL DEFAULT '',
    evidence_comments_json TEXT NOT NULL DEFAULT '[]',
    creation_idea_title TEXT NOT NULL DEFAULT '',
    creation_angle TEXT NOT NULL DEFAULT '',
    comments_snapshot_count INTEGER NOT NULL DEFAULT 0,
    saved_board_id INTEGER REFERENCES topic_board(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(content_id, topic)
  );
  CREATE INDEX IF NOT EXISTS idx_comment_topic_ideas_content ON comment_topic_ideas(content_id, id ASC);
`;
