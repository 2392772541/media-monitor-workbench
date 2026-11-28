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
  script?: string;
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
  hotCategoryDistribution?: Array<{ name: string; count: number }>;
  hotTop?: HotBoardItem[];
  douyinHot?: HotBoardItem[];
  bilibiliHot?: HotBoardItem[];
  recommendations: TopicRecommendation[];
  breakouts: Array<{
    id: number;
    title: string;
    platform: string;
    author: string;
    canonical_url: string;
    cover_url?: string;
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
    latest_favorites?: number | null;
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
  matched_keywords?: string[];
  is_vertical?: boolean;
  captured_at: string;
}

export interface BoardSourceConfig {
  id: string;
  name: string;
  platform: string;
  kind: 'bili_rank' | 'bili_popular' | 'douyin_hot' | 'github_trending' | 'rss';
  url?: string;
  rid?: number;
  category: string;
  isVertical: boolean;
  enabled: boolean;
  builtin?: boolean;
}

export interface NewsSourceConfig {
  id: string;
  name: string;
  region: 'domestic' | 'global';
  kind: 'rss' | 'hn_api' | 'github_trending';
  url: string;
  category: string;
  enabled: boolean;
  builtin?: boolean;
}

export interface NewsBriefItem {
  id: string;
  sourceId: string;
  sourceName: string;
  region: 'domestic' | 'global';
  category: string;
  title: string;
  titleZh?: string;
  summary: string;
  summaryZh?: string;
  url: string;
  publishedAt: string | null;
  heatLabel?: string;
  matchedKeywords: string[];
}

export interface DailyAiDigest {
  headline: string;
  topStories: Array<{
    titleZh: string;
    region: 'domestic' | 'global';
    sourceName: string;
    whyItMatters: string;
    videoAngle: string;
    url: string;
  }>;
  generatedAt: string;
}

export interface NewsBriefSnapshot {
  updatedAt: string | null;
  items: NewsBriefItem[];
  sourceStats: Array<{ id: string; name: string; region: 'domestic' | 'global'; count: number; error?: string }>;
  digest: DailyAiDigest | null;
  focusKeywords: string[];
  blockKeywords: string[];
  newsSources: NewsSourceConfig[];
}

export interface CreatorLeaderboardItem {
  rank: number;
  id: number;
  source_id: number;
  title: string;
  platform: string;
  author: string;
  canonical_url: string;
  cover_url?: string;
  summary: string;
  published_at: string | null;
  discovered_at: string;
  transcript_status: string;
  transcript_chars: number;
  breakout_score: number | null;
  breakout_ratio: number | null;
  breakout_reason: string;
  source_name: string;
  follower_count: number | null;
  baseline_views: number | null;
  baseline_likes: number | null;
  brief: string;
  latest_views: number | null;
  latest_likes: number | null;
  latest_comments: number | null;
  latest_favorites: number | null;
  comment_rows: number;
  saved_board_id: number | null;
  has_breakdown: boolean;
  remix_draft_count: number;
}

export interface ViralBreakdown {
  hookAnalysis: string;
  structureSteps: Array<{ stage: string; summary: string; technique: string }>;
  viralDrivers: string[];
  remixAngles: Array<{ title: string; angle: string; targetAudience: string; whyBetter: string }>;
  usedTranscript: boolean;
  analyzedAt: string;
}

export interface RemixScriptDraft {
  id: string;
  angle: string;
  tone: string;
  lengthLabel: string;
  newTitle: string;
  hookLine: string;
  scriptText: string;
  shootingTips: string[];
  tags: string[];
  createdAt: string;
}

export interface ContentRemixRecord {
  contentId: number;
  breakdown: ViralBreakdown | null;
  drafts: RemixScriptDraft[];
  updatedAt: string;
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
    engine?: string;
    pythonExe?: string;
    model?: string;
    gpuReady?: boolean;
    dir: string;
    profileExists: boolean;
    ytDlpAvailable: boolean;
    ffmpegAvailable: boolean;
    running: boolean;
    currentJob: string | null;
    lastLogs: string[];
  };
}

export interface PublishPlatformCopy {
  title: string;
  description: string;
  tags: string[];
  tip: string;
}

export interface PublishScriptSources {
  transcripts: Array<{
    id: number;
    title: string;
    platform: string;
    author: string;
    transcript: string;
    discovered_at: string;
  }>;
  saved: Array<{
    id: number;
    title: string;
    core_angle: string;
    notes: string;
    source_content_id: number | null;
    updated_at: string;
  }>;
}

export interface CrawledCommentRow {
  id: string;
  author: string;
  text: string;
  likes: number;
  publishedAt: string | null;
  postTitle?: string;
  postUrl?: string;
}

export interface CommentCrawlAiSummary {
  topQuestions: string[];
  painPoints: string[];
  topicAngles: string[];
  oneLineTakeaway: string;
  analyzedAt: string;
}

export interface CommentCrawlJobSummary {
  id: string;
  platform: string;
  mode: 'detail' | 'search' | 'creator';
  input: string;
  status: 'running' | 'done' | 'failed';
  message: string;
  logs: string[];
  aiSummary?: CommentCrawlAiSummary | null;
  createdAt: string;
  finishedAt?: string | null;
  commentCount: number;
}

export interface CommentCrawlJob extends Omit<CommentCrawlJobSummary, 'commentCount'> {
  comments: CrawledCommentRow[];
}

// ===== 对标博主升级 & 评论话题转化（R1–R4）类型 =====

export interface R2AnalysisPayload {
  contentId: number;
  whatItSays: string;
  heatVerdict: string;
  heatLevel: 'viral' | 'hot' | 'normal' | 'low' | 'unknown';
  remixSuitability: string;
  remixScore: number;
  remixAngle: string;
  basisSource: '口播全文+真实数据' | '标题简介+真实数据';
  updatedAt: string;
}

export interface RemixCompareItem {
  contentId: number;
  title: string;
  rank: number;
  remixScore: number;
  verdict: string;
  reason: string;
  suggestedHook: string;
}

export interface RemixCompareResponse {
  ok: boolean;
  bestContentId: number | null;
  summary: string;
  rankings: RemixCompareItem[];
}

export interface CommentTopicIdeaItem {
  id: number;
  topic: string;
  heatNote: string;
  evidenceComments: string[];
  creationIdeaTitle: string;
  creationAngle: string;
  savedBoardId: number | null;
}

export interface CreatorCopyDigest {
  contentId: number;
  overview: string;
  keyPoints: string[];
  actionItems: string[];
  usedTranscript: boolean;
  sourceKind?: 'transcript' | 'article';
  sourceChars: number;
  transcriptChars?: number;
  generatedAt: string;
}

export interface TrackerCreator {
  id: number;
  name: string;
  platform: string;
  url: string;
  source_type?: string;
  status: string;
  interval_minutes: number;
  last_checked_at: string | null;
  last_error: string | null;
  follower_count: number | null;
  avatar_url?: string;
  content_count: number;
  unread_count: number;
  today_new_count: number;
  latest_published_at: string | null;
  is_running: boolean;
}

export interface TrackerVideoItem {
  id: number;
  source_id: number;
  source_name: string;
  source_type?: string;
  platform: string;
  canonical_url: string;
  title: string;
  author: string;
  cover_url?: string;
  summary: string;
  body: string;
  transcript: string;
  transcript_status: string;
  transcript_chars: number;
  transcript_preview?: string;
  published_at: string | null;
  discovered_at: string;
  is_read: number;
  breakout_score?: number | null;
  breakout_ratio?: number | null;
  breakout_reason?: string;
  creator_follower_count?: number | null;
  latest_views: number | null;
  latest_likes: number | null;
  latest_comments: number | null;
  latest_favorites?: number | null;
  latest_shares?: number | null;
  saved_board_id: number | null;
  asr_job_status: string | null;
  asr_error: string | null;
  pipeline_stage?: 'queued' | 'downloading' | 'transcribing' | 'digesting' | null;
  queue_position?: number | null;
  comment_count: number;
  comment_topics_count: number;
  comment_topics?: CommentTopicIdeaItem[];
  r2_analysis?: R2AnalysisPayload | null;
  copy_digest?: CreatorCopyDigest | null;
}

export interface CreatorTodayUpdates {
  dateLocal: string;
  hasTodayNew: boolean;
  todayCount: number;
  items: TrackerVideoItem[];
}

export type CreatorLeaderboardRankItem = TrackerVideoItem & {
  rank: number;
  heatScore: number;
  heatBasis: string;
};

export interface CreatorTodayLeaderboard {
  dateLocal: string;
  isFallback: boolean;
  fallbackLabel: string;
  items: CreatorLeaderboardRankItem[];
}

export interface CreatorsFeedResp {
  creators: TrackerCreator[];
  todayUpdates: CreatorTodayUpdates;
  todayLeaderboard: CreatorTodayLeaderboard;
  items: TrackerVideoItem[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  fallbackShown: boolean;
  totalUnread: number;
  checkIntervalMinutes: number;
  anyRunning: boolean;
  asrRunning?: boolean;
}

export interface FetchCreatorHistoryResp {
  ok: boolean;
  sourceId: number;
  fetchedCount: number;
  insertedCount: number;
  updatedCount: number;
  totalStored: number;
  error?: string;
}

export interface CommentTopicsResp {
  ok: boolean;
  contentId: number;
  commentsCount: number;
  topics: CommentTopicIdeaItem[];
  message?: string;
}

export interface ContentDetailResp {
  content: {
    id: number;
    platform: string;
    canonical_url: string;
    title: string;
    author: string;
    source_name: string;
    summary: string;
    body: string;
    transcript: string;
    transcript_status: string;
    breakout_ratio: number | null;
    breakout_score: number | null;
    breakout_reason: string;
    follower_count: number | null;
    published_at: string | null;
    discovered_at: string;
  };
  metrics: MetricSnapshot[];
  comments: Array<{
    id: number;
    author: string;
    text: string;
    likes: number | null;
    published_at: string | null;
  }>;
  analysis: {
    category: string;
    summary_zh: string;
    core_points_json: string;
    diff_angles_json: string;
    trend_judgement: string;
    content_form_advice: string;
    analyzed_at: string;
  } | null;
  r2Analysis: R2AnalysisPayload | null;
  commentTopics: CommentTopicIdeaItem[];
  tingwuJobs: Array<{
    id: number;
    status: string;
    error_message: string | null;
    updated_at: string;
  }>;
}
