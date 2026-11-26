import { useEffect, useMemo, useState } from 'react';
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
  Star,
  Trophy,
  Wand2,
  Mic,
  CheckCircle2,
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
import type { Category, CreatorLeaderboardItem, CreatorMonitorRow } from '../types';

interface CreatorsPageProps {
  refreshTick: number;
  onToast: (msg: string) => void;
  onNavigate: (tab: string) => void;
  onOpenContent: (contentId: number, tab?: DrawerTab, savedBoardId?: number | null) => void;
  onOpenRemix: (contentId: number) => void;
  onRefreshBadge: () => void;
}

interface CreatorAnalyticsResp {
  creator: CreatorMonitorRow;
  works: Array<{
    id: number;
    title: string;
    canonical_url: string;
    cover_url?: string;
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
  onOpenRemix,
  onRefreshBadge,
}: CreatorsPageProps) {
  const [viewMode, setViewMode] = useState<'leaderboard' | 'creators'>('leaderboard');

  // 跨博主爆款总排行榜状态
  const [leaderboard, setLeaderboard] = useState<CreatorLeaderboardItem[]>([]);
  const [loadingBoard, setLoadingBoard] = useState(true);
  const [sortBy, setSortBy] = useState<'ratio' | 'likes' | 'views' | 'recent'>('ratio');
  const [daysFilter, setDaysFilter] = useState<number>(0);
  const [platformFilter, setPlatformFilter] = useState<string>('');
  const [creatorFilterId, setCreatorFilterId] = useState<string>('');
  const [onlyBreakout, setOnlyBreakout] = useState<boolean>(false);

  // 博主管理与单博主走势状态
  const [creators, setCreators] = useState<CreatorMonitorRow[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [analytics, setAnalytics] = useState<CreatorAnalyticsResp | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const [newUrl, setNewUrl] = useState('');
  const [newName, setNewName] = useState('');
  const [newCategoryId, setNewCategoryId] = useState('');
  const [adding, setAdding] = useState(false);

  const loadCreators = async () => {
    try {
      const [list, cats] = await Promise.all([
        apiRequest<CreatorMonitorRow[]>('/api/radar/creators'),
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

  const loadLeaderboard = async () => {
    setLoadingBoard(true);
    try {
      const qs = new URLSearchParams();
      qs.set('sort', sortBy);
      qs.set('limit', '50');
      if (platformFilter) qs.set('platform', platformFilter);
      if (creatorFilterId) qs.set('creatorId', creatorFilterId);
      if (daysFilter > 0) qs.set('days', String(daysFilter));
      if (onlyBreakout) qs.set('onlyBreakout', 'true');
      const res = await apiRequest<{ items: CreatorLeaderboardItem[] }>(`/api/radar/creators/leaderboard?${qs.toString()}`);
      setLeaderboard(res.items || []);
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setLoadingBoard(false);
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
    void loadCreators();
  }, [refreshTick]);

  useEffect(() => {
    void loadLeaderboard();
  }, [sortBy, daysFilter, platformFilter, creatorFilterId, onlyBreakout, refreshTick]);

  useEffect(() => {
    if (viewMode === 'creators' && selectedId) {
      void loadAnalytics(selectedId);
    }
  }, [viewMode, selectedId, refreshTick]);

  const handleAddCreator = async () => {
    if (!newUrl.trim()) {
      onToast('请先粘贴博主主页链接（支持抖音分享口令、B站空间、YouTube）');
      return;
    }
    setAdding(true);
    try {
      const res = await apiRequest<{ source: CreatorMonitorRow; deduplicated?: boolean }>('/api/sources', {
        method: 'POST',
        body: JSON.stringify({
          url: newUrl.trim(),
          name: newName.trim() || undefined,
          category_id: newCategoryId ? Number(newCategoryId) : undefined,
          interval_minutes: 120,
        }),
      });
      onToast(
        res.deduplicated
          ? `「${res.source.name}」已在监控列表，正在为您刷新最新作品...`
          : `已添加「${res.source.name}」，正在抓取博主真名与最新作品（约 5～10 秒自动更新榜单）...`
      );
      setNewUrl('');
      setNewName('');
      await loadCreators();
      setSelectedId(res.source.id);
      setTimeout(() => {
        void loadCreators();
        void loadLeaderboard();
      }, 6500);
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setAdding(false);
    }
  };

  const handleCheckSource = async (id: number, name: string) => {
    try {
      const res = await apiRequest<{ queued?: boolean; reason?: string }>(`/api/sources/${id}/check`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      onToast(res.queued ? `已触发更新「${name}」，稍后自动刷新榜单` : res.reason || '正在抓取中');
      setTimeout(() => {
        void loadCreators();
        void loadLeaderboard();
        if (selectedId === id) void loadAnalytics(id);
      }, 5000);
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  const handleToggleStatus = async (c: CreatorMonitorRow) => {
    const next = c.status === 'active' ? 'paused' : 'active';
    await apiRequest(`/api/sources/${c.id}`, { method: 'PATCH', body: JSON.stringify({ status: next }) });
    onToast(next === 'active' ? `已恢复监控「${c.name}」` : `已暂停监控「${c.name}」`);
    void loadCreators();
  };

  const handleDelete = async (c: CreatorMonitorRow) => {
    if (!window.confirm(`确定移除对标博主「${c.name}」吗？`)) return;
    await apiRequest(`/api/sources/${c.id}`, { method: 'DELETE' });
    onToast(`已移除「${c.name}」`);
    void loadCreators();
    void loadLeaderboard();
  };

  const handleToggleStar = async (
    item: { id: number; title: string; platform: string; canonical_url: string; source_name: string; saved_board_id: number | null; brief?: string; breakout_reason?: string },
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
      await loadLeaderboard();
      if (viewMode === 'creators' && selectedId) await loadAnalytics(selectedId);
      onRefreshBadge();
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  const summary = useMemo(() => {
    const totalWorks = creators.reduce((acc, c) => acc + (c.content_count || 0), 0);
    const totalBreakouts = creators.reduce((acc, c) => acc + (c.breakout_count || 0), 0);
    const transcribed = leaderboard.filter((x) => x.transcript_chars > 50).length;
    return { creatorCount: creators.length, totalWorks, totalBreakouts, transcribed };
  }, [creators, leaderboard]);

  const useViewsAxis = analytics ? analytics.chartData.some((x) => x.views > 0) : true;
  const baselineVal = analytics
    ? useViewsAxis
      ? analytics.creator.baseline_views
      : analytics.creator.baseline_likes
    : null;

  return (
    <div>
      {/* 顶部概览 + 快速添加对标博主 */}
      <div className="panel-card" style={{ padding: '14px 16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <div className="tab-pill-bar" style={{ marginBottom: 0 }}>
              <button
                type="button"
                data-testid="creators-tab-leaderboard"
                className={`tab-pill ${viewMode === 'leaderboard' ? 'active' : ''}`}
                onClick={() => setViewMode('leaderboard')}
              >
                <Trophy size={14} /> 爆款总排行榜（跨博主对比与二创）
              </button>
              <button
                type="button"
                data-testid="creators-tab-manage"
                className={`tab-pill ${viewMode === 'creators' ? 'active' : ''}`}
                onClick={() => setViewMode('creators')}
              >
                <Users size={14} /> 博主卡片管理 ({summary.creatorCount})
              </button>
            </div>
          </div>

          <div className="status-chips">
            <span className="status-chip">
              已抓作品 <strong>{summary.totalWorks}</strong>
            </span>
            <span className="status-chip hot">
              🔥 爆款 <strong>{summary.totalBreakouts}</strong>
            </span>
            <span className="status-chip">
              🎙 已有口播稿 <strong>{summary.transcribed}</strong>
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            className="input"
            style={{ flex: '2 1 280px' }}
            placeholder="贴抖音分享口令 / 抖音主页 / B站UP主空间 / YouTube 链接添加新对标..."
            value={newUrl}
            onChange={(e) => setNewUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void handleAddCreator()}
          />
          <input
            className="input"
            style={{ flex: '1 1 120px', maxWidth: 160 }}
            placeholder="备注名（可选）"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <select
            className="select"
            style={{ width: 118 }}
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
          <button type="button" className="btn btn-primary btn-sm" disabled={adding} onClick={() => void handleAddCreator()}>
            <Plus size={14} /> {adding ? '添加中...' : '添加对标博主'}
          </button>
          <button type="button" className="btn btn-sm" onClick={() => onNavigate('browsers')}>
            维护登录态
          </button>
        </div>
      </div>

      {/* ===== 主视图 A：跨博主爆款总排行榜（一眼看出谁爆了 + 一键拆解二创） ===== */}
      {viewMode === 'leaderboard' ? (
        <div className="panel-card" style={{ marginBottom: 0 }}>
          {/* 排名维度与筛选栏 */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
            <div className="pill-group">
              {[
                { k: 'ratio' as const, l: '🔥 按爆款倍数排' },
                { k: 'likes' as const, l: '👍 按点赞最高排' },
                { k: 'views' as const, l: '▶ 按播放最高排' },
                { k: 'recent' as const, l: '🕒 按最新发布排' },
              ].map((s) => (
                <button
                  key={s.k}
                  type="button"
                  data-testid={`lb-sort-${s.k}`}
                  className={`pill-btn ${sortBy === s.k ? 'active' : ''}`}
                  onClick={() => setSortBy(s.k)}
                >
                  {s.l}
                </button>
              ))}
            </div>

            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <select
                className="select"
                style={{ width: 118, padding: '6px 9px', fontSize: 12.5 }}
                value={daysFilter}
                onChange={(e) => setDaysFilter(Number(e.target.value))}
              >
                <option value={0}>全部时间</option>
                <option value={7}>最近 7 天</option>
                <option value={30}>最近 30 天</option>
              </select>

              <select
                className="select"
                style={{ width: 112, padding: '6px 9px', fontSize: 12.5 }}
                value={platformFilter}
                onChange={(e) => setPlatformFilter(e.target.value)}
              >
                <option value="">全部平台</option>
                <option value="douyin">抖音</option>
                <option value="bilibili">B站</option>
                <option value="youtube">YouTube</option>
              </select>

              <select
                className="select"
                style={{ width: 150, padding: '6px 9px', fontSize: 12.5 }}
                value={creatorFilterId}
                onChange={(e) => setCreatorFilterId(e.target.value)}
              >
                <option value="">全部对标博主</option>
                {creators.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({PLATFORM_LABELS[c.platform] || c.platform})
                  </option>
                ))}
              </select>

              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12.5, cursor: 'pointer' }}>
                <input type="checkbox" checked={onlyBreakout} onChange={(e) => setOnlyBreakout(e.target.checked)} />
                仅看 ≥1.6x 真爆款
              </label>
            </div>
          </div>

          {loadingBoard && leaderboard.length === 0 ? (
            <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-muted)' }}>正在加载爆款排行榜...</div>
          ) : leaderboard.length === 0 ? (
            <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-muted)' }}>
              当前筛选条件下没有作品，可以放宽时间范围或切回「全部时间」。
            </div>
          ) : (
            <div className="rank-card-list">
              {leaderboard.map((item) => {
                const ratio = item.breakout_ratio || 0;
                const barPct = Math.min(100, Math.max(12, Math.round((ratio / 6) * 100)));
                const platColor = PLATFORM_COLORS[item.platform] || '#4f46e5';
                return (
                  <div key={item.id} className="rank-card" data-testid={`lb-row-${item.rank}`}>
                    {/* 排名勋章 */}
                    <span
                      className={`rank-medal ${
                        item.rank === 1 ? 'top1' : item.rank === 2 ? 'top2' : item.rank === 3 ? 'top3' : ''
                      }`}
                    >
                      #{item.rank}
                    </span>

                    {/* 16:9 高清封面 */}
                    <div className="rank-thumb" onClick={() => onOpenContent(item.id, 'point', item.saved_board_id)}>
                      {item.cover_url ? (
                        <img src={item.cover_url} alt={item.title} referrerPolicy="no-referrer" loading="lazy" />
                      ) : (
                        <div className="vcard-fallback-text">{PLATFORM_LABELS[item.platform] || item.platform}</div>
                      )}
                      {ratio >= 1.6 && (
                        <span
                          className="vcard-badge vcard-badge-boom"
                          style={{ position: 'absolute', top: 6, left: 6, fontSize: 11 }}
                        >
                          <Flame size={11} /> {ratio}x
                        </span>
                      )}
                    </div>

                    {/* 中间核心情报：标题 + 博主 + 爆款倍数对比条 + 互动数据 + 口播/二创状态 */}
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 4 }}>
                        <span className="plat-badge" style={{ background: platColor }}>
                          {PLATFORM_LABELS[item.platform] || item.platform}
                        </span>
                        <span style={{ fontSize: 12.5, fontWeight: 700, color: '#334155' }}>{item.source_name}</span>
                        <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                          {fmtTime(item.published_at || item.discovered_at)}
                        </span>
                        {item.transcript_chars > 50 && (
                          <span className="badge badge-green" style={{ fontSize: 11 }}>
                            <CheckCircle2 size={11} style={{ marginRight: 3 }} /> 已有口播稿
                          </span>
                        )}
                        {item.remix_draft_count > 0 && (
                          <span className="badge badge-blue" style={{ fontSize: 11 }}>
                            已写 {item.remix_draft_count} 篇二创稿
                          </span>
                        )}
                      </div>

                      <div
                        style={{
                          fontSize: 15,
                          fontWeight: 700,
                          color: 'var(--text)',
                          lineHeight: 1.4,
                          cursor: 'pointer',
                          marginBottom: 6,
                        }}
                        onClick={() => onOpenContent(item.id, 'point', item.saved_board_id)}
                      >
                        {item.title}
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', fontSize: 12.5, color: '#475569' }}>
                        {ratio > 0 && (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            <strong style={{ color: ratio >= 1.6 ? '#ea580c' : '#475569' }}>{ratio}x 均值</strong>
                            <span className="ratio-bar-track">
                              <span className="ratio-bar-fill" style={{ width: `${barPct}%` }} />
                            </span>
                          </span>
                        )}
                        {item.latest_views != null && <span>▶ 播放 <strong>{fmtNum(item.latest_views)}</strong></span>}
                        {item.latest_likes != null && <span>👍 赞 <strong>{fmtNum(item.latest_likes)}</strong></span>}
                        {item.latest_comments != null && <span>💬 评 {fmtNum(item.latest_comments)}</span>}
                        {item.latest_favorites != null && item.latest_favorites > 0 && (
                          <span>⭐ 藏 {fmtNum(item.latest_favorites)}</span>
                        )}
                      </div>
                    </div>

                    {/* 右侧直接行动区：拆解二创 + 扒/看口播 + 收藏 */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
                      <button
                        type="button"
                        data-testid={`lb-remix-btn-${item.rank}`}
                        className="btn btn-primary btn-sm"
                        onClick={() => onOpenRemix(item.id)}
                      >
                        <Wand2 size={13} /> 拆解与二创写稿
                      </button>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => onOpenContent(item.id, 'transcript', item.saved_board_id)}
                        >
                          <Mic size={12} /> {item.transcript_chars > 50 ? '看口播稿' : '显卡扒口播'}
                        </button>
                        <button
                          type="button"
                          className={`btn btn-sm ${item.saved_board_id ? 'btn-star-active' : ''}`}
                          onClick={(e) => void handleToggleStar(item, e)}
                          title={item.saved_board_id ? '取消收藏' : '收藏到本子'}
                        >
                          <Star size={12} fill={item.saved_board_id ? 'currentColor' : 'none'} />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        /* ===== 视图 B：高质感博主卡片矩阵 + 单博主爆款走势与作品 ===== */
        <div>
          <div className="creator-grid-cards">
            {creators.map((c) => {
              const pColor = PLATFORM_COLORS[c.platform] || '#4f46e5';
              const active = selectedId === c.id;
              return (
                <div
                  key={c.id}
                  className={`creator-profile-card ${active ? 'active' : ''}`}
                  onClick={() => setSelectedId(c.id)}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                        <span className="plat-badge" style={{ background: pColor }}>
                          {PLATFORM_LABELS[c.platform] || c.platform}
                        </span>
                        <span className={`badge ${c.status === 'active' ? 'badge-green' : 'badge-gray'}`}>
                          {c.status === 'active' ? '自动监控中' : '已暂停'}
                        </span>
                      </div>
                      <div style={{ fontSize: 15.5, fontWeight: 700, color: 'var(--text)' }}>{c.name}</div>
                    </div>
                    {c.max_breakout_ratio != null && c.max_breakout_ratio >= 1.6 && (
                      <span className="breakout-badge">
                        <Flame size={11} /> 最高 {c.max_breakout_ratio}x
                      </span>
                    )}
                  </div>

                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 10, fontSize: 12.5, color: '#475569' }}>
                    {c.follower_count != null && <span>粉丝 <strong>{fmtNum(c.follower_count)}</strong></span>}
                    <span>已抓 <strong>{c.content_count || 0}</strong> 条</span>
                    <span>爆款 <strong style={{ color: '#ea580c' }}>{c.breakout_count || 0}</strong> 条</span>
                  </div>

                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 6 }}>
                    最近更新：{fmtTime(c.last_checked_at)}
                  </div>

                  <div style={{ display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' }} onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => void handleCheckSource(c.id, c.name)}
                    >
                      <RefreshCw size={12} /> 立即抓一次
                    </button>
                    <button type="button" className="btn btn-sm" onClick={() => void handleToggleStatus(c)}>
                      {c.status === 'active' ? <Pause size={12} /> : <Play size={12} />}
                      {c.status === 'active' ? '暂停' : '恢复'}
                    </button>
                    <a href={c.url} target="_blank" rel="noreferrer" className="btn btn-sm" style={{ textDecoration: 'none' }}>
                      <ExternalLink size={12} /> 主页
                    </a>
                    <button type="button" className="btn btn-danger btn-sm" onClick={() => void handleDelete(c)}>
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {analytics && (
            <div className="panel-card" style={{ marginBottom: 0 }}>
              <div className="panel-head">
                <div className="panel-title">
                  <BarChart3 size={16} color="#4f46e5" />
                  <span>{analytics.creator.name} · 近期作品走势（红柱 = ≥1.6x 爆款，点柱子直接二创）</span>
                </div>
                {loadingDetail && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>加载中...</span>}
              </div>

              {analytics.chartData.length > 0 && (
                <div style={{ width: '100%', height: 220, marginBottom: 16 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={analytics.chartData} margin={{ top: 8, right: 14, left: 0, bottom: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                      <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#64748b' }} />
                      <YAxis tick={{ fontSize: 11, fill: '#64748b' }} tickFormatter={(v) => fmtNum(Number(v))} width={56} />
                      <Tooltip
                        formatter={(val) => [fmtNum(Number(val)), useViewsAxis ? '播放量' : '点赞数']}
                        labelFormatter={(_, payload) => String(payload?.[0]?.payload?.title || '')}
                      />
                      {baselineVal != null && baselineVal > 0 && (
                        <ReferenceLine
                          y={baselineVal}
                          stroke="#94a3b8"
                          strokeDasharray="4 4"
                          label={{ value: '平时均值', fill: '#64748b', fontSize: 11, position: 'insideTopRight' }}
                        />
                      )}
                      <Bar
                        dataKey={useViewsAxis ? 'views' : 'likes'}
                        radius={[6, 6, 0, 0]}
                        cursor="pointer"
                        onClick={(d) => {
                          if (d && typeof d.id === 'number') onOpenRemix(d.id);
                        }}
                      >
                        {analytics.chartData.map((entry) => (
                          <Cell key={entry.id} fill={entry.isBreakout ? '#ea580c' : '#6366f1'} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}

              <div className="rank-card-list">
                {analytics.works.map((w, idx) => (
                  <div key={w.id} className="rank-card">
                    <span className="rank-medal">#{idx + 1}</span>
                    <div className="rank-thumb" onClick={() => onOpenContent(w.id, 'point', w.saved_board_id)}>
                      {w.cover_url ? (
                        <img src={w.cover_url} alt={w.title} referrerPolicy="no-referrer" loading="lazy" />
                      ) : (
                        <div className="vcard-fallback-text">{PLATFORM_LABELS[w.platform] || w.platform}</div>
                      )}
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div
                        style={{ fontSize: 14.5, fontWeight: 700, color: 'var(--text)', cursor: 'pointer' }}
                        onClick={() => onOpenContent(w.id, 'point', w.saved_board_id)}
                      >
                        {w.title}
                      </div>
                      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 6, fontSize: 12, color: 'var(--text-muted)' }}>
                        {w.breakout_ratio != null && w.breakout_ratio >= 1.6 && (
                          <span className="badge badge-amber">🔥 {w.breakout_ratio}x 爆款</span>
                        )}
                        {w.latest_views != null && <span>▶ {fmtNum(w.latest_views)}</span>}
                        {w.latest_likes != null && <span>👍 {fmtNum(w.latest_likes)}</span>}
                        <span>{fmtTime(w.published_at || w.discovered_at)}</span>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => onOpenRemix(w.id)}>
                        <Wand2 size={13} /> 拆解二创
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => onOpenContent(w.id, 'transcript', w.saved_board_id)}
                      >
                        口播稿
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
