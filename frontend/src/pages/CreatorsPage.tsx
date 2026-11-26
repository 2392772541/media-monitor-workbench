import { useEffect, useState } from 'react';
import {
  Plus,
  RefreshCw,
  Trash2,
  Pause,
  Play,
  ExternalLink,
  Flame,
  Users,
  BarChart3,
  Search,
  Star,
  Mic,
  MessageSquareText,
} from 'lucide-react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Cell,
  CartesianGrid,
  ReferenceLine,
} from 'recharts';
import { apiRequest, fmtNum, fmtTime, PLATFORM_LABELS } from '../api';
import type { DrawerTab } from '../components/ContentDrawer';
import type { Category, CreatorMonitorRow } from '../types';

interface CreatorsPageProps {
  refreshTick: number;
  onToast: (msg: string) => void;
  onNavigate: (tab: string) => void;
  onOpenContent: (contentId: number, tab?: DrawerTab, savedBoardId?: number | null) => void;
  onRefreshBadge: () => void;
}

interface CreatorAnalyticsResp {
  creator: CreatorMonitorRow;
  works: Array<{
    id: number;
    title: string;
    canonical_url: string;
    platform: string;
    content_type: string;
    published_at: string | null;
    discovered_at: string;
    ai_category: string;
    brief: string;
    transcript_status: string;
    breakout_score: number | null;
    breakout_ratio: number | null;
    breakout_reason: string;
    latest_views: number | null;
    latest_likes: number | null;
    latest_comments: number | null;
    latest_favorites: number | null;
    latest_shares: number | null;
    comment_rows: number;
    saved_board_id: number | null;
  }>;
  topDirections: Array<{ name: string; count: number }>;
  chartData: Array<{
    id: number;
    title?: string;
    label: string;
    date: string;
    views: number;
    likes: number;
    ratio: number;
    isBreakout: boolean;
  }>;
}

const PLATFORM_COLORS: Record<string, string> = {
  bilibili: '#4f46e5',
  douyin: '#e11d48',
  youtube: '#dc2626',
  rss: '#0284c7',
  website: '#0d9488',
  x: '#0f172a',
};

export function CreatorsPage({
  refreshTick,
  onToast,
  onNavigate,
  onOpenContent,
  onRefreshBadge,
}: CreatorsPageProps) {
  const [creators, setCreators] = useState<CreatorMonitorRow[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [platformFilter, setPlatformFilter] = useState('');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [analytics, setAnalytics] = useState<CreatorAnalyticsResp | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  // 顶部极简一行添加博主条
  const [newUrl, setNewUrl] = useState('');
  const [newName, setNewName] = useState('');
  const [newCategoryId, setNewCategoryId] = useState('');
  const [adding, setAdding] = useState(false);

  const loadList = async () => {
    try {
      const qs = new URLSearchParams();
      if (platformFilter) qs.set('platform', platformFilter);
      if (query.trim()) qs.set('q', query.trim());
      const [list, cats] = await Promise.all([
        apiRequest<CreatorMonitorRow[]>(`/api/radar/creators?${qs.toString()}`),
        apiRequest<Category[]>('/api/categories'),
      ]);
      setCreators(list);
      setCategories(cats);
      if (list.length > 0 && (!selectedId || !list.some((x) => x.id === selectedId))) {
        setSelectedId(list[0].id);
      } else if (list.length === 0) {
        setSelectedId(null);
        setAnalytics(null);
      }
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  const loadAnalytics = async (id: number) => {
    setLoadingDetail(true);
    try {
      const res = await apiRequest<CreatorAnalyticsResp>(`/api/radar/creators/${id}/analytics`);
      setAnalytics(res);
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setLoadingDetail(false);
    }
  };

  useEffect(() => {
    void loadList();
  }, [platformFilter, refreshTick]);

  useEffect(() => {
    if (selectedId) void loadAnalytics(selectedId);
  }, [selectedId, refreshTick]);

  const handleAddCreator = async () => {
    if (!newUrl.trim()) {
      onToast('请先粘贴博主主页链接（支持抖音、B站、YouTube 或 RSS/网站）');
      return;
    }
    setAdding(true);
    try {
      const res = await apiRequest<{ source: CreatorMonitorRow }>('/api/sources', {
        method: 'POST',
        body: JSON.stringify({
          url: newUrl.trim(),
          name: newName.trim() || undefined,
          category_id: newCategoryId ? Number(newCategoryId) : undefined,
          interval_minutes: 120,
        }),
      });
      onToast(`已添加「${res.source.name}」，正在抓取最新作品...`);
      setNewUrl('');
      setNewName('');
      await apiRequest(`/api/sources/${res.source.id}/run`, { method: 'POST' }).catch(() => {});
      await loadList();
      setSelectedId(res.source.id);
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setAdding(false);
    }
  };

  const handleRunSource = async (id: number, name: string) => {
    try {
      const res = await apiRequest<{ queued: boolean; reason?: string }>(`/api/sources/${id}/run`, { method: 'POST' });
      onToast(res.queued ? `已触发更新「${name}」，稍后自动刷新走势图` : res.reason || '正在抓取中');
      setTimeout(() => {
        void loadList();
        if (selectedId === id) void loadAnalytics(id);
      }, 3500);
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  const handleToggleStatus = async (c: CreatorMonitorRow) => {
    const next = c.status === 'active' ? 'paused' : 'active';
    await apiRequest(`/api/sources/${c.id}`, { method: 'PATCH', body: JSON.stringify({ status: next }) });
    onToast(next === 'active' ? `已恢复监控「${c.name}」` : `已暂停监控「${c.name}」`);
    void loadList();
  };

  const handleDelete = async (c: CreatorMonitorRow) => {
    if (!window.confirm(`确定移除对标博主「${c.name}」吗？`)) return;
    await apiRequest(`/api/sources/${c.id}`, { method: 'DELETE' });
    onToast(`已移除「${c.name}」`);
    void loadList();
  };

  const handleToggleStar = async (work: CreatorAnalyticsResp['works'][number], ev: React.MouseEvent) => {
    ev.stopPropagation();
    try {
      if (work.saved_board_id) {
        await apiRequest(`/api/radar/board/${work.saved_board_id}`, { method: 'DELETE' });
        onToast('已取消收藏');
      } else {
        await apiRequest('/api/radar/board', {
          method: 'POST',
          body: JSON.stringify({
            title: work.title,
            source_content_id: work.id,
            core_angle: work.brief || work.breakout_reason || '',
            tags: [PLATFORM_LABELS[work.platform] || work.platform, analytics?.creator.name || ''].filter(Boolean),
            source_url: work.canonical_url,
          }),
        });
        onToast('已收藏到「简易收藏本」');
      }
      if (selectedId) await loadAnalytics(selectedId);
      onRefreshBadge();
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  const useViewsAxis = analytics ? analytics.chartData.some((x) => x.views > 0) : true;
  const baselineVal = analytics
    ? useViewsAxis
      ? analytics.creator.baseline_views
      : analytics.creator.baseline_likes
    : null;

  return (
    <div>
      {/* 顶部极简一行添加博主条 */}
      <div className="panel-card" style={{ padding: '14px 16px' }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            className="input"
            style={{ flex: '2 1 280px' }}
            placeholder="贴对标博主主页链接（抖音 / B站 / YouTube / 行业网站 RSS）..."
            value={newUrl}
            onChange={(e) => setNewUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void handleAddCreator()}
          />
          <input
            className="input"
            style={{ flex: '1 1 130px', maxWidth: 180 }}
            placeholder="备注名（可选）"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <select
            className="input"
            style={{ width: 120 }}
            value={newCategoryId}
            onChange={(e) => setNewCategoryId(e.target.value)}
          >
            <option value="">默认分组</option>
            {categories.map((cat) => (
              <option key={cat.id} value={cat.id}>
                {cat.name}
              </option>
            ))}
          </select>
          <button className="btn btn-primary" disabled={adding} onClick={handleAddCreator}>
            <Plus size={14} /> {adding ? '添加中...' : '添加并抓取'}
          </button>
          <button className="btn btn-secondary btn-sm" onClick={() => onNavigate('browsers')}>
            抖音/B站登录态
          </button>
        </div>
      </div>

      {/* 主左右分栏 */}
      <div className="split-workbench">
        {/* 左窄栏：已盯博主列表 */}
        <div className="panel-card" style={{ maxHeight: '78vh', overflowY: 'auto' }}>
          <div className="panel-head" style={{ marginBottom: 10 }}>
            <div className="panel-title">
              <Users size={16} color="#4f46e5" />
              <span>已盯博主 ({creators.length})</span>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
            <div className="pill-group">
              {[
                { k: '', l: '全部' },
                { k: 'douyin', l: '抖音' },
                { k: 'bilibili', l: 'B站' },
                { k: 'youtube', l: 'YouTube' },
                { k: 'rss', l: '资讯' },
              ].map((p) => (
                <button
                  key={p.k}
                  className={`pill-btn ${platformFilter === p.k ? 'active' : ''}`}
                  onClick={() => setPlatformFilter(p.k)}
                >
                  {p.l}
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                className="input"
                placeholder="搜博主名..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void loadList()}
              />
              <button className="btn btn-secondary btn-sm" onClick={() => void loadList()}>
                <Search size={13} />
              </button>
            </div>
          </div>

          {creators.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '24px 6px', textAlign: 'center' }}>
              还没有监控博主，在顶部贴主页链接就能开始盯盘。
            </div>
          ) : (
            <div className="feed-list">
              {creators.map((c) => {
                const pColor = PLATFORM_COLORS[c.platform] || '#4f46e5';
                return (
                  <div
                    key={c.id}
                    className={`creator-list-row ${selectedId === c.id ? 'selected' : ''}`}
                    onClick={() => setSelectedId(c.id)}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                        <span className="plat-dot" style={{ background: pColor }} />
                        <strong style={{ fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {c.name}
                        </strong>
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          {PLATFORM_LABELS[c.platform] || c.platform}
                        </span>
                      </div>
                      {(c.breakout_count || 0) > 0 && (
                        <span className="breakout-badge">{c.breakout_count} 爆款</span>
                      )}
                    </div>

                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginTop: 6,
                        fontSize: 11.5,
                        color: 'var(--text-muted)',
                      }}
                    >
                      <span>
                        粉丝 {fmtNum(c.follower_count)} · {c.content_count || 0} 作品
                      </span>
                      <div style={{ display: 'flex', gap: 4 }} onClick={(e) => e.stopPropagation()}>
                        <button
                          className="mini-action"
                          title="立即更新"
                          onClick={() => void handleRunSource(c.id, c.name)}
                        >
                          <RefreshCw size={11} />
                        </button>
                        <button
                          className="mini-action"
                          title={c.status === 'active' ? '暂停' : '恢复'}
                          onClick={() => void handleToggleStatus(c)}
                        >
                          {c.status === 'active' ? <Pause size={11} /> : <Play size={11} />}
                        </button>
                        <button
                          className="mini-action"
                          style={{ color: 'var(--danger)' }}
                          title="删除"
                          onClick={() => void handleDelete(c)}
                        >
                          <Trash2 size={11} />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 右宽栏：单博主动态表现走势 + 清爽作品列表 */}
        <div>
          {!analytics ? (
            <div className="panel-card" style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 48 }}>
              {loadingDetail ? '加载博主数据中...' : '点击左侧任意一位对标博主，查看播放走势与爆款作品。'}
            </div>
          ) : (
            <>
              <div className="panel-card">
                <div className="panel-head">
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <strong style={{ fontSize: 17 }}>{analytics.creator.name}</strong>
                      <span
                        className="plat-badge"
                        style={{ background: PLATFORM_COLORS[analytics.creator.platform] || '#4f46e5' }}
                      >
                        {PLATFORM_LABELS[analytics.creator.platform] || analytics.creator.platform}
                      </span>
                      <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
                        粉丝 {fmtNum(analytics.creator.follower_count)} · 平时中位数{' '}
                        <strong>{fmtNum(baselineVal)}</strong>
                        {useViewsAxis ? ' 播放' : ' 赞'}
                      </span>
                      <a
                        href={analytics.creator.url}
                        target="_blank"
                        rel="noreferrer"
                        style={{ color: 'var(--primary)', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 3 }}
                      >
                        主页 <ExternalLink size={12} />
                      </a>
                    </div>
                  </div>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => void handleRunSource(analytics.creator.id, analytics.creator.name)}
                  >
                    <RefreshCw size={13} /> 更新作品
                  </button>
                </div>

                {/* 近期作品表现柱状图（带常态中位数虚线 + 橙色爆款柱，点击直开抽屉） */}
                {analytics.chartData.length > 0 ? (
                  <div>
                    <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <BarChart3 size={14} color="#ea580c" />
                      <span>
                        橙色柱子 = 超过平时水平的爆款作品（点击任意柱子直接看口播稿与热评）
                      </span>
                    </div>
                    <div style={{ width: '100%', height: 215 }}>
                      <ResponsiveContainer>
                        <BarChart
                          data={analytics.chartData}
                          margin={{ top: 10, right: 16, left: 6, bottom: 0 }}
                          onClick={(state) => {
                            const payload = (state as { activePayload?: Array<{ payload?: { id?: number } }> })?.activePayload?.[0]?.payload;
                            if (payload?.id) onOpenContent(payload.id, 'point');
                          }}
                        >
                          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                          <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#64748b' }} />
                          <YAxis
                            width={58}
                            tickFormatter={(v) => fmtNum(Number(v), '0')}
                            tick={{ fontSize: 11, fill: '#64748b' }}
                          />
                          <Tooltip
                            formatter={(val: unknown) => [fmtNum(Number(val), '0'), useViewsAxis ? '播放量' : '点赞数']}
                            labelFormatter={(_label, payload) => {
                              const row = payload?.[0]?.payload as { title?: string; ratio?: number } | undefined;
                              return row?.title ? `${row.title}${row.ratio ? `（${row.ratio}x）` : ''}` : '';
                            }}
                          />
                          {baselineVal != null && baselineVal > 0 && (
                            <ReferenceLine
                              y={baselineVal}
                              stroke="#ea580c"
                              strokeDasharray="5 4"
                              label={{
                                value: `常态 ${fmtNum(baselineVal)}`,
                                position: 'insideTopLeft',
                                fill: '#ea580c',
                                fontSize: 11,
                              }}
                            />
                          )}
                          <Bar
                            dataKey={useViewsAxis ? 'views' : 'likes'}
                            radius={[5, 5, 0, 0]}
                            maxBarSize={36}
                            style={{ cursor: 'pointer' }}
                          >
                            {analytics.chartData.map((entry) => (
                              <Cell key={entry.id} fill={entry.isBreakout ? '#ea580c' : '#818cf8'} />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                ) : (
                  <div style={{ padding: '20px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                    暂无足够数据绘制走势图，点右上角「更新作品」抓一次即可。
                  </div>
                )}
              </div>

              {/* 清爽作品清单（无拥挤表格、无文字墙） */}
              <div className="panel-card" style={{ marginBottom: 0 }}>
                <div className="panel-head">
                  <div className="panel-title">
                    <Flame size={16} color="#ea580c" />
                    <span>近期作品清单 ({analytics.works.length})</span>
                  </div>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>点任意一条滑出「看点 / 口播稿 / 热评」</span>
                </div>

                {analytics.works.length === 0 ? (
                  <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '20px 0', textAlign: 'center' }}>
                    暂无作品，点上方「更新作品」立即抓取。
                  </div>
                ) : (
                  <div className="feed-list">
                    {analytics.works.map((w) => {
                      const isBoom = (w.breakout_ratio ?? 0) >= 1.6 || (w.breakout_score ?? 0) >= 68;
                      return (
                        <div
                          key={w.id}
                          className="feed-row"
                          onClick={() => onOpenContent(w.id, 'point', w.saved_board_id)}
                        >
                          <div className="feed-row-head">
                            <span className="feed-row-title">{w.title}</span>
                            {w.breakout_ratio != null ? (
                              <span className={isBoom ? 'breakout-badge' : 'badge badge-gray'}>
                                {isBoom ? '🔥 ' : ''}
                                {w.breakout_ratio}x
                              </span>
                            ) : (
                              <span className="badge badge-gray">样本不足</span>
                            )}
                          </div>

                          {w.brief && <div className="feed-row-brief">💡 {w.brief}</div>}

                          <div className="feed-row-meta">
                            <span>
                              {fmtTime(w.published_at || w.discovered_at)} · 播 {fmtNum(w.latest_views)} · 赞 {fmtNum(w.latest_likes)} · 评 {fmtNum(w.latest_comments)}
                            </span>
                            <div style={{ display: 'flex', gap: 5 }} onClick={(e) => e.stopPropagation()}>
                              <button
                                className="mini-action"
                                onClick={() => onOpenContent(w.id, 'transcript', w.saved_board_id)}
                              >
                                <Mic size={11} /> {w.transcript_status === 'done' ? '看口播稿 ✓' : '口播稿'}
                              </button>
                              <button
                                className="mini-action"
                                onClick={() => onOpenContent(w.id, 'comments', w.saved_board_id)}
                              >
                                <MessageSquareText size={11} /> 热评{w.comment_rows ? `(${w.comment_rows})` : ''}
                              </button>
                              <button
                                className={`mini-action ${w.saved_board_id ? 'starred' : ''}`}
                                onClick={(e) => void handleToggleStar(w, e)}
                              >
                                <Star size={11} fill={w.saved_board_id ? 'currentColor' : 'none'} />
                                {w.saved_board_id ? '已藏' : '收藏'}
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
