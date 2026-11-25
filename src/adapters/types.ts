import type { ProfilePlatform } from '../config.js';

export type CapabilityStatus =
  | '已接入并验证'
  | '需要登录'
  | '需要授权'
  | '暂时不可用'
  | '暂不支持'
  | '采集异常';

export type PlatformKey = 'website' | 'rss' | 'douyin' | 'bilibili' | 'kuaishou' | 'wechat-channels' | 'x' | 'youtube';

export interface SourceRecord {
  id: number;
  name: string;
  platform: PlatformKey;
  url: string;
  source_type: string;
  interval_minutes: number;
  status: string;
  config_json: string;
}

export interface ExtractedContentItem {
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
  contentType?: 'video' | 'article' | 'short_post' | 'hot_topic';
  rawMeta?: Record<string, unknown>;
  metrics?: {
    views?: number | null;
    likes?: number | null;
    comments?: number | null;
    shares?: number | null;
    favorites?: number | null;
  };
}

export interface AuthorProfileSnapshot {
  name?: string;
  followerCount?: number | null;
  avatarUrl?: string;
  bio?: string;
}

export interface LoginCheckResult {
  loggedIn: boolean;
  status: 'logged_in' | 'expired' | 'auth_required' | 'optional' | 'unknown' | 'error';
  capabilityStatus: CapabilityStatus;
  message: string;
  needsAttention: boolean;
}

export interface AvailabilityResult {
  available: boolean;
  detectedTitle?: string;
  detectedFeedUrl?: string;
  message: string;
  capabilityStatus: CapabilityStatus;
}

export interface FetchResult {
  ok: boolean;
  capabilityStatus: CapabilityStatus;
  authRequired?: boolean;
  items: ExtractedContentItem[];
  authorProfile?: AuthorProfileSnapshot;
  logs: string[];
  errorMessage?: string;
}

export interface PlatformAdapter {
  readonly platform: PlatformKey;
  readonly displayName: string;
  readonly profilePlatform: ProfilePlatform | null;
  readonly defaultCapability: CapabilityStatus;
  checkLoginStatus(): Promise<LoginCheckResult>;
  checkAvailability(url: string, config?: Record<string, unknown>): Promise<AvailabilityResult>;
  fetchLatest(
    source: SourceRecord,
    options: { headless: boolean; signal?: AbortSignal; onLog?: (msg: string) => void }
  ): Promise<FetchResult>;
}
