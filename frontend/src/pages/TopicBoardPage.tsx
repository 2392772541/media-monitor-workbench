import { useEffect, useState } from 'react';
import {
  Plus,
  Trash2,
  Send,
  ExternalLink,
  Check,
  Mic,
  MessageSquareText,
  Search,
  Star,
} from 'lucide-react';
import { apiRequest, fmtTime, PLATFORM_LABELS, safeJsonArray } from '../api';
import type { DrawerTab } from '../components/ContentDrawer';
import type { PublishInspirationDraft, TopicBoardItem } from '../types';

interface TopicBoardPageProps {
  refreshTick: number;
  onOpenContent: (contentId: number, tab?: DrawerTab, savedBoardId?: number | null) => void;
  onSendToPublish: (draft: PublishInspirationDraft) => void;
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

export function TopicBoardPage({
  refreshTick,
  onOpenContent,
  onSendToPublish,
  onRefreshBadge,
  onToast,
}: TopicBoardPageProps) {
  const [items, setItems] = useState<TopicBoardItem[]>([]);
  const [originFilter, setOriginFilter] = useState<'all' | 'creator' | 'hotboard' | 'manual'>('all');
  const [doneFilter, setDoneFilter] = useState<'all' | 'todo' | 'done'>('all');
  const [q, setQ] = useState('');
  const [quickTitle, setQuickTitle] = useState('');
  const [noteDrafts, setNoteDrafts] = useState<Record<number, string>>({});

  const load = async () => {
    try {
      const qs = new URLSearchParams();
      if (q.trim()) qs.set('q', q.trim());
      const res = await apiRequest<{ items: TopicBoardItem[] }>(`/api/radar/board?${qs.toString()}`);
      setItems(res.items);
      const nextNotes: Record<number, string> = {};
      for (const it of res.items) nextNotes[it.id] = it.notes || '';
      setNoteDrafts(nextNotes);
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  useEffect(() => {
    void load();
  }, [refreshTick]);

  const handleQuickAdd = async () => {
    if (!quickTitle.trim()) return;
    try {
      await apiRequest('/api/radar/board', {
        method: 'POST',
        body: JSON.stringify({ title: quickTitle.trim(), status: 'to_research' }),
      });
      setQuickTitle('');
      onToast('已记入收藏本');
      await load();
      onRefreshBadge();
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  const handleToggleDone = async (item: TopicBoardItem) => {
    const isDone = item.status === 'published' || item.status === 'reviewed';
    const nextStatus = isDone ? 'to_research' : 'published';
    try {
      await apiRequest(`/api/radar/board/${item.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: nextStatus }),
      });
      onToast(isDone ? '已标回「待参考」' : '已标记为「已用过」');
      await load();
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  const handleSaveNote = async (item: TopicBoardItem) => {
    const nextNote = (noteDrafts[item.id] ?? '').trim();
    if (nextNote === (item.notes || '').trim()) return;
    try {
      await apiRequest(`/api/radar/board/${item.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ notes: nextNote }),
      });
      onToast('备注已保存');
      await load();
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await apiRequest(`/api/radar/board/${id}`, { method: 'DELETE' });
      onToast('已从收藏本移除');
      await load();
      onRefreshBadge();
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  const filtered = items.filter((it) => {
    const isDone = it.status === 'published' || it.status === 'reviewed';
    if (doneFilter === 'todo' && isDone) return false;
    if (doneFilter === 'done' && !isDone) return false;
    const origin = it.source_origin || (it.source_content_id ? 'creator' : 'manual');
    if (originFilter !== 'all' && origin !== originFilter) return false;
    return true;
  });

  return (
    <div>
      {/* 顶部清爽筛选 + 随手记一条 */}
      <div className="panel-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div className="pill-group">
            {[
              { k: 'all' as const, l: `全部 (${items.length})` },
              { k: 'creator' as const, l: '对标博主' },
              { k: 'hotboard' as const, l: '平台热榜' },
              { k: 'manual' as const, l: '手动记' },
            ].map((f) => (
              <button
                key={f.k}
                className={`pill-btn ${originFilter === f.k ? 'active' : ''}`}
                onClick={() => setOriginFilter(f.k)}
              >
                {f.l}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <div className="pill-group">
              {[
                { k: 'all' as const, l: '全部状态' },
                { k: 'todo' as const, l: '待参考' },
                { k: 'done' as const, l: '已用过' },
              ].map((s) => (
                <button
                  key={s.k}
                  className={`pill-btn ${doneFilter === s.k ? 'active' : ''}`}
                  onClick={() => setDoneFilter(s.k)}
                >
                  {s.l}
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 5 }}>
              <input
                className="input"
                style={{ width: 175 }}
                placeholder="搜收藏的标题或备注..."
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void load()}
              />
              <button className="btn btn-secondary btn-sm" onClick={() => void load()}>
                <Search size={13} />
              </button>
            </div>
          </div>
        </div>

        {/* 极简随手记一条 */}
        <div style={{ display: 'flex', gap: 8, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
          <input
            className="input"
            placeholder="突然想到一个好点子？直接写一句回车存进收藏本..."
            value={quickTitle}
            onChange={(e) => setQuickTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void handleQuickAdd()}
          />
          <button className="btn btn-primary btn-sm" onClick={() => void handleQuickAdd()}>
            <Plus size={14} /> 随手记一条
          </button>
        </div>
      </div>

      {/* 极简收藏清单（绝无复杂看板） */}
      <div className="panel-card" style={{ marginBottom: 0 }}>
        <div className="panel-head">
          <div className="panel-title">
            <Star size={16} color="#d97706" fill="#d97706" />
            <span>我的收藏清单 ({filtered.length})</span>
          </div>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>点标题或按钮直接看口播稿与热评，备注改完回车即存</span>
        </div>

        {filtered.length === 0 ? (
          <div style={{ padding: '36px 12px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
            收藏本还是空的。在「今日速览」「对标博主」或「平台热榜」里看到想拍的，点一下 ☆ 就能收进来。
          </div>
        ) : (
          <div className="feed-list">
            {filtered.map((it) => {
              const isDone = it.status === 'published' || it.status === 'reviewed';
              const plat = it.content_platform || '';
              const pColor = PLATFORM_COLORS[plat] || '#64748b';
              const highlight = it.ai_summary || it.core_angle;
              return (
                <div key={it.id} className="feed-row" style={{ cursor: 'default' }}>
                  <div className="feed-row-head" style={{ gap: 10 }}>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        minWidth: 0,
                        flex: 1,
                        cursor: it.source_content_id ? 'pointer' : 'default',
                      }}
                      onClick={() => {
                        if (it.source_content_id) onOpenContent(it.source_content_id, 'point', it.id);
                      }}
                    >
                      {plat && (
                        <span className="plat-badge" style={{ background: pColor }}>
                          {PLATFORM_LABELS[plat] || plat}
                        </span>
                      )}
                      <span
                        className="feed-row-title"
                        style={{
                          textDecoration: isDone ? 'line-through' : 'none',
                          color: isDone ? 'var(--text-muted)' : 'var(--text)',
                        }}
                      >
                        {it.title}
                      </span>
                      {it.breakout_ratio != null && it.breakout_ratio >= 1.6 && (
                        <span className="breakout-badge">{it.breakout_ratio}x</span>
                      )}
                    </div>

                    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', flexShrink: 0 }}>
                      <button
                        className={`mini-action ${isDone ? 'done' : ''}`}
                        onClick={() => void handleToggleDone(it)}
                      >
                        <Check size={11} /> {isDone ? '已用过' : '标记已用'}
                      </button>
                      {it.source_content_id && (
                        <>
                          <button
                            className="mini-action"
                            onClick={() => onOpenContent(it.source_content_id!, 'transcript', it.id)}
                          >
                            <Mic size={11} /> {it.transcript_status === 'done' ? '口播稿 ✓' : '口播稿'}
                          </button>
                          <button
                            className="mini-action"
                            onClick={() => onOpenContent(it.source_content_id!, 'comments', it.id)}
                          >
                            <MessageSquareText size={11} /> 热评{it.comment_rows ? `(${it.comment_rows})` : ''}
                          </button>
                        </>
                      )}
                      {it.source_url && (
                        <a
                          href={it.source_url}
                          target="_blank"
                          rel="noreferrer"
                          className="mini-action"
                          style={{ textDecoration: 'none' }}
                        >
                          <ExternalLink size={11} /> 原链
                        </a>
                      )}
                      <button
                        className="mini-action"
                        onClick={() =>
                          onSendToPublish({
                            title: it.title,
                            tags: safeJsonArray<string>(it.tags_json),
                            sourceUrl: it.source_url,
                          })
                        }
                      >
                        <Send size={11} /> 去发布
                      </button>
                      <button
                        className="mini-action"
                        style={{ color: 'var(--danger)' }}
                        onClick={() => void handleDelete(it.id)}
                        title="移除收藏"
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  </div>

                  {highlight && <div className="feed-row-brief">💡 {highlight}</div>}

                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                    <span style={{ fontSize: 11.5, color: 'var(--text-muted)', flexShrink: 0 }}>
                      备注（{fmtTime(it.updated_at)}）：
                    </span>
                    <input
                      className="saved-note-input"
                      placeholder="写一句打算怎么拍，失焦或回车自动保存..."
                      value={noteDrafts[it.id] ?? ''}
                      onChange={(e) => setNoteDrafts((prev) => ({ ...prev, [it.id]: e.target.value }))}
                      onBlur={() => void handleSaveNote(it)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          (e.target as HTMLInputElement).blur();
                        }
                      }}
                    />
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
