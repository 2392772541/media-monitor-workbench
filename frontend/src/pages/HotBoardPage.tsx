import { useEffect, useState } from 'react';
import { Flame, RefreshCw, Sparkles, BookmarkPlus, ArrowDownToLine, ExternalLink, Search } from 'lucide-react';
import { apiRequest, CONTENT_TYPE_LABELS, fmtTime, PLATFORM_LABELS } from '../api';
import type { HotBoardItem } from '../types';

interface HotBoardPageProps {
  activeAccountId: number;
  onToast: (msg: string) => void;
  onOpenIntelDetail: (contentId: number) => void;
}

export function HotBoardPage({ activeAccountId, onToast, onOpenIntelDetail }: HotBoardPageProps) {
  const [items, setItems] = useState<HotBoardItem[]>([]);
  const [platform, setPlatform] = useState('');
  const [contentType, setContentType] = useState('');
  const [onlyRelevant, setOnlyRelevant] = useState(false);
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [scoring, setScoring] = useState(false);

  const load = async () => {
    try {
      const qs = new URLSearchParams();
      if (platform) qs.set('platform', platform);
      if (contentType) qs.set('contentType', contentType);
      if (onlyRelevant) qs.set('minRelevance', '55');
      if (query.trim()) qs.set('q', query.trim());
      const res = await apiRequest<{ items: HotBoardItem[] }>(`/api/radar/hot-board?${qs.toString()}`);
      setItems(res.items);
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  useEffect(() => {
    void load();
  }, [platform, contentType, onlyRelevant]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const res = await apiRequest<{
        totalSaved: number;
        results: Array<{ board: string; count: number; error?: string }>;
      }>('/api/radar/hot-board/refresh', {
        method: 'POST',
        body: JSON.stringify({ platforms: ['bilibili', 'douyin', 'industry'], scoreWithAi: false }),
      });
      const summary = res.results.map((r) => `${r.board}:${r.count}${r.error ? `(${r.error})` : ''}`).join('；');
      onToast(`热榜已更新（共 ${res.totalSaved} 条）：${summary}`);
      await load();
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setRefreshing(false);
    }
  };

  const handleAiScore = async () => {
    setScoring(true);
    try {
      const res = await apiRequest<{ scored: number }>('/api/radar/hot-board/score', {
        method: 'POST',
        body: JSON.stringify({ accountId: activeAccountId }),
      });
      onToast(`已按当前账号定位完成 ${res.scored} 条热榜的垂直相关性评估，高价值热点已自动置顶`);
      await load();
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setScoring(false);
    }
  };

  const handleImportIntel = async (item: HotBoardItem) => {
    try {
      const res = await apiRequest<{ contentId: number }>(`/api/radar/hot-board/${item.id}/import`, { method: 'POST' });
      onToast('已导入「内容情报库」，正在打开详情面板');
      await load();
      onOpenIntelDetail(res.contentId);
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  const handleAddToBoard = async (item: HotBoardItem) => {
    try {
      const res = await apiRequest<{ duplicates: Array<{ title: string; similarity: number }> }>('/api/radar/board', {
        method: 'POST',
        body: JSON.stringify({
          title: item.title,
          account_id: activeAccountId,
          source_content_id: item.content_id,
          core_angle: item.account_relevance_reason || item.summary || `来自${item.board_name}（${item.hot_label}）`,
          tags: [item.board_name, item.category].filter(Boolean),
          priority: (item.account_relevance_score || 0) >= 75 ? 'high' : 'medium',
          source_url: item.url,
        }),
      });
      onToast(
        res.duplicates.length > 0
          ? `已加入选题库（提示：与「${res.duplicates[0].title}」相似 ${res.duplicates[0].similarity}%）`
          : '已加入「个人选题库」'
      );
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  return (
    <div>
      <div className="panel-card" style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <div className="sub-tabs">
            {[
              { k: '', l: '全部热榜' },
              { k: 'bilibili', l: 'B站热门' },
              { k: 'douyin', l: '抖音热榜' },
              { k: 'youtube', l: 'YouTube' },
              { k: 'rss', l: '行业资讯' },
            ].map((t) => (
              <button key={t.k} className={`sub-tab-btn ${platform === t.k ? 'active' : ''}`} onClick={() => setPlatform(t.k)}>
                {t.l}
              </button>
            ))}
          </div>
          <select className="input" style={{ width: 120 }} value={contentType} onChange={(e) => setContentType(e.target.value)}>
            <option value="">全部形态</option>
            <option value="video">视频</option>
            <option value="hot_topic">热榜话题</option>
            <option value="article">文章</option>
          </select>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, cursor: 'pointer' }}>
            <input type="checkbox" checked={onlyRelevant} onChange={(e) => setOnlyRelevant(e.target.checked)} />
            仅看垂直高相关（≥55分）
          </label>
          <div style={{ display: 'flex', gap: 5 }}>
            <input
              className="input"
              style={{ width: 170 }}
              placeholder="搜热点词..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void load()}
            />
            <button className="btn btn-secondary" onClick={() => void load()}>
              <Search size={14} />
            </button>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary" disabled={refreshing} onClick={handleRefresh}>
            <RefreshCw size={14} /> {refreshing ? '拉取中...' : '抓取最新热榜'}
          </button>
          <button className="btn btn-primary" disabled={scoring} onClick={handleAiScore}>
            <Sparkles size={14} /> {scoring ? 'AI 筛选中...' : 'AI 筛选垂直热点'}
          </button>
        </div>
      </div>

      <div className="panel-card">
        <div className="panel-head">
          <div className="panel-title">
            <Flame size={17} color="#ea580c" />
            <span>行业热点榜单（共 {items.length} 条）</span>
          </div>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            不只搬运全网热搜：点「AI 筛选垂直热点」自动按你当前账号定位把有创作价值的内容排到最前面
          </span>
        </div>

        {items.length === 0 ? (
          <div style={{ padding: 36, textAlign: 'center', color: 'var(--text-muted)' }}>
            还没有热榜数据，点击右上角「抓取最新热榜」立即拉取 B 站热门与抖音实时热榜。
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: 52 }}>排名</th>
                <th>热点标题与摘要</th>
                <th style={{ width: 145 }}>平台与真实热度</th>
                <th style={{ width: 220 }}>账号垂直相关性（AI 评估）</th>
                <th style={{ width: 155 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const rel = item.account_relevance_score;
                const relCls = rel == null ? 'score-low' : rel >= 70 ? 'score-high' : rel >= 50 ? 'score-mid' : 'score-low';
                return (
                  <tr key={item.id}>
                    <td>
                      <strong style={{ color: item.rank_no <= 3 ? '#ea580c' : 'var(--text-muted)' }}>#{item.rank_no}</strong>
                    </td>
                    <td>
                      <div style={{ fontWeight: 600, fontSize: 14 }}>{item.title}</div>
                      {item.summary && (
                        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>{item.summary.slice(0, 120)}</div>
                      )}
                      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>
                        {item.board_name} · {item.category || '综合'} · {CONTENT_TYPE_LABELS[item.content_type] || item.content_type}
                        {item.author ? ` · ${item.author}` : ''} · 抓取于 {fmtTime(item.captured_at)}
                      </div>
                    </td>
                    <td>
                      <div className="metric-chip" style={{ marginBottom: 4 }}>
                        {PLATFORM_LABELS[item.platform] || item.platform}
                      </div>
                      <div style={{ fontSize: 12, fontWeight: 600, color: '#ea580c' }}>{item.hot_label || '—'}</div>
                    </td>
                    <td>
                      {rel != null ? (
                        <div>
                          <span className={`score-pill ${relCls}`} style={{ fontSize: 12, padding: '2px 8px' }}>
                            相关度 {rel}
                          </span>
                          <div style={{ fontSize: 12, color: '#334155', marginTop: 4 }}>{item.account_relevance_reason}</div>
                        </div>
                      ) : (
                        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>未评估（点右上角 AI 筛选）</span>
                      )}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                        <button
                          className="btn btn-primary"
                          style={{ padding: '4px 8px', fontSize: 11.5 }}
                          onClick={() => handleAddToBoard(item)}
                        >
                          <BookmarkPlus size={12} /> 选题
                        </button>
                        <button
                          className="btn btn-secondary"
                          style={{ padding: '4px 8px', fontSize: 11.5 }}
                          onClick={() => handleImportIntel(item)}
                        >
                          <ArrowDownToLine size={12} /> 详析
                        </button>
                        <a
                          href={item.url}
                          target="_blank"
                          rel="noreferrer"
                          className="btn btn-secondary"
                          style={{ padding: '4px 7px', fontSize: 11.5, textDecoration: 'none' }}
                        >
                          <ExternalLink size={12} />
                        </a>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
