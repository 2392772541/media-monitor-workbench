import { useEffect, useMemo, useState } from 'react';
import { RefreshCw, Search, Star, Plus, Settings2, Trash2, ExternalLink, Filter } from 'lucide-react';
import { apiRequest, PLATFORM_LABELS } from '../api';
import type { DrawerTab } from '../components/ContentDrawer';
import { VideoCard } from '../components/VideoCard';
import type { BoardSourceConfig, HotBoardItem } from '../types';

interface HotBoardPageProps {
  refreshTick: number;
  onOpenHotItem: (item: HotBoardItem, tab?: DrawerTab) => void;
  onRefreshBadge: () => void;
  onToast: (msg: string) => void;
}

interface HotBoardApiResp {
  items: HotBoardItem[];
  boards: BoardSourceConfig[];
  focusKeywords: string[];
  blockKeywords: string[];
  totalCount: number;
  matchedCount: number;
}

export function HotBoardPage({
  refreshTick,
  onOpenHotItem,
  onRefreshBadge,
  onToast,
}: HotBoardPageProps) {
  const [items, setItems] = useState<HotBoardItem[]>([]);
  const [boards, setBoards] = useState<BoardSourceConfig[]>([]);
  const [focusKeywords, setFocusKeywords] = useState<string[]>([]);
  const [blockKeywords, setBlockKeywords] = useState<string[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [matchedCount, setMatchedCount] = useState(0);

  // 默认只看命中关注词或精准垂直榜，告别满屏无关娱乐八卦
  const [focusOnly, setFocusOnly] = useState(false);
  const [selectedBoardName, setSelectedBoardName] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  // 自定义管理抽屉（加关注词、加屏蔽词、勾选/自建榜单）
  const [showManage, setShowManage] = useState(false);
  const [newFocusKw, setNewFocusKw] = useState('');
  const [newBlockKw, setNewBlockKw] = useState('');
  const [newBoardName, setNewBoardName] = useState('');
  const [newBoardUrl, setNewBoardUrl] = useState('');
  const [newBoardCat, setNewBoardCat] = useState('');
  const [addingBoard, setAddingBoard] = useState(false);

  const load = async (autoFetchIfEmpty = false) => {
    try {
      const qs = new URLSearchParams();
      if (query.trim()) qs.set('q', query.trim());
      if (focusOnly) qs.set('focusOnly', 'true');
      const res = await apiRequest<HotBoardApiResp>(`/api/radar/hot-board?${qs.toString()}`);
      setItems(res.items || []);
      setBoards(res.boards || []);
      setFocusKeywords(res.focusKeywords || []);
      setBlockKeywords(res.blockKeywords || []);
      setTotalCount(res.totalCount || 0);
      setMatchedCount(res.matchedCount || 0);

      // 如果新开启的精准榜（B站科技/知识/GitHub/ProductHunt）还没拉过，首次打开自动拉一轮
      if (autoFetchIfEmpty && (res.totalCount || 0) < 10) {
        setRefreshing(true);
        try {
          await apiRequest('/api/radar/hot-board/refresh', {
            method: 'POST',
            body: JSON.stringify({}),
          });
          const after = await apiRequest<HotBoardApiResp>(`/api/radar/hot-board?${qs.toString()}`);
          setItems(after.items || []);
          setBoards(after.boards || []);
          setTotalCount(after.totalCount || 0);
          setMatchedCount(after.matchedCount || 0);
        } finally {
          setRefreshing(false);
        }
      }
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  useEffect(() => {
    void load(true);
  }, [refreshTick, focusOnly]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const res = await apiRequest<{
        totalSaved: number;
        results: Array<{ board: string; count: number; error?: string }>;
      }>('/api/radar/hot-board/refresh', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      const summary = res.results
        .filter((r) => r.count > 0)
        .map((r) => `${r.board} ${r.count}条`)
        .join(' · ');
      onToast(`专属榜单已更新：${summary || `共 ${res.totalSaved} 条`}`);
      await load(false);
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setRefreshing(false);
    }
  };

  const handleSaveKeywords = async (nextFocus: string[], nextBlock: string[]) => {
    await apiRequest('/api/radar/preferences/keywords', {
      method: 'PUT',
      body: JSON.stringify({ focusKeywords: nextFocus, blockKeywords: nextBlock }),
    });
    await load(false);
  };

  const handleAddFocusKw = async () => {
    const k = newFocusKw.trim();
    if (!k) return;
    await handleSaveKeywords(Array.from(new Set([...focusKeywords, k])), blockKeywords);
    setNewFocusKw('');
    onToast(`已添加关注词「${k}」`);
  };

  const handleAddBlockKw = async () => {
    const k = newBlockKw.trim();
    if (!k) return;
    await handleSaveKeywords(focusKeywords, Array.from(new Set([...blockKeywords, k])));
    setNewBlockKw('');
    onToast(`已屏蔽关键词「${k}」`);
  };

  const handleToggleBoard = async (id: string, enabled: boolean) => {
    await apiRequest('/api/radar/hot-board/boards/toggle', {
      method: 'POST',
      body: JSON.stringify({ id, enabled }),
    });
    onToast(enabled ? '已启用该榜单，正在同步最新内容...' : '已隐藏该榜单');
    if (enabled) {
      await apiRequest('/api/radar/hot-board/refresh', {
        method: 'POST',
        body: JSON.stringify({ platforms: [id] }),
      }).catch(() => {});
    }
    await load(false);
  };

  const handleAddCustomBoard = async () => {
    if (!newBoardUrl.trim()) {
      onToast('请填写想关注的榜单或网站 RSS 网址');
      return;
    }
    setAddingBoard(true);
    try {
      const res = await apiRequest<{ ok: boolean; board: BoardSourceConfig }>('/api/radar/hot-board/boards', {
        method: 'POST',
        body: JSON.stringify({
          name: newBoardName.trim() || undefined,
          url: newBoardUrl.trim(),
          category: newBoardCat.trim() || '自定义榜单',
        }),
      });
      setNewBoardName('');
      setNewBoardUrl('');
      setNewBoardCat('');
      setSelectedBoardName(res.board.name);
      onToast(`已添加专属榜单「${res.board.name}」并抓取完成！`);
      await load(false);
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setAddingBoard(false);
    }
  };

  const handleDeleteCustomBoard = async (id: string) => {
    await apiRequest(`/api/radar/hot-board/boards/${id}`, { method: 'DELETE' });
    setSelectedBoardName('all');
    onToast('已删除该自定义榜单');
    await load(false);
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
            tags: [item.board_name, item.category].filter(Boolean),
            source_url: item.url,
          }),
        });
        onToast('已收藏到「简易收藏本」');
      }
      await load(false);
      onRefreshBadge();
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  const enabledBoards = useMemo(() => boards.filter((b) => b.enabled), [boards]);

  const countByBoard = useMemo(() => {
    const map = new Map<string, number>();
    for (const it of items) {
      map.set(it.board_name, (map.get(it.board_name) || 0) + 1);
    }
    return map;
  }, [items]);

  const visibleItems = useMemo(() => {
    if (selectedBoardName === 'all') return items;
    return items.filter((it) => it.board_name === selectedBoardName);
  }, [items, selectedBoardName]);

  // 区分带高清视频封面的榜单（如 B站科技/知识）与列表型工具/热搜/自定义榜单
  const videoItems = useMemo(
    () => visibleItems.filter((it) => it.platform === 'bilibili' && Boolean(it.cover_url)),
    [visibleItems]
  );
  const textBoardItems = useMemo(
    () => visibleItems.filter((it) => !(it.platform === 'bilibili' && Boolean(it.cover_url))),
    [visibleItems]
  );

  return (
    <div>
      {/* 顶部降噪过滤与专属榜单管理条 */}
      <div className="panel-card" style={{ padding: '14px 16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
          <div className="pill-group">
            <button
              type="button"
              data-testid="hotboard-mode-all"
              className={`pill-btn ${!focusOnly ? 'active' : ''}`}
              onClick={() => setFocusOnly(false)}
            >
              全部已启榜单（已自动屏蔽杂词 · {totalCount}）
            </button>
            <button
              type="button"
              data-testid="hotboard-mode-focus"
              className={`pill-btn ${focusOnly ? 'active' : ''}`}
              onClick={() => setFocusOnly(true)}
            >
              <Filter size={12} /> 只看命中我关注词 ({matchedCount})
            </button>
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: 5 }}>
              <input
                className="input"
                style={{ width: 175 }}
                placeholder="搜榜单关键词..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void load(false)}
              />
              <button type="button" className="btn btn-sm" onClick={() => void load(false)}>
                <Search size={13} />
              </button>
            </div>
            <button
              type="button"
              data-testid="hotboard-manage-btn"
              className={`btn btn-sm ${showManage ? 'btn-primary' : ''}`}
              onClick={() => setShowManage((v) => !v)}
            >
              <Settings2 size={13} /> 管理 / 添加我想看的榜单
            </button>
            <button type="button" className="btn btn-primary btn-sm" disabled={refreshing} onClick={() => void handleRefresh()}>
              <RefreshCw size={13} /> {refreshing ? '刷新中...' : '刷新已启榜单'}
            </button>
          </div>
        </div>

        {/* 我的关注词（随时增删，和今日速览同步） */}
        <div className="kw-strip">
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)' }}>关注词：</span>
          {focusKeywords.map((kw) => (
            <span key={kw} className="kw-chip">
              {kw}
              <button
                type="button"
                title="移除关注词"
                onClick={() => void handleSaveKeywords(focusKeywords.filter((x) => x !== kw), blockKeywords)}
              >
                ×
              </button>
            </span>
          ))}
          <div style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
            <input
              className="input"
              style={{ width: 124, padding: '4px 8px', fontSize: 12 }}
              placeholder="+ 加关注词"
              value={newFocusKw}
              onChange={(e) => setNewFocusKw(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void handleAddFocusKw()}
            />
            {newFocusKw.trim() && (
              <button type="button" className="btn btn-primary btn-sm" style={{ padding: '4px 8px' }} onClick={() => void handleAddFocusKw()}>
                加词
              </button>
            )}
          </div>
        </div>

        {/* 展开：管理内置榜单开关 + 添加任意自定义榜单 + 屏蔽词管理 */}
        {showManage && (
          <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)', display: 'grid', gap: 14 }}>
            {/* 1. 勾选启用的榜单 */}
            <div>
              <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 8 }}>1. 勾选你想看的榜单（取消勾选即可彻底隐藏杂榜）</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 }}>
                {boards.map((b) => (
                  <div
                    key={b.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 6,
                      padding: '8px 10px',
                      borderRadius: 9,
                      background: 'var(--surface-muted)',
                    }}
                  >
                    <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, cursor: 'pointer', minWidth: 0 }}>
                      <input
                        type="checkbox"
                        checked={b.enabled}
                        onChange={(e) => void handleToggleBoard(b.id, e.target.checked)}
                      />
                      <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {b.name}
                      </span>
                    </label>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span className="badge badge-gray" style={{ fontSize: 10.5 }}>{b.isVertical ? '精准' : '综合'}</span>
                      {!b.builtin && (
                        <button
                          type="button"
                          className="icon-ghost-btn"
                          title="删除自定义榜单"
                          onClick={() => void handleDeleteCustomBoard(b.id)}
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* 2. 添加任意自定义榜单源 */}
            <div>
              <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 8 }}>2. 添加我想关注的自定义榜单 / 网站订阅（粘贴任意 RSS 或专题地址）</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <input
                  className="input"
                  style={{ flex: '1 1 150px', maxWidth: 190 }}
                  placeholder="榜单名称（如 少数派热门）"
                  value={newBoardName}
                  onChange={(e) => setNewBoardName(e.target.value)}
                />
                <input
                  className="input"
                  style={{ flex: '2 1 260px' }}
                  placeholder="粘贴 RSS / 榜单地址（如 https://sspai.com/feed）"
                  value={newBoardUrl}
                  onChange={(e) => setNewBoardUrl(e.target.value)}
                />
                <input
                  className="input"
                  style={{ width: 120 }}
                  placeholder="分类（可选）"
                  value={newBoardCat}
                  onChange={(e) => setNewBoardCat(e.target.value)}
                />
                <button
                  type="button"
                  data-testid="hotboard-add-custom-btn"
                  className="btn btn-primary btn-sm"
                  disabled={addingBoard}
                  onClick={() => void handleAddCustomBoard()}
                >
                  <Plus size={13} /> {addingBoard ? '添加并抓取中...' : '添加到我的榜单'}
                </button>
              </div>
            </div>

            {/* 3. 屏蔽词管理 */}
            <div>
              <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 8 }}>3. 屏蔽词（包含这些词的热榜会自动隐藏）</div>
              <div className="kw-strip">
                {blockKeywords.map((kw) => (
                  <span key={kw} className="kw-chip kw-chip-block">
                    {kw}
                    <button
                      type="button"
                      title="取消屏蔽"
                      onClick={() => void handleSaveKeywords(focusKeywords, blockKeywords.filter((x) => x !== kw))}
                    >
                      ×
                    </button>
                  </span>
                ))}
                <div style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                  <input
                    className="input"
                    style={{ width: 130, padding: '4px 8px', fontSize: 12 }}
                    placeholder="+ 加屏蔽词"
                    value={newBlockKw}
                    onChange={(e) => setNewBlockKw(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && void handleAddBlockKw()}
                  />
                  {newBlockKw.trim() && (
                    <button type="button" className="btn btn-danger btn-sm" style={{ padding: '4px 8px' }} onClick={() => void handleAddBlockKw()}>
                      屏蔽
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 已启榜单快捷切换栏 */}
      <div className="tab-pill-bar">
        <button
          type="button"
          className={`tab-pill ${selectedBoardName === 'all' ? 'active' : ''}`}
          onClick={() => setSelectedBoardName('all')}
        >
          全部已启榜单 ({items.length})
        </button>
        {enabledBoards.map((b) => (
          <button
            key={b.id}
            type="button"
            className={`tab-pill ${selectedBoardName === b.name ? 'active' : ''}`}
            onClick={() => setSelectedBoardName(b.name)}
          >
            {b.name} ({countByBoard.get(b.name) || 0})
          </button>
        ))}
      </div>

      {/* 主榜单内容区 */}
      {visibleItems.length === 0 ? (
        <div className="panel-card" style={{ padding: 48, textAlign: 'center', color: 'var(--text-muted)' }}>
          {focusOnly
            ? '当前榜单里暂时没有命中你关注词的条目，可以点上方「全部已启榜单」查看，或加几个新关注词。'
            : '这个榜单还没有拉取过数据，点右上角「刷新已启榜单」即可拉取最新一期。'}
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 16 }}>
          {/* 视频封面墙板块（B站科技数码 / B站知识区等） */}
          {videoItems.length > 0 && (
            <section className="panel-card" style={{ marginBottom: 0 }}>
              <div className="panel-head">
                <div className="panel-title">
                  <span>视频精准热榜（共 {videoItems.length} 条 · 点封面看口播与二创）</span>
                </div>
              </div>
              <div className="vcard-grid-4">
                {videoItems.map((h, i) => {
                  const rank = h.rank_no || i + 1;
                  const parts = h.hot_label.split('·').map((s) => s.trim());
                  return (
                    <VideoCard
                      key={h.id}
                      title={h.title}
                      coverUrl={h.cover_url}
                      author={h.author || h.board_name}
                      subLabel={h.matched_keywords?.[0] ? `命中 ${h.matched_keywords[0]}` : h.board_name}
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
            </section>
          )}

          {/* 开源榜 / 新产品榜 / 抖音热搜 / 自定义榜单卡片区 */}
          {textBoardItems.length > 0 && (
            <section className="panel-card" style={{ marginBottom: 0 }}>
              <div className="panel-head">
                <div className="panel-title">
                  <span>工具榜 / 热词榜 / 自定义榜单（共 {textBoardItems.length} 条）</span>
                </div>
              </div>
              <div className="board-grid-cards">
                {textBoardItems.map((h, i) => {
                  const rank = h.rank_no || i + 1;
                  const rankCls = rank === 1 ? 'r1' : rank === 2 ? 'r2' : rank === 3 ? 'r3' : '';
                  return (
                    <div key={h.id} className="board-text-card" onClick={() => void onOpenHotItem(h, 'point')}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span className={`rank-num ${rankCls}`}>{rank}</span>
                          <span className="badge badge-gray" style={{ fontSize: 11 }}>{h.board_name}</span>
                        </div>
                        <span style={{ fontSize: 11.5, fontWeight: 700, color: '#e11d48' }}>{h.hot_label}</span>
                      </div>

                      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', lineHeight: 1.4 }}>{h.title}</div>

                      {h.summary && h.summary !== h.title && (
                        <div style={{ fontSize: 12.5, color: '#475569', lineHeight: 1.45 }}>
                          {h.summary.slice(0, 95)}{h.summary.length > 95 ? '...' : ''}
                        </div>
                      )}

                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, marginTop: 'auto', paddingTop: 4 }}>
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          {(h.matched_keywords || []).slice(0, 2).map((kw) => (
                            <span key={kw} className="badge badge-blue" style={{ fontSize: 10.5 }}>
                              命中 {kw}
                            </span>
                          ))}
                          {(!h.matched_keywords || h.matched_keywords.length === 0) && (
                            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                              {PLATFORM_LABELS[h.platform] || h.category}
                            </span>
                          )}
                        </div>
                        <div style={{ display: 'flex', gap: 5 }} onClick={(e) => e.stopPropagation()}>
                          <button
                            type="button"
                            className={`mini-action ${h.saved_board_id ? 'starred' : ''}`}
                            onClick={(e) => void handleToggleStar(h, e)}
                            title={h.saved_board_id ? '取消收藏' : '收藏'}
                          >
                            <Star size={11} fill={h.saved_board_id ? 'currentColor' : 'none'} />
                          </button>
                          <a
                            href={h.url}
                            target="_blank"
                            rel="noreferrer"
                            className="mini-action"
                            style={{ textDecoration: 'none' }}
                            title="打开原文"
                          >
                            <ExternalLink size={11} />
                          </a>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
