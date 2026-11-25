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
  Sparkles,
} from 'lucide-react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Cell, CartesianGrid } from 'recharts';
import { apiRequest, fmtNum, fmtTime, PLATFORM_LABELS } from '../api';
import type { Category, CreatorMonitorRow } from '../types';

interface CreatorsPageProps {
  onToast: (msg: string) => void;
  onNavigate: (tab: string) => void;
  onOpenIntelDetail: (contentId: number) => void;
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
  }>;
  topDirections: Array<{ name: string; count: number }>;
  chartData: Array<{
    id: number;
    label: string;
    date: string;
    views: number;
    likes: number;
    ratio: number;
    isBreakout: boolean;
  }>;
}

export function CreatorsPage({ onToast, onNavigate, onOpenIntelDetail }: CreatorsPageProps) {
  const [creators, setCreators] = useState<CreatorMonitorRow[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [platformFilter, setPlatformFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [analytics, setAnalytics] = useState<CreatorAnalyticsResp | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  // 添加博主表单
  const [showAdd, setShowAdd] = useState(false);
  const [newUrl, setNewUrl] = useState('');
  const [newName, setNewName] = useState('');
  const [newPlatform, setNewPlatform] = useState('');
  const [newCategoryId, setNewCategoryId] = useState('');
  const [newInterval, setNewInterval] = useState(120);
  const [probeMsg, setProbeMsg] = useState('');
  const [probing, setProbing] = useState(false);
  const [adding, setAdding] = useState(false);

  const loadList = async () => {
    try {
      const qs = new URLSearchParams();
      if (platformFilter) qs.set('platform', platformFilter);
      if (categoryFilter) qs.set('categoryId', categoryFilter);
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
  }, [platformFilter, categoryFilter]);

  useEffect(() => {
    if (selectedId) void loadAnalytics(selectedId);
  }, [selectedId]);

  const handleProbe = async () => {
    if (!newUrl.trim()) return;
    setProbing(true);
    setProbeMsg('');
    try {
      const res = await apiRequest<{
        recognized: { platform: string; normalizedUrl: string };
        availability: { available: boolean; detectedTitle?: string; message: string };
      }>('/api/sources/probe', {
        method: 'POST',
        body: JSON.stringify({ url: newUrl.trim(), platform: newPlatform || undefined }),
      });
      setNewPlatform(res.recognized.platform);
      if (res.availability.detectedTitle && !newName.trim()) {
        setNewName(res.availability.detectedTitle);
      }
      setProbeMsg(`${res.availability.available ? '✓' : '⚠'} [${PLATFORM_LABELS[res.recognized.platform] || res.recognized.platform}] ${res.availability.message}`);
    } catch (err) {
      setProbeMsg(`检测失败：${(err as Error).message}`);
    } finally {
      setProbing(false);
    }
  };

  const handleAddCreator = async () => {
    if (!newUrl.trim()) {
      onToast('请粘贴博主主页、YouTube 频道、B站空间或网站/RSS 链接');
      return;
    }
    setAdding(true);
    try {
      const res = await apiRequest<{ source: CreatorMonitorRow }>('/api/sources', {
        method: 'POST',
        body: JSON.stringify({
          url: newUrl.trim(),
          name: newName.trim() || undefined,
          platform: newPlatform || undefined,
          category_id: newCategoryId ? Number(newCategoryId) : undefined,
          interval_minutes: newInterval,
        }),
      });
      onToast(`已添加「${res.source.name}」，正在自动触发首次真实采集`);
      setNewUrl('');
      setNewName('');
      setNewPlatform('');
      setProbeMsg('');
      setShowAdd(false);
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
      onToast(res.queued ? `已触发采集「${name}」，稍后自动刷新作品与爆款基线` : res.reason || '已在采集中');
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
    if (!window.confirm(`确定删除监控对象「${c.name}」及其采集历史吗？`)) return;
    await apiRequest(`/api/sources/${c.id}`, { method: 'DELETE' });
    onToast(`已删除「${c.name}」`);
    void loadList();
  };

  const handleRecomputeAll = async () => {
    const res = await apiRequest<{ sourcesProcessed: number; contentsUpdated: number }>('/api/radar/creators/recompute-breakout', {
      method: 'POST',
    });
    onToast(`已重算 ${res.sourcesProcessed} 个博主的历史基线，更新 ${res.contentsUpdated} 条爆款指数`);
    void loadList();
    if (selectedId) void loadAnalytics(selectedId);
  };

  return (
    <div>
      {/* 顶部工具条 */}
      <div className="panel-card" style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <select className="input" style={{ width: 130 }} value={platformFilter} onChange={(e) => setPlatformFilter(e.target.value)}>
            <option value="">全部平台</option>
            <option value="douyin">抖音</option>
            <option value="bilibili">B站</option>
            <option value="youtube">YouTube</option>
            <option value="rss">RSS 订阅</option>
            <option value="website">行业网站</option>
            <option value="x">X (Twitter)</option>
          </select>
          <select className="input" style={{ width: 130 }} value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
            <option value="">全部分组</option>
            {categories.map((cat) => (
              <option key={cat.id} value={cat.id}>
                {cat.name}
              </option>
            ))}
          </select>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              className="input"
              style={{ width: 190 }}
              placeholder="搜博主名或备注..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void loadList()}
            />
            <button className="btn btn-secondary" onClick={() => void loadList()}>
              <Search size={14} />
            </button>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-secondary" onClick={handleRecomputeAll}>
            <Flame size={14} /> 重算爆款基线
          </button>
          <button className="btn btn-primary" onClick={() => setShowAdd((v) => !v)}>
            <Plus size={14} /> 添加监控博主/网站
          </button>
        </div>
      </div>

      {/* 添加博主抽屉 */}
      {showAdd && (
        <div className="panel-card" style={{ borderColor: '#c7d2fe', background: '#fafbff' }}>
          <div className="panel-title" style={{ marginBottom: 10 }}>
            新增指定博主 / 频道 / 行业网站（支持抖音、B站、YouTube、RSS、行业站）
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', gap: 10 }}>
            <input
              className="input"
              placeholder="粘贴主页链接，如 https://space.bilibili.com/xxx 或抖音主页、YouTube频道、RSS"
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
            />
            <input className="input" placeholder="自定义名称（可留空自动识别）" value={newName} onChange={(e) => setNewName(e.target.value)} />
            <select className="input" value={newCategoryId} onChange={(e) => setNewCategoryId(e.target.value)}>
              <option value="">默认分组</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <input
              className="input"
              type="number"
              min={15}
              max={1440}
              value={newInterval}
              onChange={(e) => setNewInterval(Number(e.target.value))}
              title="自动采集频率（分钟）"
            />
          </div>
          {probeMsg && <div style={{ fontSize: 12.5, marginTop: 8, color: '#334155' }}>{probeMsg}</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button className="btn btn-secondary" disabled={probing} onClick={handleProbe}>
              {probing ? '识别检测中...' : '检测链接与平台'}
            </button>
            <button className="btn btn-primary" disabled={adding} onClick={handleAddCreator}>
              {adding ? '添加中...' : '确认添加并立即采集'}
            </button>
            <button className="btn btn-secondary" onClick={() => onNavigate('browsers')}>
              去维护抖音/B站登录态
            </button>
          </div>
        </div>
      )}

      {/* 主左右分栏 */}
      <div className="split-workbench">
        {/* 左栏：博主列表 */}
        <div className="panel-card" style={{ maxHeight: '76vh', overflowY: 'auto' }}>
          <div className="panel-head">
            <div className="panel-title">
              <Users size={16} color="#4f46e5" />
              <span>监控博主列表 ({creators.length})</span>
            </div>
          </div>
          {creators.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '20px 4px', textAlign: 'center' }}>
              暂无监控博主，点击右上角「添加监控博主/网站」开始追踪。
            </div>
          ) : (
            creators.map((c) => (
              <div
                key={c.id}
                className={`selectable-row ${selectedId === c.id ? 'selected' : ''}`}
                onClick={() => setSelectedId(c.id)}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                  <strong style={{ fontSize: 14 }}>{c.name}</strong>
                  <span className="metric-chip">{PLATFORM_LABELS[c.platform] || c.platform}</span>
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <span>分组：{c.category_name || '默认'}</span>
                  <span>粉丝：{fmtNum(c.follower_count)}</span>
                  <span>作品：{c.content_count || 0}</span>
                  {(c.breakout_count || 0) > 0 && <span style={{ color: '#ea580c', fontWeight: 700 }}>🔥 爆款 {c.breakout_count}</span>}
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 7 }}>
                  <span style={{ fontSize: 11, color: c.last_error ? 'var(--danger)' : 'var(--text-muted)' }}>
                    {c.capability_status} · {fmtTime(c.last_checked_at)}
                  </span>
                  <div style={{ display: 'flex', gap: 4 }} onClick={(e) => e.stopPropagation()}>
                    <button
                      className="btn btn-secondary"
                      style={{ padding: '3px 7px', fontSize: 11.5 }}
                      title="立即采集"
                      onClick={() => handleRunSource(c.id, c.name)}
                    >
                      <RefreshCw size={12} />
                    </button>
                    <button
                      className="btn btn-secondary"
                      style={{ padding: '3px 7px', fontSize: 11.5 }}
                      title={c.status === 'active' ? '暂停' : '恢复'}
                      onClick={() => handleToggleStatus(c)}
                    >
                      {c.status === 'active' ? <Pause size={12} /> : <Play size={12} />}
                    </button>
                    <button
                      className="btn btn-secondary"
                      style={{ padding: '3px 7px', fontSize: 11.5, color: 'var(--danger)' }}
                      title="删除"
                      onClick={() => handleDelete(c)}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        {/* 右栏：博主表现看板与历史作品 */}
        <div>
          {!analytics ? (
            <div className="panel-card" style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 40 }}>
              {loadingDetail ? '加载博主表现数据中...' : '请在左侧选择一位博主查看历史作品、常态基线与异常爆款分布。'}
            </div>
          ) : (
            <>
              <div className="panel-card">
                <div className="panel-head">
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <strong style={{ fontSize: 17 }}>{analytics.creator.name}</strong>
                      <span className="metric-chip">{PLATFORM_LABELS[analytics.creator.platform] || analytics.creator.platform}</span>
                      <a href={analytics.creator.url} target="_blank" rel="noreferrer" style={{ color: 'var(--primary)', fontSize: 12 }}>
                        打开主页 <ExternalLink size={12} />
                      </a>
                    </div>
                    {analytics.creator.bio && (
                      <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 4 }}>{analytics.creator.bio}</div>
                    )}
                  </div>
                  <button
                    className="btn btn-primary"
                    style={{ fontSize: 12.5 }}
                    onClick={() => handleRunSource(analytics.creator.id, analytics.creator.name)}
                  >
                    <RefreshCw size={13} /> 立即更新作品
                  </button>
                </div>

                {/* 博主历史基线 KPI */}
                <div className="kpi-strip" style={{ marginBottom: 12 }}>
                  <div className="kpi-tile" style={{ boxShadow: 'none', background: 'var(--surface-muted)' }}>
                    <div className="kpi-tile-label">粉丝/订阅数</div>
                    <div className="kpi-tile-val" style={{ fontSize: 20 }}>
                      {fmtNum(analytics.creator.follower_count)}
                    </div>
                  </div>
                  <div className="kpi-tile" style={{ boxShadow: 'none', background: 'var(--surface-muted)' }}>
                    <div className="kpi-tile-label">播放中位数基线</div>
                    <div className="kpi-tile-val" style={{ fontSize: 20 }}>
                      {fmtNum(analytics.creator.baseline_views)}
                    </div>
                  </div>
                  <div className="kpi-tile" style={{ boxShadow: 'none', background: 'var(--surface-muted)' }}>
                    <div className="kpi-tile-label">点赞中位数基线</div>
                    <div className="kpi-tile-val" style={{ fontSize: 20 }}>
                      {fmtNum(analytics.creator.baseline_likes)}
                    </div>
                  </div>
                  <div className="kpi-tile" style={{ boxShadow: 'none', background: 'var(--surface-muted)' }}>
                    <div className="kpi-tile-label">基线样本数</div>
                    <div className="kpi-tile-val" style={{ fontSize: 20 }}>
                      {analytics.creator.baseline_sample_size} 条
                    </div>
                    <div className="kpi-tile-sub">{analytics.creator.baseline_sample_size >= 3 ? '基线已生效' : '满 3 条自动建基线'}</div>
                  </div>
                </div>

                {/* 常见选题方向标签 */}
                {analytics.topDirections.length > 0 && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>常见选题方向：</span>
                    {analytics.topDirections.map((d) => (
                      <span key={d.name} className="metric-chip">
                        {d.name} ({d.count})
                      </span>
                    ))}
                  </div>
                )}

                {/* 近期作品表现柱状图（异常爆款橙红高亮） */}
                {analytics.chartData.length > 0 && (
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <BarChart3 size={15} color="#4f46e5" />
                      <span>近期作品互动表现（橙色柱体 = 相对自身基线的异常爆款）</span>
                    </div>
                    <div style={{ width: '100%', height: 195 }}>
                      <ResponsiveContainer>
                        <BarChart data={analytics.chartData} margin={{ top: 6, right: 12, left: 6, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                          <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#64748b' }} />
                          <YAxis
                            width={58}
                            tickFormatter={(v) => fmtNum(Number(v), '0')}
                            tick={{ fontSize: 11, fill: '#64748b' }}
                          />
                          <Tooltip formatter={(val) => fmtNum(Number(val), '0')} />
                          <Bar dataKey={analytics.chartData.some((x) => x.views > 0) ? 'views' : 'likes'} name={analytics.chartData.some((x) => x.views > 0) ? '播放量' : '点赞数'} radius={[4, 4, 0, 0]}>
                            {analytics.chartData.map((entry) => (
                              <Cell key={entry.id} fill={entry.isBreakout ? '#ea580c' : '#6366f1'} />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                )}
              </div>

              {/* 作品明细表 */}
              <div className="panel-card">
                <div className="panel-head">
                  <div className="panel-title">历史作品与异常热度 ({analytics.works.length})</div>
                </div>
                {analytics.works.length === 0 ? (
                  <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>暂无已采集作品，点击上方「立即更新作品」开始抓取。</div>
                ) : (
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>作品标题</th>
                        <th style={{ width: 170 }}>真实互动数据</th>
                        <th style={{ width: 120 }}>异常热度</th>
                        <th style={{ width: 95 }}>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {analytics.works.map((w) => (
                        <tr key={w.id}>
                          <td>
                            <div style={{ fontWeight: 600, cursor: 'pointer' }} onClick={() => onOpenIntelDetail(w.id)}>
                              {w.title}
                            </div>
                            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 3 }}>
                              {fmtTime(w.published_at || w.discovered_at)}
                              {w.ai_category ? ` · ${w.ai_category}` : ''}
                              {w.transcript_status === 'done' ? ' · 已有听悟口播稿' : ''}
                              {w.comment_rows > 0 ? ` · ${w.comment_rows}条评论` : ''}
                            </div>
                          </td>
                          <td>
                            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                              <span className="metric-chip">播 {fmtNum(w.latest_views)}</span>
                              <span className="metric-chip">赞 {fmtNum(w.latest_likes)}</span>
                              <span className="metric-chip">评 {fmtNum(w.latest_comments)}</span>
                              <span className="metric-chip">藏 {fmtNum(w.latest_favorites)}</span>
                            </div>
                          </td>
                          <td>
                            {w.breakout_ratio != null ? (
                              <span className={w.breakout_ratio >= 1.6 ? 'breakout-badge' : 'metric-chip'}>
                                {w.breakout_ratio >= 1.6 ? '🔥 ' : ''}
                                {w.breakout_ratio}x
                              </span>
                            ) : (
                              <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>基线不足</span>
                            )}
                          </td>
                          <td>
                            <button
                              className="btn btn-secondary"
                              style={{ padding: '4px 8px', fontSize: 11.5 }}
                              onClick={() => onOpenIntelDetail(w.id)}
                            >
                              <Sparkles size={12} /> 详析
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
