import { useEffect, useState } from 'react';
import {
  Flame,
  RefreshCw,
  ArrowRight,
  Star,
  Mic,
  MessageSquareText,
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
import type { CockpitData, HotBoardItem } from '../types';

interface CockpitPageProps {
  refreshTick: number;
  onNavigate: (tab: string) => void;
  onOpenContent: (contentId: number, tab?: DrawerTab, savedBoardId?: number | null) => void;
  onOpenHotItem: (item: HotBoardItem, tab?: DrawerTab) => void;
  onRefreshBadge: () => void;
  onToast: (msg: string) => void;
}

const PLATFORM_COLORS: Record<string, string> = {
  bilibili: '#4f46e5',
  douyin: '#e11d48',
  youtube: '#dc2626',
  rss: '#0284c7',
  website: '#0d9488',
  x: '#0f172a',
};

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
  const [hotTab, setHotTab] = useState<'all' | 'douyin' | 'bilibili'>('all');
  const [trendRange, setTrendRange] = useState<'7d' | '14d'>('7d');

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

  // 一键刷新抖音 + B站真实热榜并重算博主爆款基线
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
      onToast(`刷新完成：${summary}`);
      await load();
      onRefreshBadge();
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setRefreshing(false);
    }
  };

  // 快捷星标收藏 / 取消收藏（博主作品）
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

  // 快捷星标收藏 / 取消收藏（热榜条目）
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
            core_angle: item.ai_summary || item.summary || `${item.board_name} · ${item.hot_label}`,
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
    return <div className="panel-card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>加载今日速览中...</div>;
  }
  if (!data) return null;

  const breakouts = data.breakouts || [];
  const maxRatio = Math.max(...breakouts.map((b) => b.breakout_ratio || 0), 1);

  const allHots = data.hotTop || [];
  const douyinCount = allHots.filter((h) => h.platform === 'douyin').length;
  const bilibiliCount = allHots.filter((h) => h.platform === 'bilibili').length;
  const visibleHots = (hotTab === 'all' ? allHots : allHots.filter((h) => h.platform === hotTab)).slice(0, 8);

  const trendSeries = trendRange === '14d' && data.trend14d?.length ? data.trend14d : data.trend7d || [];
  const platDist = (data.platformDistribution || []).filter((p) => p.count > 0);
  const platTotal = platDist.reduce((acc, p) => acc + p.count, 0) || 1;

  return (
    <div>
      {/* 顶部 4 枚极简数字卡片 + 刷新操作 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, flexWrap: 'wrap', gap: 10 }}>
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          左看对标博主刚爆的作品，右看平台今天热榜，点任意一条即可滑出「看点 / 口播稿 / 热评」
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary btn-sm" onClick={() => onNavigate('creators')}>
            去加对标博主
          </button>
          <button className="btn btn-primary btn-sm" disabled={refreshing} onClick={handleRefreshAll}>
            <RefreshCw size={13} /> {refreshing ? '刷新中...' : '刷新热榜与爆款'}
          </button>
        </div>
      </div>

      <section className="grid-4">
        <div className="stat-card" style={{ cursor: 'pointer' }} onClick={() => onNavigate('creators')}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="stat-label">对标博主正在爆</span>
            {breakouts[0]?.breakout_ratio ? (
              <span className="badge badge-amber">最高 {breakouts[0].breakout_ratio}x</span>
            ) : null}
          </div>
          <div className="stat-value" style={{ color: '#ea580c' }}>
            {data.stats.breakoutCount}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>超出博主平时中位数 ≥ 1.6x</div>
        </div>

        <div className="stat-card" style={{ cursor: 'pointer' }} onClick={() => onNavigate('hotboard')}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="stat-label">平台实时热榜</span>
            <span className="badge badge-green">实时</span>
          </div>
          <div className="stat-value">{data.stats.hotBoardCount}</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>
            抖音前排 {douyinCount} · B站热门 {bilibiliCount}
          </div>
        </div>

        <div className="stat-card" style={{ cursor: 'pointer' }} onClick={() => onNavigate('creators')}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="stat-label">盯盘对标博主</span>
            <span className="badge badge-blue">自动追踪</span>
          </div>
          <div className="stat-value">{data.stats.totalSources}</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>今日新入库 {data.stats.todayNew} 条作品</div>
        </div>

        <div className="stat-card" style={{ cursor: 'pointer' }} onClick={() => onNavigate('saved')}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="stat-label">我的收藏本</span>
            <span style={{ fontSize: 11.5, color: 'var(--primary)', fontWeight: 600 }}>去查看 →</span>
          </div>
          <div className="stat-value">{data.stats.savedCount ?? data.stats.boardActiveCount}</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>随手点星标存下来拍</div>
        </div>
      </section>

      {/* 中区左右严格分栏：左 = 博主爆款 | 右 = 平台热榜 */}
      <section className="overview-split">
        {/* 左栏：对标博主刚爆的作品 */}
        <div className="panel-card" style={{ marginBottom: 0 }}>
          <div className="panel-head">
            <div className="panel-title">
              <Flame size={17} color="#ea580c" />
              <span>对标博主 · 刚爆了这些</span>
            </div>
            <button className="btn btn-secondary btn-sm" onClick={() => onNavigate('creators')}>
              看博主走势 <ArrowRight size={13} />
            </button>
          </div>

          {breakouts.length === 0 ? (
            <div style={{ padding: '28px 12px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
              还没有检测到异常爆款。去「对标博主」添加博主并抓满 3 条作品后会自动标红。
            </div>
          ) : (
            <div className="feed-list">
              {breakouts.slice(0, 7).map((b) => {
                const ratio = b.breakout_ratio || 0;
                const pct = ratio > 0 ? Math.min(100, Math.max(12, Math.round((ratio / maxRatio) * 100))) : 20;
                const pColor = PLATFORM_COLORS[b.platform] || '#4f46e5';
                return (
                  <div
                    key={b.id}
                    className="feed-row"
                    onClick={() => onOpenContent(b.id, 'point', b.saved_board_id)}
                  >
                    <div className="feed-row-head">
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0, flex: 1 }}>
                        <span className="plat-dot" style={{ background: pColor }} />
                        <span className="feed-row-title">{b.title}</span>
                      </div>
                      {b.breakout_ratio != null ? (
                        <span className="breakout-badge">{b.breakout_ratio}x 爆</span>
                      ) : (
                        <span className="badge badge-gray">热门</span>
                      )}
                    </div>

                    <div className="heat-track">
                      <div className="heat-fill" style={{ width: `${pct}%`, background: '#ea580c' }} />
                    </div>

                    {b.brief && <div className="feed-row-brief">💡 {b.brief}</div>}

                    <div className="feed-row-meta">
                      <span>
                        {PLATFORM_LABELS[b.platform] || b.platform} · {b.source_name} · 播 {fmtNum(b.latest_views)} · 赞 {fmtNum(b.latest_likes)}
                      </span>
                      <div style={{ display: 'flex', gap: 5 }} onClick={(e) => e.stopPropagation()}>
                        <button
                          className="mini-action"
                          onClick={() => onOpenContent(b.id, 'transcript', b.saved_board_id)}
                        >
                          <Mic size={11} /> 口播稿
                        </button>
                        <button
                          className="mini-action"
                          onClick={() => onOpenContent(b.id, 'comments', b.saved_board_id)}
                        >
                          <MessageSquareText size={11} /> 热评{b.comment_rows ? `(${b.comment_rows})` : ''}
                        </button>
                        <button
                          className={`mini-action ${b.saved_board_id ? 'starred' : ''}`}
                          onClick={(e) => void handleToggleBreakoutStar(b, e)}
                          title={b.saved_board_id ? '取消收藏' : '收藏'}
                        >
                          <Star size={11} fill={b.saved_board_id ? 'currentColor' : 'none'} />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 右栏：平台热榜速递 */}
        <div className="panel-card" style={{ marginBottom: 0 }}>
          <div className="panel-head">
            <div className="panel-title">
              <TrendingUp size={17} color="#dc2626" />
              <span>平台热榜 · 今日最火</span>
            </div>
            <div className="pill-group">
              {[
                { k: 'all' as const, l: '全部' },
                { k: 'douyin' as const, l: '抖音' },
                { k: 'bilibili' as const, l: 'B站' },
              ].map((t) => (
                <button
                  key={t.k}
                  className={`pill-btn ${hotTab === t.k ? 'active' : ''}`}
                  onClick={() => setHotTab(t.k)}
                >
                  {t.l}
                </button>
              ))}
            </div>
          </div>

          {visibleHots.length === 0 ? (
            <div style={{ padding: '28px 12px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
              暂无热榜，点击右上角「刷新热榜与爆款」拉取最新抖音与 B 站榜单。
            </div>
          ) : (
            <div className="feed-list">
              {visibleHots.map((h, idx) => {
                const pColor = PLATFORM_COLORS[h.platform] || '#4f46e5';
                return (
                  <div key={h.id} className="feed-row" onClick={() => void onOpenHotItem(h, 'point')}>
                    <div className="feed-row-head">
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
                        <span className={`rank-box ${idx < 3 ? 'top' : ''}`}>{h.rank_no || idx + 1}</span>
                        <span className="feed-row-title">{h.title}</span>
                      </div>
                      <span style={{ fontSize: 12, fontWeight: 700, color: pColor, flexShrink: 0 }}>
                        {h.hot_label || '热榜'}
                      </span>
                    </div>

                    {(h.ai_summary || h.summary) && (
                      <div className="feed-row-brief">💡 {h.ai_summary || h.summary}</div>
                    )}

                    <div className="feed-row-meta">
                      <span>
                        {PLATFORM_LABELS[h.platform] || h.platform} · {h.category || '综合'}
                      </span>
                      <div style={{ display: 'flex', gap: 5 }} onClick={(e) => e.stopPropagation()}>
                        <button className="mini-action" onClick={() => void onOpenHotItem(h, 'transcript')}>
                          <Mic size={11} /> 口播稿
                        </button>
                        <button className="mini-action" onClick={() => void onOpenHotItem(h, 'comments')}>
                          <MessageSquareText size={11} /> 热评
                        </button>
                        <button
                          className={`mini-action ${h.saved_board_id ? 'starred' : ''}`}
                          onClick={(e) => void handleToggleHotStar(h, e)}
                          title={h.saved_board_id ? '取消收藏' : '收藏'}
                        >
                          <Star size={11} fill={h.saved_board_id ? 'currentColor' : 'none'} />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div style={{ marginTop: 10, textAlign: 'right' }}>
            <button className="btn btn-secondary btn-sm" onClick={() => onNavigate('hotboard')}>
              查看完整分类热榜 <ArrowRight size={13} />
            </button>
          </div>
        </div>
      </section>

      {/* 底区：双可视化图表（抓取与爆款双轴走势 + 监控平台占比环图） */}
      <section className="overview-bottom">
        <div className="panel-card" style={{ marginBottom: 0 }}>
          <div className="panel-head">
            <div className="panel-title">
              <TrendingUp size={16} color="#4f46e5" />
              <span>新增内容与爆款走势</span>
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
          <div style={{ width: '100%', height: 210 }}>
            <ResponsiveContainer>
              <ComposedChart data={trendSeries} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="day" tick={{ fontSize: 11, fill: '#64748b' }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#64748b' }} />
                <Tooltip />
                <Bar dataKey="total" name="新抓取内容" fill="#818cf8" fillOpacity={0.5} radius={[4, 4, 0, 0]} maxBarSize={28} />
                <Line type="monotone" dataKey="breakouts" name="触发爆款数" stroke="#ea580c" strokeWidth={2.5} dot={{ r: 3.5 }} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="panel-card" style={{ marginBottom: 0, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
          <div className="panel-head" style={{ marginBottom: 6 }}>
            <div className="panel-title">
              <PieIcon size={16} color="#0284c7" />
              <span>监控平台构成</span>
            </div>
          </div>

          {platDist.length === 0 ? (
            <div style={{ padding: 28, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12.5 }}>暂无数据</div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-around', gap: 12, flex: 1 }}>
              <div style={{ width: 145, height: 145 }}>
                <ResponsiveContainer>
                  <PieChart>
                    <Pie
                      data={platDist}
                      dataKey="count"
                      nameKey="platform"
                      innerRadius={40}
                      outerRadius={62}
                      paddingAngle={2}
                    >
                      {platDist.map((entry) => (
                        <Cell key={entry.platform} fill={PLATFORM_COLORS[entry.platform] || '#64748b'} />
                      ))}
                    </Pie>
                    <Tooltip
                      formatter={(val: unknown, name: unknown) => [
                        `${Number(val)} 条`,
                        PLATFORM_LABELS[String(name)] || String(name),
                      ]}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12.5 }}>
                {platDist.slice(0, 5).map((p) => (
                  <div key={p.platform} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    <span className="plat-dot" style={{ background: PLATFORM_COLORS[p.platform] || '#64748b' }} />
                    <span style={{ color: 'var(--text)' }}>{PLATFORM_LABELS[p.platform] || p.platform}</span>
                    <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>
                      {Math.round((p.count / platTotal) * 100)}%
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
