import type {
  CommentTopicsResp,
  CreatorsFeedResp,
  FetchCreatorHistoryResp,
  R2AnalysisPayload,
  RemixCompareResponse,
  TopicBoardItem,
} from './types';

export async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...((init?.headers as Record<string, string> | undefined) || {}),
  };
  const res = await fetch(url, {
    ...init,
    headers,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string; message?: string }).error || (data as { message?: string }).message || `请求失败 (${res.status})`);
  }
  return data as T;
}

export const PLATFORM_LABELS: Record<string, string> = {
  website: '行业网站',
  rss: 'RSS 订阅',
  douyin: '抖音',
  bilibili: 'B站',
  kuaishou: '快手',
  'wechat-channels': '微信视频号',
  x: 'X (Twitter)',
  youtube: 'YouTube',
  other: '通用动态网页',
};

export const CONTENT_TYPE_LABELS: Record<string, string> = {
  video: '视频',
  article: '文章',
  short_post: '动态',
  hot_topic: '热榜话题',
};

export const BOARD_STATUS_META: Record<string, { label: string; color: string; bg: string }> = {
  to_research: { label: '待研究', color: '#475569', bg: '#f1f5f9' },
  to_create: { label: '待创作', color: '#4f46e5', bg: '#eef2ff' },
  creating: { label: '创作中', color: '#d97706', bg: '#fffbeb' },
  to_publish: { label: '待发布', color: '#0284c7', bg: '#e0f2fe' },
  published: { label: '已发布', color: '#16a34a', bg: '#f0fdf4' },
  reviewed: { label: '已复盘', color: '#7c3aed', bg: '#f5f3ff' },
};

export const FEEDBACK_LABELS: Record<string, string> = {
  interested: '感兴趣',
  watch_long: '长期关注',
  covered: '已讲过',
  not_suitable: '暂不适合',
  not_interested: '不感兴趣',
};

export function fmtTime(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function fmtNum(n?: number | null, missingLabel = '未提供'): string {
  if (n === null || n === undefined || Number.isNaN(n)) return missingLabel;
  if (n >= 100000000) return (n / 100000000).toFixed(1) + '亿';
  if (n >= 10000) return (n / 10000).toFixed(1) + '万';
  return String(Math.round(n));
}

export function safeJsonArray<T = string>(raw?: string | null): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export async function fetchCreatorsFeed(params: {
  creatorId?: number | null;
  days: number;
  offset?: number;
  limit?: number;
  includeRss?: boolean;
  search?: string;
}): Promise<CreatorsFeedResp> {
  const qs = new URLSearchParams();
  if (params.creatorId) qs.set('creatorId', String(params.creatorId));
  qs.set('days', String(params.days));
  qs.set('offset', String(params.offset ?? 0));
  qs.set('limit', String(params.limit ?? 30));
  qs.set('includeRss', params.includeRss ? '1' : '0');
  if (params.search && params.search.trim()) {
    qs.set('search', params.search.trim());
  }
  return apiRequest<CreatorsFeedResp>(`/api/radar/creators/feed?${qs.toString()}`);
}

export async function analyzeContentR2(
  contentId: number,
  force = false
): Promise<{ ok: boolean; analysis: R2AnalysisPayload }> {
  return apiRequest<{ ok: boolean; analysis: R2AnalysisPayload }>(`/api/radar/intel/${contentId}/r2-analyze`, {
    method: 'POST',
    body: JSON.stringify({ force }),
  });
}

export async function compareCreatorsRemix(payload: {
  contentIds?: number[];
  creatorId?: number | null;
}): Promise<RemixCompareResponse> {
  const body: { contentIds?: number[]; creatorId?: number } = {};
  if (payload.contentIds && payload.contentIds.length > 0) {
    body.contentIds = payload.contentIds;
  }
  if (payload.creatorId) {
    body.creatorId = payload.creatorId;
  }
  return apiRequest<RemixCompareResponse>('/api/radar/creators/compare-remix', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function fetchCreatorHistory(creatorId: number, maxPages = 3): Promise<FetchCreatorHistoryResp> {
  return apiRequest<FetchCreatorHistoryResp>(`/api/radar/creators/${creatorId}/fetch-history`, {
    method: 'POST',
    body: JSON.stringify({ maxPages }),
  });
}

export async function extractCommentTopics(
  contentId: number,
  opts?: { autoCrawl?: boolean; force?: boolean }
): Promise<CommentTopicsResp> {
  return apiRequest<CommentTopicsResp>(`/api/radar/intel/${contentId}/comments/topics`, {
    method: 'POST',
    body: JSON.stringify({
      autoCrawl: Boolean(opts?.autoCrawl),
      force: Boolean(opts?.force),
    }),
  });
}

export async function saveCommentTopicToBoard(
  topicId: number
): Promise<{ ok: boolean; topicId: number; boardItem: TopicBoardItem }> {
  return apiRequest<{ ok: boolean; topicId: number; boardItem: TopicBoardItem }>(
    `/api/radar/comments/topics/${topicId}/save-board`,
    { method: 'POST' }
  );
}

export async function saveTopicToBoard(payload: {
  title: string;
  source_content_id?: number | null;
  core_angle?: string;
  notes?: string;
  tags?: string[];
  source_url?: string;
}): Promise<{ ok: boolean; item: TopicBoardItem }> {
  return apiRequest<{ ok: boolean; item: TopicBoardItem }>('/api/radar/board', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}
