import { useEffect, useState } from 'react';
import { RefreshCw, Search, Star, LayoutGrid } from 'lucide-react';
import { apiRequest, PLATFORM_LABELS } from '../api';
import type { DrawerTab } from '../components/ContentDrawer';
import { VideoCard } from '../components/VideoCard';
import type { HotBoardItem } from '../types';

interface HotBoardPageProps {
  refreshTick: number;
  onOpenHotItem: (item: HotBoardItem, tab?: DrawerTab) => void;
  onRefreshBadge: () => void;
  onToast: (msg: string) => void;
}

const TREEMAP_COLORS = ['#4f46e5', '#0284c7', '#e11d48', '#ea580c', '#0d9488', '#7c3aed', '#16a34a', '#ca8a04'];

export function HotBoardPage({
  refreshTick,
  onOpenHotItem,
  onRefreshBadge,
  onToast,
}: HotBoardPageProps) {
  const [items, setItems] = useState<HotBoardItem[]>([]);
  const [viewMode, setViewMode] = useState<'dual' | 'douyin' | 'bilibili'>('dual');
  const [selectedCat, setSelectedCat] = useState('');
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    try {
      const qs = new URLSearchParams();
      if (query.trim()) qs.set('q', query.trim());
      const res = await apiRequest<{ items: HotBoardItem[] }>(`/api/radar/hot-board?${qs.toString()}`);
      setItems(res.items);
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  useEffect(() => {
    void load();
  }, [refreshTick]);

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
      const summary = res.results.map((r) => `${r.board} ${r.count}条`).join(' · ');
      onToast(`热榜已更新为最新一期：${summary}`);
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

  const douyinAll = items.filter((x) => x.platform === 'douyin').sort((a, b) => a.rank_no - b.rank_no);
  const bilibiliAll = items.filter((x) => x.platform === 'bilibili').sort((a, b) => a.rank_no - b.rank_no);

  // 统计 B 站最新一期真实分区赛道，供顶部色块图直接可视化筛选
  const catCountMap = new Map<string, number>();
  for (const b of bilibiliAll) {
    const key = (b.category || '综合').trim() || '综合';
    catCountMap.set(key, (catCountMap.get(key) || 0) + 1);
  }
  const catBlocks = Array.from(catCountMap.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
  const catTotal = bilibiliAll.length || 1;

  const shownBilibili = selectedCat
    ? bilibiliAll.filter((b) => ((b.category || '综合').trim() || '综合') === selectedCat)
    : bilibiliAll;

  const renderDouyinRow = (h: HotBoardItem, idx: number) => {
    const rank = h.rank_no || idx + 1;
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
            onClick={(e) => void handleToggleStar(h, e)}
            title={h.saved_board_id ? '取消收藏' : '收藏'}
          >
            <Star size={11} fill={h.saved_board_id ? 'currentColor' : 'none'} />
          </button>
        </div>
      </div>
    );
  };

  return (
    <div>
      {/* 顶部清爽视图切换与刷新栏 */}
      <div className="panel-card" style={{ padding: '13px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div className="pill-group">
          {[
            { k: 'dual' as const, l: `双榜对照（抖音 ${douyinAll.length} · B站 ${bilibiliAll.length}）` },
            { k: 'douyin' as const, l: `只看抖音热搜 (${douyinAll.length})` },
            { k: 'bilibili' as const, l: `只看B站视频墙 (${bilibiliAll.length})` },
          ].map((t) => (
            <button
              key={t.k}
              className={`pill-btn ${viewMode === t.k ? 'active' : ''}`}
              onClick={() => setViewMode(t.k)}
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
              placeholder="搜热点词..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void load()}
            />
            <button className="btn btn-secondary btn-sm" onClick={() => void load()}>
              <Search size={13} />
            </button>
          </div>
          <button className="btn btn-primary btn-sm" disabled={refreshing} onClick={handleRefresh}>
            <RefreshCw size={13} /> {refreshing ? '刷新中...' : '刷新最新热榜'}
          </button>
        </div>
      </div>

      {/* 赛道色块图（色块大小 = 当期上榜数量占比，点色块直接筛选 B 站热门视频墙） */}
      {viewMode !== 'douyin' && catBlocks.length > 0 && (
        <div className="panel-card">
          <div className="panel-head" style={{ marginBottom: 10 }}>
            <div className="panel-title">
              <LayoutGrid size={16} color="#4f46e5" />
              <span>今日 B 站热门赛道色块（点色块筛选视频墙）</span>
            </div>
            {selectedCat ? (
              <button className="btn btn-secondary btn-sm" onClick={() => setSelectedCat('')}>
                清除筛选（当前：{selectedCat}）
              </button>
            ) : (
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>色块越大代表今天这个分区上榜越多</span>
            )}
          </div>

          <div className="treemap-strip">
            {catBlocks.map((c, idx) => {
              const pct = Math.round((c.count / catTotal) * 100);
              const isSelected = selectedCat === c.name;
              const isDim = Boolean(selectedCat) && !isSelected;
              return (
                <button
                  key={c.name}
                  type="button"
                  className={`treemap-block ${isSelected ? 'active' : ''} ${isDim ? 'dimmed' : ''}`}
                  style={{
                    flexGrow: Math.max(c.count, 1),
                    flexBasis: `${Math.max(10, pct)}%`,
                    background: TREEMAP_COLORS[idx % TREEMAP_COLORS.length],
                  }}
                  onClick={() => setSelectedCat(isSelected ? '' : c.name)}
                >
                  <span className="treemap-name">{c.name}</span>
                  <span className="treemap-stat">
                    {c.count} 条 · {pct}%
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* 主榜单区：抖音极简热搜榜 + B 站高清封面视频墙 */}
      {items.length === 0 ? (
        <div className="panel-card" style={{ padding: 48, textAlign: 'center', color: 'var(--text-muted)' }}>
          还没有热榜数据，点击右上角「刷新最新热榜」拉取抖音热搜与 B 站全站热门。
        </div>
      ) : viewMode === 'douyin' ? (
        <div className="panel-card" style={{ marginBottom: 0 }}>
          <div className="panel-head">
            <div className="panel-title">
              <span className="plat-dot" style={{ background: '#e11d48', width: 10, height: 10 }} />
              <span>抖音实时热搜榜（最新一期 · 共 {douyinAll.length} 条）</span>
            </div>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>点任意词条右侧滑出「一句话看点 / 口播稿 / 热评」</span>
          </div>
          <div className="douyin-2col">
            <div className="hotsearch-list">{douyinAll.slice(0, Math.ceil(douyinAll.length / 2)).map(renderDouyinRow)}</div>
            <div className="hotsearch-list">
              {douyinAll.slice(Math.ceil(douyinAll.length / 2)).map((h, i) => renderDouyinRow(h, i + Math.ceil(douyinAll.length / 2)))}
            </div>
          </div>
        </div>
      ) : viewMode === 'bilibili' ? (
        <div className="panel-card" style={{ marginBottom: 0 }}>
          <div className="panel-head">
            <div className="panel-title">
              <span className="plat-dot" style={{ background: '#4f46e5', width: 10, height: 10 }} />
              <span>B站全站热门视频墙{selectedCat ? ` · ${selectedCat}` : ''}（共 {shownBilibili.length} 条）</span>
            </div>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>点任意封面滑出「看点 / 口播稿 / 热评」</span>
          </div>
          <div className="vcard-grid-4">
            {shownBilibili.map((h, i) => {
              const rank = h.rank_no || i + 1;
              const parts = h.hot_label.split('·').map((s) => s.trim());
              return (
                <VideoCard
                  key={h.id}
                  title={h.title}
                  coverUrl={h.cover_url}
                  author={h.author || 'B站UP主'}
                  subLabel={h.category || '热门'}
                  badgeText={`#${rank}`}
                  badgeTone={rank <= 3 ? 'top' : 'rank'}
                  playLabel={parts[0]?.replace('播放', '').trim() || undefined}
                  rightMetricLabel={parts[1] ? `👍 ${parts[1].replace('赞', '')}` : undefined}
                  starred={Boolean(h.saved_board_id)}
                  onClick={() => void onOpenHotItem(h, 'point')}
                  onToggleStar={(e) => void handleToggleStar(h, e)}
                />
              );
            })}
          </div>
        </div>
      ) : (
        <div className="hotboard-dual-grid">
          {/* 左 4 列：抖音极简热搜榜 */}
          <div className="panel-card" style={{ marginBottom: 0 }}>
            <div className="panel-head">
              <div className="panel-title">
                <span className="plat-dot" style={{ background: '#e11d48', width: 10, height: 10 }} />
                <span>抖音热搜 ({douyinAll.length})</span>
              </div>
              <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>1行1条</span>
            </div>
            <div className="hotsearch-list">{douyinAll.map(renderDouyinRow)}</div>
          </div>

          {/* 右 8 列：B 站高清封面视频墙 */}
          <div className="panel-card" style={{ marginBottom: 0 }}>
            <div className="panel-head">
              <div className="panel-title">
                <span className="plat-dot" style={{ background: '#4f46e5', width: 10, height: 10 }} />
                <span>B站热门视频墙{selectedCat ? ` · ${selectedCat}` : ''} ({shownBilibili.length})</span>
              </div>
              <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>点封面出看点/口播稿/热评</span>
            </div>
            <div className="vcard-grid-3">
              {shownBilibili.map((h, i) => {
                const rank = h.rank_no || i + 1;
                const parts = h.hot_label.split('·').map((s) => s.trim());
                return (
                  <VideoCard
                    key={h.id}
                    title={h.title}
                    coverUrl={h.cover_url}
                    author={h.author || 'B站UP主'}
                    subLabel={h.category || '热门'}
                    badgeText={`#${rank}`}
                    badgeTone={rank <= 3 ? 'top' : 'rank'}
                    playLabel={parts[0]?.replace('播放', '').trim() || undefined}
                    rightMetricLabel={parts[1] ? `👍 ${parts[1].replace('赞', '')}` : undefined}
                    starred={Boolean(h.saved_board_id)}
                    onClick={() => void onOpenHotItem(h, 'point')}
                    onToggleStar={(e) => void handleToggleStar(h, e)}
                  />
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
