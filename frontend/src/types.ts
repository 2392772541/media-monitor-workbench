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
