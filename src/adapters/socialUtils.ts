export function parseCountText(raw?: string | null): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/,/g, '').trim();
  const match = cleaned.match(/(\d+(?:\.\d+)?)\s*(万|亿|w|W|k|K|m|M)?/);
  if (!match) return null;
  const num = Number(match[1]);
  if (!Number.isFinite(num)) return null;
  const unit = match[2];
  if (unit === '万' || unit === 'w' || unit === 'W') return Math.round(num * 10000);
  if (unit === '亿') return Math.round(num * 100000000);
  if (unit === 'k' || unit === 'K') return Math.round(num * 1000);
  if (unit === 'm' || unit === 'M') return Math.round(num * 1000000);
  return Math.round(num);
}
