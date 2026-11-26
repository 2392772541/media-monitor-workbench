import { useEffect, useState } from 'react';
import {
  Flame,
  RefreshCw,
  ArrowRight,
  Star,
  TrendingUp,
  PieChart as PieIcon,
} from 'lucide-react';
import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  PieChart,
  Pie,
  Cell,
} from 'recharts';
import { apiRequest, fmtNum, PLATFORM_LABELS } from '../api';
import type { DrawerTab } from '../components/ContentDrawer';
import { VideoCard } from '../components/VideoCard';
import type { CockpitData, HotBoardItem } from '../types';

interface CockpitPageProps {
  refreshTick: number;
  onNavigate: (tab: string) => void;
  onOpenContent: (contentId: number, tab?: DrawerTab, savedBoardId?: number | null) => void;
  onOpenHotItem: (item: HotBoardItem, tab?: DrawerTab) => void;
  onRefreshBadge: () => void;
  onToast: (msg: string) => void;
}

const CHART_PALETTE = ['#4f46e5', '#e11d48', '#0284c7', '#0d9488', '#ea580c', '#7c3aed', '#16a34a', '#ca8a04'];

export function CockpitPage({
  refreshTick,
  onNavigate,
  onOpenContent,
  onOpenHotItem,
  onRefreshBadge,
  onToast,
}: CockpitPageProps) {
  const [data, setData] = useState<CockpitData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [trendRange, setTrendRange] = useState<'7d' | '14d'>('7d');
  const [boomPlatform, setBoomPlatform] = useState<string>('all');
  const [expandBreakouts, setExpandBreakouts] = useState<boolean>(false);

  const load = async () => {
    try {
      const res = await apiRequest<CockpitData>('/api/radar/cockpit');
      setData(res);
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [refreshTick]);

  // 刷新最新一期抖音热搜与 B 站热门并重算爆款基线
  const handleRefreshAll = async () => {
    setRefreshing(true);
    try {
      const [hotRes] = await Promise.all([
        apiRequest<{ totalSaved: number; results: Array<{ board: string; count: number; error?: string }> }>(
          '/api/radar/hot-board/refresh',
          {
            method: 'POST',
            body: JSON.stringify({ platforms: ['bilibili', 'douyin'], scoreWithAi: false }),
          }
        ),
        apiRequest('/api/radar/creators/recompute-breakout', { method: 'POST' }).catch(() => null),
      ]);
      const summary = hotRes.results.map((r) => `${r.board} ${r.count}条`).join(' · ');
      onToast(`已更新最新榜单：${summary}`);
      await load();
      onRefreshBadge();
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setRefreshing(false);
    }
  };

  const handleToggleBreakoutStar = async (
    item: CockpitData['breakouts'][number],
    ev: React.MouseEvent
  ) => {
    ev.stopPropagation();
    try {
      if (item.saved_board_id) {
        await apiRequest(`/api/radar/board/${item.saved_board_id}`, { method: 'DELETE' });
        onToast('已取消收藏');
      } else {
        await apiRequest('/api/radar/board', {
          method: 'POST',
          body: JSON.stringify({
            title: item.title,
            source_content_id: item.id,
            core_angle: item.brief || item.breakout_reason || '',
            tags: [PLATFORM_LABELS[item.platform] || item.platform, item.source_name].filter(Boolean),
            source_url: item.canonical_url,
          }),
        });
        onToast('已收藏到「简易收藏本」');
      }
      await load();
      onRefreshBadge();
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  const handleToggleHotStar = async (item: HotBoardItem, ev: React.MouseEvent) => {
    ev.stopPropagation();
    try {
      if (item.saved_board_id) {
        await apiRequest(`/api/radar/board/${item.saved_board_id}`, { method: 'DELETE' });
        onToast('已取消收藏');
      } else {
        let cid = item.content_id;
        if (!cid) {
          const imp = await apiRequest<{ contentId: number }>(`/api/radar/hot-board/${item.id}/import`, { method: 'POST' });
          cid = imp.contentId;
        }
        await apiRequest('/api/radar/board', {
          method: 'POST',
          body: JSON.stringify({
            title: item.title,
            source_content_id: cid,
            core_angle: item.ai_summary || `${item.board_name} · ${item.hot_label}`,
            tags: [PLATFORM_LABELS[item.platform] || item.platform, item.category].filter(Boolean),
            source_url: item.url,
          }),
        });
        onToast('已收藏到「简易收藏本」');
      }
      await load();
      onRefreshBadge();
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  if (loading && !data) {
    return <div className="panel-card" style={{ padding: 48, textAlign: 'center', color: 'var(--text-muted)' }}>加载今日速览中...</div>;
  }
  if (!data) return null;

  const allBreakouts = data.breakouts || [];
  const breakoutPlatforms = Array.from(new Set(allBreakouts.map((b) => b.platform)));
  const filteredBreakouts =
    boomPlatform === 'all' ? allBreakouts : allBreakouts.filter((b) => b.platform === boomPlatform);
  const visibleBreakouts = expandBreakouts ? filteredBreakouts.slice(0, 12) : filteredBreakouts.slice(0, 4);
  const douyinHot = (data.douyinHot || data.hotTop?.filter((h) => h.platform === 'douyin') || []).slice(0, 10);
  const bilibiliHot = (data.bilibiliHot || data.hotTop?.filter((h) => h.platform === 'bilibili') || []).slice(0, 6);
  const trendSeries = trendRange === '14d' && data.trend14d?.length ? data.trend14d : data.trend7d || [];
  const hotCats = (data.hotCategoryDistribution || []).filter((c) => c.count > 0);
  const hotCatsTotal = hotCats.reduce((acc, c) => acc + c.count, 0) || 1;

  return (
    <div>
      {/* 顶部极简一行状态胶囊（把宝贵首屏空间让给爆款封面墙！） */}
      <div className="compact-status-bar">
        <div className="status-chips">
          <span className="status-chip hot" onClick={() => onNavigate('creators')}>
            🔥 正在爆发 <strong>{data.stats.breakoutCount}</strong>
          </span>
          <span className="status-chip" onClick={() => onNavigate('hotboard')}>
            🔥 最新热榜 <strong>{data.stats.hotBoardCount}</strong>
          </span>
          <span className="status-chip" onClick={() => onNavigate('creators')}>
            👀 对标博主 <strong>{data.stats.totalSources}</strong>
          </span>
          <span className="status-chip" onClick={() => onNavigate('saved')}>
            ⭐ 收藏本 <strong>{data.stats.savedCount ?? data.stats.boardActiveCount}</strong>
          </span>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary btn-sm" onClick={() => onNavigate('creators')}>
            + 添加博主
          </button>
          <button className="btn btn-primary btn-sm" disabled={refreshing} onClick={handleRefreshAll}>
            <RefreshCw size={13} /> {refreshing ? '刷新中...' : '刷新最新热榜'}
          </button>
        </div>
      </div>

      {/* ===== 第一层：🔥 对标博主正在爆发（按博主轮询防霸屏，支持平台快筛与展开全部） ===== */}
      <section className="panel-card">
        <div className="panel-head">
          <div className="panel-title">
            <Flame size={17} color="#ea580c" />
            <span>对标博主 · 正在爆发</span>
            <span className="badge badge-amber">各博主轮流展示 · ≥1.6x</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {breakoutPlatforms.length > 1 && (
              <div className="pill-group">
                <button
                  className={`pill-btn ${boomPlatform === 'all' ? 'active' : ''}`}
                  onClick={() => setBoomPlatform('all')}
                >
                  全部 ({allBreakouts.length})
                </button>
                {breakoutPlatforms.map((p) => (
                  <button
                    key={p}
                    className={`pill-btn ${boomPlatform === p ? 'active' : ''}`}
                    onClick={() => setBoomPlatform(p)}
                  >
                    {PLATFORM_LABELS[p] || p} ({allBreakouts.filter((x) => x.platform === p).length})
                  </button>
                ))}
              </div>
            )}
            {filteredBreakouts.length > 4 && (
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => setExpandBreakouts((v) => !v)}
              >
                {expandBreakouts ? '收起' : `展开全部 (${filteredBreakouts.length})`}
              </button>
            )}
            <button className="btn btn-secondary btn-sm" onClick={() => onNavigate('creators')}>
              博主走势 <ArrowRight size={13} />
            </button>
          </div>
        </div>

        {visibleBreakouts.length === 0 ? (
          <div style={{ padding: '28px 12px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
            暂未检测到 ≥1.6x 异常爆款。去「对标博主」添加同行并抓取作品后会自动显示在这里。
          </div>
        ) : (
          <div className="vcard-grid-4">
            {visibleBreakouts.map((b) => (
              <VideoCard
                key={b.id}
                title={b.title}
                coverUrl={b.cover_url}
                author={b.source_name}
                subLabel={PLATFORM_LABELS[b.platform] || b.platform}
                badgeText={b.breakout_ratio ? `🔥 ${b.breakout_ratio}x 爆` : '🔥 爆款'}
                badgeTone="boom"
                playLabel={b.latest_views != null ? fmtNum(b.latest_views) : undefined}
                rightMetricLabel={
                  b.latest_likes != null
                    ? `👍 ${fmtNum(b.latest_likes)}${b.latest_views == null && b.latest_favorites != null ? ` · 藏 ${fmtNum(b.latest_favorites)}` : ''}`
                    : undefined
                }
                starred={Boolean(b.saved_board_id)}
                onClick={() => onOpenContent(b.id, 'point', b.saved_board_id)}
                onToggleStar={(e) => void handleToggleBreakoutStar(b, e)}
              />
            ))}
          </div>
        )}
      </section>

      {/* ===== 第二层：左右自然分开（左 = 抖音极简热搜 10行 | 右 = B站热门封面 6格） ===== */}
      <section className="dual-hot-grid">
        {/* 左：抖音实时热搜（每条严格 1 行，清清爽爽） */}
        <div className="panel-card" style={{ marginBottom: 0 }}>
          <div className="panel-head">
            <div className="panel-title">
              <span className="plat-dot" style={{ background: '#e11d48', width: 10, height: 10 }} />
              <span>抖音实时热搜 TOP {douyinHot.length}</span>
            </div>
            <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>最新一期 · 点词条看详情</span>
          </div>

          {douyinHot.length === 0 ? (
            <div style={{ padding: '24px 8px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
              暂无抖音热搜，点右上角「刷新最新热榜」拉取。
            </div>
          ) : (
            <div className="hotsearch-list">
              {douyinHot.map((h, i) => {
                const rank = h.rank_no || i + 1;
                const rankCls = rank === 1 ? 'r1' : rank === 2 ? 'r2' : rank === 3 ? 'r3' : '';
                return (
                  <div key={h.id} className="hotsearch-row" onClick={() => void onOpenHotItem(h, 'point')}>
                    <div className="hotsearch-left">
                      <span className={`rank-num ${rankCls}`}>{rank}</span>
                      <span className="hotsearch-title" title={h.title}>
                        {h.title}
                      </span>
                    </div>
                    <div className="hotsearch-right">
                      <span className="hotsearch-heat">{h.hot_label.replace('热度', '')}</span>
                      <button
                        type="button"
                        className={`mini-action ${h.saved_board_id ? 'starred' : ''}`}
                        onClick={(e) => void handleToggleHotStar(h, e)}
                        title={h.saved_board_id ? '取消收藏' : '收藏'}
                      >
                        <Star size={11} fill={h.saved_board_id ? 'currentColor' : 'none'} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 右：B站全站热门（3×2 真封面卡片墙） */}
        <div className="panel-card" style={{ marginBottom: 0 }}>
          <div className="panel-head">
            <div className="panel-title">
              <span className="plat-dot" style={{ background: '#4f46e5', width: 10, height: 10 }} />
              <span>B站全站热门 TOP {bilibiliHot.length}</span>
            </div>
            <button className="btn btn-secondary btn-sm" onClick={() => onNavigate('hotboard')}>
              展开全部热榜与赛道色块 <ArrowRight size={13} />
            </button>
          </div>

          {bilibiliHot.length === 0 ? (
            <div style={{ padding: '24px 8px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
              暂无 B 站热门视频，点右上角「刷新最新热榜」拉取。
            </div>
          ) : (
            <div className="vcard-grid-3">
              {bilibiliHot.map((h, i) => {
                const rank = h.rank_no || i + 1;
                const playPart = h.hot_label.split('·')[0]?.replace('播放', '').trim();
                return (
                  <VideoCard
                    key={h.id}
                    title={h.title}
                    coverUrl={h.cover_url}
                    author={h.author || 'B站UP主'}
                    subLabel={h.category || '热门'}
                    badgeText={`#${rank}`}
                    badgeTone={rank <= 3 ? 'top' : 'rank'}
                    playLabel={playPart || undefined}
                    starred={Boolean(h.saved_board_id)}
                    onClick={() => void onOpenHotItem(h, 'point')}
                    onToggleStar={(e) => void handleToggleHotStar(h, e)}
                  />
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* ===== 第三层：简洁双可视化大盘图（爆款脉冲趋势 + B站今日上榜分区环图） ===== */}
      <section className="overview-bottom">
        <div className="panel-card" style={{ marginBottom: 0 }}>
          <div className="panel-head">
            <div className="panel-title">
              <TrendingUp size={16} color="#4f46e5" />
              <span>近期抓到多少爆款</span>
            </div>
            <div className="pill-group">
              <button
                className={`pill-btn ${trendRange === '7d' ? 'active' : ''}`}
                onClick={() => setTrendRange('7d')}
              >
                近 7 天
              </button>
              <button
                className={`pill-btn ${trendRange === '14d' ? 'active' : ''}`}
                onClick={() => setTrendRange('14d')}
              >
                近 14 天
              </button>
            </div>
          </div>
          <div style={{ width: '100%', height: 195 }}>
            <ResponsiveContainer>
              <ComposedChart data={trendSeries} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="day" tick={{ fontSize: 11, fill: '#64748b' }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#64748b' }} />
                <Tooltip />
                <Bar dataKey="total" name="新抓取内容" fill="#818cf8" fillOpacity={0.45} radius={[4, 4, 0, 0]} maxBarSize={26} />
                <Line type="monotone" dataKey="breakouts" name="触发爆款数" stroke="#ea580c" strokeWidth={2.5} dot={{ r: 3.5 }} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="panel-card" style={{ marginBottom: 0, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
          <div className="panel-head" style={{ marginBottom: 4 }}>
            <div className="panel-title">
              <PieIcon size={16} color="#0284c7" />
              <span>今日热门都在聊哪类赛道</span>
            </div>
          </div>

          {hotCats.length === 0 ? (
            <div style={{ padding: 28, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12.5 }}>暂无分区数据</div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-around', gap: 10, flex: 1 }}>
              <div style={{ width: 145, height: 145 }}>
                <ResponsiveContainer>
                  <PieChart>
                    <Pie data={hotCats} dataKey="count" nameKey="name" innerRadius={40} outerRadius={62} paddingAngle={2}>
                      {hotCats.map((entry, idx) => (
                        <Cell key={entry.name} fill={CHART_PALETTE[idx % CHART_PALETTE.length]} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(val: unknown, name: unknown) => [`${Number(val)} 条`, String(name)]} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
                {hotCats.slice(0, 6).map((c, idx) => (
                  <div key={c.name} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    <span className="plat-dot" style={{ background: CHART_PALETTE[idx % CHART_PALETTE.length] }} />
                    <span>{c.name}</span>
                    <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>
                      {Math.round((c.count / hotCatsTotal) * 100)}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
