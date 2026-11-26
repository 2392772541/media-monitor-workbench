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
