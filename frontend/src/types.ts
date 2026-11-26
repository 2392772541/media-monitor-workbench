export interface Category {
  id: number;
  name: string;
  sort_order: number;
}

export interface SourceItem {
  id: number;
  name: string;
  platform: string;
  url: string;
  source_type: string;
  category_id: number | null;
  category_name?: string | null;
  priority: number;
  interval_minutes: number;
  status: 'active' | 'paused';
  capability_status: string;
  last_checked_at: string | null;
  last_content_at: string | null;
  last_error: string | null;
  notes: string;
  content_count?: number;
  created_at: string;
}

export interface ContentSummary {
  id: number;
  source_id: number;
  source_name: string;
  platform: string;
  platform_item_id: string | null;
  canonical_url: string;
  title: string;
  author: string;
  summary: string;
  body?: string;
  cover_url: string;
  tags_json: string;
  published_at: string | null;
  discovered_at: string;
  is_read: number;
  is_favorite: number;
  latest_views: number | null;
  latest_likes: number | null;
  latest_comments: number | null;
  latest_shares: number | null;
}

export interface MetricSnapshot {
  id: number;
  content_id: number;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  favorites: number | null;
  captured_at: string;
}

export interface BrowserProfile {
  platform: string;
  display_name: string;
  profile_dir: string;
  login_status: string;
  capability_status: string;
  last_checked_at: string | null;
  last_used_at: string | null;
  needs_attention: number;
  note: string;
  is_running: boolean;
  running_mode: string | null;
  running_owner: string | null;
}

export interface CollectionTask {
  id: number;
  source_id: number;
  source_name: string;
  platform: string;
  trigger_type: string;
  status: 'queued' | 'running' | 'success' | 'failed' | 'cancelled' | 'auth_required';
  started_at: string | null;
  finished_at: string | null;
  items_found: number;
  items_new: number;
  items_updated: number;
  error_message: string | null;
  interval_minutes: number;
  last_checked_at: string | null;
  created_at: string;
}

export interface PublishInspirationDraft {
  title: string;
  tags: string[];
  sourceName?: string;
  sourceUrl?: string;
}

export interface OverviewData {
  stats: {
    totalSources: number;
    websiteCount: number;
    creatorCount: number;
    todayNew: number;
    unreadCount: number;
    totalContents: number;
    favCount: number;
    successCount: number;
    failedCount: number;
    authAlertCount: number;
  };
  publishSummary?: {
    installed: boolean;
    running: boolean;
    lastError: string | null;
    totalAccounts: number;
    invalidAccounts: number;
    totalFiles: number;
    totalTemplates: number;
  };
  adapters: Array<{ platform: string; displayName: string; defaultCapability: string }>;
  profiles: BrowserProfile[];
  recentFailures: Array<{
    id: number;
    source_id: number;
    source_name: string;
    platform: string;
    status: string;
    error_message: string | null;
    finished_at: string | null;
  }>;
}

// ===== 选题监控中心 V2 类型 =====

export interface CreatorAccount {
  id: number;
  name: string;
  platform_focus: string;
  niche: string;
  target_audience: string;
  content_direction: string;
  personal_expertise: string;
  style_preferences: string;
  is_active: number;
  weight_match: number;
  weight_heat: number;
  weight_diff: number;
  weight_experience: number;
  weight_timeliness: number;
  weight_feasibility: number;
  created_at: string;
  updated_at: string;
}

export interface TopicRecommendation {
  id: number;
  account_id: number;
  content_id: number;
  cluster_id: number | null;
  recommended_title: string;
  core_viewpoint: string;
  recommend_reason: string;
  heat_evidence: string;
  reference_sources_json: string;
  suitable_format: string;
  target_audience: string;
  diff_angle: string;
  creation_advice: string;
  score_total: number;
  score_match: number;
  score_heat: number;
  score_diff: number;
  score_experience: number;
  score_timeliness: number;
  score_feasibility: number;
  score_breakdown_json: string;
  feedback_status: string;
  feedback_note: string;
  feedback_at: string | null;
  platform?: string;
  canonical_url?: string;
  origin_title?: string;
  source_name?: string;
  author?: string;
  published_at?: string | null;
  discovered_at?: string;
  breakout_ratio?: number | null;
  breakout_score?: number | null;
  transcript_status?: string;
  latest_views?: number | null;
  latest_likes?: number | null;
  latest_comments?: number | null;
  in_board_count?: number;
}

export interface TopicCluster {
  id: number;
  title: string;
  summary: string;
  trend_stage: string;
  heat_score: number;
  source_count: number;
  first_seen_at: string;
  latest_at: string;
  members?: Array<{
    id: number;
    title: string;
    platform: string;
    canonical_url: string;
    author: string;
    source_name: string;
    breakout_ratio: number | null;
    latest_views: number | null;
    latest_likes: number | null;
    published_at: string | null;
    discovered_at: string;
  }>;
}

export interface CockpitData {
  activeAccount: CreatorAccount;
  accounts: CreatorAccount[];
  stats: {
    totalSources: number;
    totalContents: number;
    todayNew: number;
    breakoutCount: number;
    boardActiveCount: number;
    savedCount?: number;
    hotBoardCount: number;
  };
  trend7d: Array<{ day: string; total: number; breakouts: number }>;
  trend14d?: Array<{ day: string; total: number; breakouts: number }>;
  platformDistribution?: Array<{ platform: string; count: number }>;
  hotTop?: HotBoardItem[];
  recommendations: TopicRecommendation[];
  breakouts: Array<{
    id: number;
    title: string;
    platform: string;
    author: string;
    canonical_url: string;
    source_name: string;
    follower_count: number | null;
    breakout_score: number | null;
    breakout_ratio: number | null;
    growth_rate_per_hour: number | null;
    breakout_reason: string;
    brief?: string;
    transcript_status?: string;
    comment_rows?: number;
    saved_board_id?: number | null;
    latest_views: number | null;
    latest_likes: number | null;
    latest_comments: number | null;
    published_at: string | null;
    discovered_at: string;
  }>;
  clusters: TopicCluster[];
  topicAlerts: Array<{
    id: number;
    name: string;
    domain: string;
    alert_threshold: number;
    recent_hits: number;
  }>;
  recentItems: Array<{
    id: number;
    title: string;
    platform: string;
    author: string;
    canonical_url: string;
    source_name: string;
    content_type: string;
    breakout_ratio: number | null;
    ai_category: string;
    brief: string;
    published_at: string | null;
    discovered_at: string;
  }>;
  aiHealth: {
    baseUrl: string;
    model: string;
    configured: boolean;
    keySource: string;
    totalReceipts: number;
    okReceipts: number;
    analyzedCount: number;
    recCount: number;
  };
}

export interface CreatorMonitorRow extends SourceItem {
  follower_count: number | null;
  avatar_url: string;
  bio: string;
  baseline_views: number | null;
  baseline_likes: number | null;
  baseline_comments: number | null;
  baseline_engagement: number | null;
  baseline_sample_size: number;
  breakout_count: number;
  max_breakout_ratio: number | null;
}

export interface HotBoardItem {
  id: number;
  platform: string;
  board_name: string;
  rank_no: number;
  item_id: string;
  title: string;
  url: string;
  hot_value: number | null;
  hot_label: string;
  author: string;
  cover_url: string;
  summary: string;
  category: string;
  content_type: string;
  account_relevance_score: number | null;
  account_relevance_reason: string;
  content_id: number | null;
  ai_summary?: string | null;
  saved_board_id?: number | null;
  captured_at: string;
}

export interface TrackedTopic {
  id: number;
  name: string;
  domain: string;
  keywords_json: string;
  related_terms_json: string;
  exclude_terms_json: string;
  description: string;
  interval_minutes: number;
  alert_threshold: number;
  status: 'active' | 'paused';
  last_scanned_at: string | null;
  total_matches: number;
  recent_7d_matches: number;
  avg_relevance: number | null;
}

export interface IntelItem {
  id: number;
  source_id: number;
  source_name: string;
  platform: string;
  canonical_url: string;
  title: string;
  author: string;
  summary: string;
  cover_url: string;
  tags_json: string;
  published_at: string | null;
  discovered_at: string;
  content_type: string;
  transcript_status: string;
  transcript_source: string;
  transcript_chars: number;
  cluster_id: number | null;
  cluster_title: string | null;
  cluster_source_count: number | null;
  breakout_score: number | null;
  breakout_ratio: number | null;
  growth_rate_per_hour: number | null;
  breakout_reason: string;
  follower_count: number | null;
  ai_category: string | null;
  summary_zh: string | null;
  trend_judgement: string | null;
  content_form_advice: string | null;
  analyzed_at: string | null;
  recommendation_id: number | null;
  rec_score: number | null;
  rec_title: string | null;
  feedback_status: string | null;
  latest_views: number | null;
  latest_likes: number | null;
  latest_comments: number | null;
  latest_favorites: number | null;
  latest_shares: number | null;
  comment_rows: number;
  in_board_count: number;
}

export interface TopicBoardItem {
  id: number;
  account_id: number | null;
  account_name?: string | null;
  source_content_id: number | null;
  recommendation_id: number | null;
  cluster_id: number | null;
  title: string;
  core_angle: string;
  tags_json: string;
  notes: string;
  priority: 'high' | 'medium' | 'low';
  status: 'to_research' | 'to_create' | 'creating' | 'to_publish' | 'published' | 'reviewed';
  source_url: string;
  reference_json: string;
  published_url: string;
  review_views: number | null;
  review_likes: number | null;
  review_favorites: number | null;
  review_comments: number | null;
  review_notes: string;
  content_platform?: string | null;
  content_author?: string | null;
  breakout_ratio?: number | null;
  transcript_status?: string | null;
  ai_summary?: string | null;
  comment_rows?: number;
  source_origin?: 'hotboard' | 'creator' | 'manual';
  created_at: string;
  updated_at: string;
}

export interface IntegrationsStatus {
  ai: CockpitData['aiHealth'];
  mediaCrawler: {
    installed: boolean;
    dir: string;
    gitCommit: string;
    running: boolean;
    currentTask: string | null;
    lastLog: string[];
    lastError: string | null;
  };
  tingwu: {
    installed: boolean;
    dir: string;
    profileExists: boolean;
    ytDlpAvailable: boolean;
    ffmpegAvailable: boolean;
    running: boolean;
    currentJob: string | null;
    lastLogs: string[];
  };
}
