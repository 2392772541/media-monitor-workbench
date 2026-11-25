import { getDb } from '../db/database.js';

interface MetricRow {
  content_id: number;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  favorites: number | null;
  captured_at: string;
}

// 计算单次互动快照的综合互动分（只基于真实存在的非 null 字段，绝不虚构数据）
export function computeEngagementScore(m: {
  views?: number | null;
  likes?: number | null;
  comments?: number | null;
  shares?: number | null;
  favorites?: number | null;
}): number | null {
  const vals = [m.views, m.likes, m.comments, m.shares, m.favorites].filter(
    (v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
  );
  if (vals.length === 0) return null;

  let score = 0;
  if (typeof m.likes === 'number') score += m.likes * 3;
  if (typeof m.comments === 'number') score += m.comments * 6;
  if (typeof m.favorites === 'number') score += m.favorites * 5;
  if (typeof m.shares === 'number') score += m.shares * 8;
  // 若仅采集到播放量，或同时有播放量，按合理比例纳入
  if (typeof m.views === 'number') score += m.views * 0.05;
  return Math.round(score * 100) / 100;
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * 重新计算某个监控对象（博主）的历史作品中位数基线，以及每条作品的异常爆款指数与真实互动增速。
 * 严格遵循“不编造数据”原则：样本不足 3 条或无互动数据时保留 null 并写明原因。
 */
export function recomputeSourceBreakout(sourceId: number): { updated: number; sampleSize: number } {
  const db = getDb();
  const source = db
    .prepare('SELECT id, name, platform, follower_count FROM sources WHERE id = ?')
    .get(sourceId) as { id: number; name: string; platform: string; follower_count: number | null } | undefined;
  if (!source) return { updated: 0, sampleSize: 0 };

  const contents = db
    .prepare('SELECT id, published_at, discovered_at FROM contents WHERE source_id = ? ORDER BY COALESCE(published_at, discovered_at) DESC LIMIT 60')
    .all(sourceId) as Array<{ id: number; published_at: string | null; discovered_at: string }>;

  if (contents.length === 0) {
    db.prepare(`
      UPDATE sources SET baseline_views = NULL, baseline_likes = NULL, baseline_comments = NULL,
        baseline_engagement = NULL, baseline_sample_size = 0 WHERE id = ?
    `).run(sourceId);
    return { updated: 0, sampleSize: 0 };
  }

  // 拉取每条内容的所有快照（按时间升序，用于算最新值与增速）
  const latestMap = new Map<number, MetricRow>();
  const growthMap = new Map<number, number | null>();

  const stmtSnap = db.prepare(`
    SELECT content_id, views, likes, comments, shares, favorites, captured_at
    FROM content_metrics WHERE content_id = ? ORDER BY captured_at ASC
  `);

  const viewSamples: number[] = [];
  const likeSamples: number[] = [];
  const commentSamples: number[] = [];
  const engSamples: number[] = [];

  for (const c of contents) {
    const snaps = stmtSnap.all(c.id) as unknown as MetricRow[];
    if (snaps.length === 0) continue;
    const latest = snaps[snaps.length - 1];
    latestMap.set(c.id, latest);

    if (typeof latest.views === 'number') viewSamples.push(latest.views);
    if (typeof latest.likes === 'number') likeSamples.push(latest.likes);
    if (typeof latest.comments === 'number') commentSamples.push(latest.comments);
    const eng = computeEngagementScore(latest);
    if (eng !== null) engSamples.push(eng);

    // 计算真实每小时互动增速（至少 2 次快照且间隔 >= 5 分钟）
    if (snaps.length >= 2) {
      const prev = snaps[snaps.length - 2];
      const dtHours = (new Date(latest.captured_at).getTime() - new Date(prev.captured_at).getTime()) / 3600000;
      const eNow = computeEngagementScore(latest);
      const ePrev = computeEngagementScore(prev);
      if (dtHours >= 5 / 60 && eNow !== null && ePrev !== null) {
        growthMap.set(c.id, Math.max(0, Math.round(((eNow - ePrev) / dtHours) * 100) / 100));
      } else {
        growthMap.set(c.id, null);
      }
    } else {
      growthMap.set(c.id, null);
    }
  }

  const baseViews = median(viewSamples);
  const baseLikes = median(likeSamples);
  const baseComments = median(commentSamples);
  const baseEng = median(engSamples);
  const sampleSize = engSamples.length;

  db.prepare(`
    UPDATE sources SET
      baseline_views = ?,
      baseline_likes = ?,
      baseline_comments = ?,
      baseline_engagement = ?,
      baseline_sample_size = ?
    WHERE id = ?
  `).run(baseViews, baseLikes, baseComments, baseEng, sampleSize, sourceId);

  const updateContent = db.prepare(`
    UPDATE contents SET
      breakout_score = ?,
      breakout_ratio = ?,
      growth_rate_per_hour = ?,
      breakout_reason = ?
    WHERE id = ?
  `);

  const nowMs = Date.now();
  let updated = 0;

  for (const c of contents) {
    const latest = latestMap.get(c.id);
    if (!latest) {
      updateContent.run(null, null, null, '当前平台或该条内容未提供互动指标', c.id);
      updated++;
      continue;
    }

    const eng = computeEngagementScore(latest);
    const growth = growthMap.get(c.id) ?? null;

    if (eng === null) {
      updateContent.run(null, null, null, '当前内容无可用互动指标', c.id);
      updated++;
      continue;
    }

    if (sampleSize < 3 || !baseEng || baseEng <= 0) {
      // 样本不足 3 条时，不虚构异常倍数
      updateContent.run(null, null, growth, `博主历史作品样本仅 ${sampleSize} 条（需满 3 条建立基线）`, c.id);
      updated++;
      continue;
    }

    const ratio = Math.round((eng / baseEng) * 100) / 100;
    const refTime = new Date(c.published_at || c.discovered_at).getTime();
    const ageHours = Math.max(1, (nowMs - (Number.isNaN(refTime) ? nowMs : refTime)) / 3600000);
    // 越新的作品获得更高的时效系数
    const freshnessFactor = ageHours <= 24 ? 1.15 : ageHours <= 72 ? 1.05 : ageHours <= 168 ? 0.92 : 0.78;

    // 低粉爆款加成（仅在真实采集到粉丝数且 > 0 时生效）
    let lowFollowerBonus = 0;
    let lowFollowerNote = '';
    if (typeof source.follower_count === 'number' && source.follower_count > 0) {
      const fanRatio = eng / Math.max(source.follower_count, 500);
      if (fanRatio >= 1.5) {
        lowFollowerBonus = Math.min(20, Math.round(fanRatio * 6));
        lowFollowerNote = `；低粉高互动（粉丝 ${source.follower_count.toLocaleString()}）`;
      }
    }

    // 短期增速加成（仅在存在真实多点快照增速时生效）
    let growthBonus = 0;
    let growthNote = '';
    if (growth !== null && growth > 0) {
      const growthRelative = growth / Math.max(baseEng * 0.05, 10);
      growthBonus = Math.min(18, Math.round(Math.log1p(growthRelative) * 7));
      growthNote = `；近段增速 +${Math.round(growth)}/小时`;
    }

    // 基础分：1.0x 常态约 40 分，2.0x 约 65 分，3.0x+ 约 80~95 分
    const baseScore = Math.min(82, Math.round(40 * Math.pow(ratio, 0.72)));
    const finalScore = Math.max(0, Math.min(100, Math.round((baseScore + lowFollowerBonus + growthBonus) * freshnessFactor)));

    const levelLabel = ratio >= 2.5 ? '强异常爆款' : ratio >= 1.6 ? '潜力上升' : ratio >= 0.8 ? '常态表现' : '低于常态';
    const reason = `${levelLabel}：综合互动为该博主近 ${sampleSize} 条作品中位数的 ${ratio}x${lowFollowerNote}${growthNote}`;

    updateContent.run(finalScore, ratio, growth, reason, c.id);
    updated++;
  }

  return { updated, sampleSize };
}

export function recomputeAllBreakouts(): { sourcesProcessed: number; contentsUpdated: number } {
  const db = getDb();
  const sources = db.prepare('SELECT id FROM sources').all() as Array<{ id: number }>;
  let contentsUpdated = 0;
  for (const s of sources) {
    const r = recomputeSourceBreakout(s.id);
    contentsUpdated += r.updated;
  }
  return { sourcesProcessed: sources.length, contentsUpdated };
}
