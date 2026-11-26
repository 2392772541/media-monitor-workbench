import { useEffect, useState } from 'react';
import {
  Flame,
  RefreshCw,
  ExternalLink,
  Search,
  Star,
  Mic,
  MessageSquareText,
  BarChart3,
} from 'lucide-react';
import { apiRequest, fmtTime, PLATFORM_LABELS } from '../api';
import type { DrawerTab } from '../components/ContentDrawer';
import type { HotBoardItem } from '../types';

interface HotBoardPageProps {
  refreshTick: number;
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
};

export function HotBoardPage({
  refreshTick,
  onOpenHotItem,
  onRefreshBadge,
  onToast,
}: HotBoardPageProps) {
  const [items, setItems] = useState<HotBoardItem[]>([]);
  const [categories, setCategories] = useState<Array<{ name: string; count: number }>>([]);
  const [platform, setPlatform] = useState('');
  const [category, setCategory] = useState('');
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    try {
      const qs = new URLSearchParams();
      if (platform) qs.set('platform', platform);
      if (category) qs.set('category', category);
      if (query.trim()) qs.set('q', query.trim());
      const res = await apiRequest<{
        items: HotBoardItem[];
        categories?: Array<{ name: string; count: number }>;
      }>(`/api/radar/hot-board?${qs.toString()}`);
      setItems(res.items);
      if (res.categories) setCategories(res.categories);
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  useEffect(() => {
    void load();
  }, [platform, category, refreshTick]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const res = await apiRequest<{
        totalSaved: number;
        results: Array<{ board: string; count: number; error?: string }>;
      }>('/api/radar/hot-board/refresh', {
        method: 'POST',
        body: JSON.stringify({ platforms: ['bilibili', 'douyin'], scoreWithAi: false }),
      });
      const summary = res.results.map((r) => `${r.board}:${r.count}${r.error ? `(${r.error})` : ''}`).join('；');
      onToast(`热榜已更新：${summary}`);
      await load();
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setRefreshing(false);
    }
  };

  const handleToggleStar = async (item: HotBoardItem, ev: React.MouseEvent) => {
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

  // 按各自平台最大值归一化热度条长度（不同平台量纲不同，展示原始真实 hot_label）
  const maxByPlat = new Map<string, number>();
  for (const it of items) {
    const cur = maxByPlat.get(it.platform) || 0;
    if ((it.hot_value || 0) > cur) maxByPlat.set(it.platform, it.hot_value || 0);
  }
  const topBars = items.slice(0, 8);

  return (
    <div>
      {/* 顶部清爽平台 + 分类筛选栏 */}
      <div className="panel-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div className="pill-group">
            {[
              { k: '', l: '全部热榜' },
              { k: 'douyin', l: '抖音实时热榜' },
              { k: 'bilibili', l: 'B站全站热门' },
            ].map((t) => (
              <button
                key={t.k}
                className={`pill-btn ${platform === t.k ? 'active' : ''}`}
                onClick={() => {
                  setPlatform(t.k);
                  setCategory('');
                }}
              >
                {t.l}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: 5 }}>
              <input
                className="input"
                style={{ width: 185 }}
                placeholder="搜热榜关键词..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void load()}
              />
              <button className="btn btn-secondary btn-sm" onClick={() => void load()}>
                <Search size={13} />
              </button>
            </div>
            <button className="btn btn-primary btn-sm" disabled={refreshing} onClick={handleRefresh}>
              <RefreshCw size={13} /> {refreshing ? '刷新中...' : '立即刷新热榜'}
            </button>
          </div>
        </div>

        {/* 动态真实分类胶囊 */}
        {categories.length > 1 && (
          <div className="pill-group" style={{ paddingTop: 8, borderTop: '1px solid var(--border)' }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>分类：</span>
            <button
              className={`pill-btn ${category === '' ? 'active' : ''}`}
              onClick={() => setCategory('')}
            >
              全部
            </button>
            {categories.slice(0, 12).map((c) => (
              <button
                key={c.name}
                className={`pill-btn ${category === c.name ? 'active' : ''}`}
                onClick={() => setCategory(c.name)}
              >
                {c.name} ({c.count})
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 热度 TOP 8 横向柱状对比图 */}
      {topBars.length > 0 && (
        <div className="panel-card">
          <div className="panel-head">
            <div className="panel-title">
              <BarChart3 size={16} color="#4f46e5" />
              <span>当前热榜 · 热度 TOP {topBars.length} 对比</span>
            </div>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>点任意一条右侧滑出「看点 / 口播稿 / 热评」</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {topBars.map((h, i) => {
              const pColor = PLATFORM_COLORS[h.platform] || '#4f46e5';
              const maxV = maxByPlat.get(h.platform) || 1;
              const pct = h.hot_value ? Math.min(100, Math.max(12, Math.round((h.hot_value / maxV) * 100))) : Math.max(25, 100 - i * 10);
              return (
                <div
                  key={h.id}
                  style={{ cursor: 'pointer' }}
                  onClick={() => void onOpenHotItem(h, 'point')}
                >
                  <div className="feed-row-head" style={{ fontSize: 12.5 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0, flex: 1 }}>
                      <span style={{ fontWeight: 700, width: 22, color: i < 3 ? '#dc2626' : 'var(--text-muted)', flexShrink: 0 }}>
                        #{h.rank_no || i + 1}
                      </span>
                      <span className="plat-badge" style={{ background: pColor }}>
                        {PLATFORM_LABELS[h.platform] || h.platform}
                      </span>
                      <span className="feed-row-title" style={{ fontSize: 13 }}>
                        {h.title}
                      </span>
                    </div>
                    <span style={{ fontWeight: 700, color: pColor, flexShrink: 0 }}>{h.hot_label || '热榜'}</span>
                  </div>
                  <div className="heat-track" style={{ height: 6 }}>
                    <div className="heat-fill" style={{ width: `${pct}%`, background: pColor }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 完整清爽榜单列表 */}
      <div className="panel-card" style={{ marginBottom: 0 }}>
        <div className="panel-head">
          <div className="panel-title">
            <Flame size={17} color="#ea580c" />
            <span>热榜明细（共 {items.length} 条）</span>
          </div>
        </div>

        {items.length === 0 ? (
          <div style={{ padding: 36, textAlign: 'center', color: 'var(--text-muted)' }}>
            暂无热榜数据，点击右上角「立即刷新热榜」拉取抖音实时热榜与 B 站全站热门。
          </div>
        ) : (
          <div className="feed-list">
            {items.map((h, idx) => {
              const pColor = PLATFORM_COLORS[h.platform] || '#4f46e5';
              return (
                <div key={h.id} className="feed-row" onClick={() => void onOpenHotItem(h, 'point')}>
                  <div className="feed-row-head">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
                      <span className={`rank-box ${idx < 3 ? 'top' : ''}`}>{h.rank_no || idx + 1}</span>
                      <span className="plat-badge" style={{ background: pColor }}>
                        {PLATFORM_LABELS[h.platform] || h.platform}
                      </span>
                      <span className="feed-row-title">{h.title}</span>
                    </div>
                    <span style={{ fontSize: 12, fontWeight: 700, color: pColor, flexShrink: 0 }}>
                      {h.hot_label || '热门'}
                    </span>
                  </div>

                  {(h.ai_summary || h.summary) && (
                    <div className="feed-row-brief">💡 {h.ai_summary || h.summary}</div>
                  )}

                  <div className="feed-row-meta">
                    <span>
                      {h.board_name} · {h.category || '综合'}
                      {h.author ? ` · ${h.author}` : ''} · {fmtTime(h.captured_at)}
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
                        onClick={(e) => void handleToggleStar(h, e)}
                      >
                        <Star size={11} fill={h.saved_board_id ? 'currentColor' : 'none'} />
                        {h.saved_board_id ? '已藏' : '收藏'}
                      </button>
                      <a
                        href={h.url}
                        target="_blank"
                        rel="noreferrer"
                        className="mini-action"
                        style={{ textDecoration: 'none' }}
                      >
                        <ExternalLink size={11} /> 原链
                      </a>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
