export async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
    ...init,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string; message?: string }).error || (data as { message?: string }).message || `请求失败 (${res.status})`);
  }
  return data as T;
}

export const PLATFORM_LABELS: Record<string, string> = {
  website: '普通网站',
  rss: 'RSS 订阅',
  douyin: '抖音',
  kuaishou: '快手',
  'wechat-channels': '微信视频号',
  x: 'X (Twitter)',
  youtube: 'YouTube',
  other: '通用动态网页',
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

export function fmtNum(n?: number | null): string {
  if (n === null || n === undefined) return '—';
  if (n >= 10000) return (n / 10000).toFixed(1) + '万';
  return String(n);
}
