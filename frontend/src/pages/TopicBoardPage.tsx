import { useEffect, useState } from 'react';
import { Plus, Trash2, Send, AlertTriangle, ExternalLink, CheckCircle2, LayoutGrid, List } from 'lucide-react';
import { apiRequest, BOARD_STATUS_META, fmtNum, fmtTime, safeJsonArray } from '../api';
import type { PublishInspirationDraft, TopicBoardItem } from '../types';

interface TopicBoardPageProps {
  activeAccountId: number;
  onSendToPublish: (draft: PublishInspirationDraft) => void;
  onToast: (msg: string) => void;
}

const STATUS_ORDER: TopicBoardItem['status'][] = [
  'to_research',
  'to_create',
  'creating',
  'to_publish',
  'published',
  'reviewed',
];

const PRIORITY_META: Record<string, { label: string; color: string }> = {
  high: { label: '高优', color: '#dc2626' },
  medium: { label: '中优', color: '#d97706' },
  low: { label: '备选', color: '#64748b' },
};

export function TopicBoardPage({ activeAccountId, onSendToPublish, onToast }: TopicBoardPageProps) {
  const [items, setItems] = useState<TopicBoardItem[]>([]);
  const [view, setView] = useState<'kanban' | 'table'>('kanban');
  const [q, setQ] = useState('');
  const [priorityFilter, setPriorityFilter] = useState('');

  const [showNew, setShowNew] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newAngle, setNewAngle] = useState('');
  const [newTags, setNewTags] = useState('');
  const [newPriority, setNewPriority] = useState<'high' | 'medium' | 'low'>('medium');
  const [dupHits, setDupHits] = useState<Array<{ title: string; status: string; similarity: number }>>([]);

  const [editing, setEditing] = useState<TopicBoardItem | null>(null);

  const load = async () => {
    try {
      const qs = new URLSearchParams();
      if (q.trim()) qs.set('q', q.trim());
      if (priorityFilter) qs.set('priority', priorityFilter);
      const res = await apiRequest<{ items: TopicBoardItem[] }>(`/api/radar/board?${qs.toString()}`);
      setItems(res.items);
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  useEffect(() => {
    void load();
  }, [priorityFilter]);

  // 实时历史选题查重
  useEffect(() => {
    if (!showNew || newTitle.trim().length < 4) {
      setDupHits([]);
      return;
    }
    const timer = setTimeout(() => {
      void apiRequest<{ matches: Array<{ title: string; status: string; similarity: number }> }>('/api/radar/board/check-duplicate', {
        method: 'POST',
        body: JSON.stringify({ title: newTitle.trim() }),
      })
        .then((r) => setDupHits(r.matches))
        .catch(() => {});
    }, 350);
    return () => clearTimeout(timer);
  }, [newTitle, showNew]);

  const handleCreate = async () => {
    if (!newTitle.trim()) return onToast('请输入选题标题');
    await apiRequest('/api/radar/board', {
      method: 'POST',
      body: JSON.stringify({
        title: newTitle.trim(),
        account_id: activeAccountId,
        core_angle: newAngle.trim(),
        tags: newTags
          .split(/[,，、]+/)
          .map((s) => s.trim())
          .filter(Boolean),
        priority: newPriority,
      }),
    });
    onToast('已新增选题到「待研究」');
    setNewTitle('');
    setNewAngle('');
    setNewTags('');
    setDupHits([]);
    setShowNew(false);
    void load();
  };

  const handleMoveStatus = async (item: TopicBoardItem, nextStatus: TopicBoardItem['status']) => {
    await apiRequest(`/api/radar/board/${item.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: nextStatus }),
    });
    onToast(`选题已流转至「${BOARD_STATUS_META[nextStatus].label}」`);
    void load();
  };

  const handleSaveEdit = async () => {
    if (!editing) return;
    await apiRequest(`/api/radar/board/${editing.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        title: editing.title,
        core_angle: editing.core_angle,
        notes: editing.notes,
        priority: editing.priority,
        status: editing.status,
        published_url: editing.published_url,
        review_views: editing.review_views,
        review_likes: editing.review_likes,
        review_favorites: editing.review_favorites,
        review_comments: editing.review_comments,
        review_notes: editing.review_notes,
      }),
    });
    onToast('选题与复盘信息已保存');
    setEditing(null);
    void load();
  };

  const handleDelete = async (id: number) => {
    if (!window.confirm('确定删除这条选题吗？')) return;
    await apiRequest(`/api/radar/board/${id}`, { method: 'DELETE' });
    onToast('已删除选题');
    if (editing?.id === id) setEditing(null);
    void load();
  };

  return (
    <div>
      <div className="panel-card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <div className="sub-tabs">
            <button className={`sub-tab-btn ${view === 'kanban' ? 'active' : ''}`} onClick={() => setView('kanban')}>
              <LayoutGrid size={13} style={{ verticalAlign: 'middle', marginRight: 4 }} />6 态看板
            </button>
            <button className={`sub-tab-btn ${view === 'table' ? 'active' : ''}`} onClick={() => setView('table')}>
              <List size={13} style={{ verticalAlign: 'middle', marginRight: 4 }} />列表管理
            </button>
          </div>
          <select className="input" style={{ width: 115 }} value={priorityFilter} onChange={(e) => setPriorityFilter(e.target.value)}>
            <option value="">全部优先级</option>
            <option value="high">高优先级</option>
            <option value="medium">中优先级</option>
            <option value="low">备选</option>
          </select>
          <input
            className="input"
            style={{ width: 190 }}
            placeholder="搜索历史选题防撞车..."
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void load()}
          />
          <button className="btn btn-secondary" onClick={() => void load()}>
            搜索
          </button>
        </div>
        <button className="btn btn-primary" onClick={() => setShowNew((v) => !v)}>
          <Plus size={14} /> 手动新建选题
        </button>
      </div>

      {showNew && (
        <div className="panel-card" style={{ borderColor: '#c7d2fe', background: '#fafbff' }}>
          <div className="panel-title" style={{ marginBottom: 10 }}>
            新建个人选题（自动比对历史选题库防重复）
          </div>
          {dupHits.length > 0 && (
            <div className="alert-banner-warn" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <AlertTriangle size={15} />
              <span>
                历史选题查重警告：与「<strong>{dupHits[0].title}</strong>」相似度 <strong>{dupHits[0].similarity}%</strong>（状态：
                {BOARD_STATUS_META[dupHits[0].status]?.label || dupHits[0].status}）
              </span>
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 10 }}>
            <input className="input" placeholder="选题标题 *" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} />
            <input className="input" placeholder="标签（逗号分隔）" value={newTags} onChange={(e) => setNewTags(e.target.value)} />
            <select className="input" value={newPriority} onChange={(e) => setNewPriority(e.target.value as 'high' | 'medium' | 'low')}>
              <option value="high">高优先级</option>
              <option value="medium">中优先级</option>
              <option value="low">备选</option>
            </select>
            <textarea
              className="input"
              style={{ gridColumn: '1 / -1' }}
              rows={2}
              placeholder="核心切入角度与创作思路..."
              value={newAngle}
              onChange={(e) => setNewAngle(e.target.value)}
            />
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button className="btn btn-primary" onClick={handleCreate}>
              加入选题库
            </button>
            <button className="btn btn-secondary" onClick={() => setShowNew(false)}>
              取消
            </button>
          </div>
        </div>
      )}

      {view === 'kanban' ? (
        <div className="kanban-grid">
          {STATUS_ORDER.map((statusKey) => {
            const meta = BOARD_STATUS_META[statusKey];
            const colItems = items.filter((i) => i.status === statusKey);
            const nextIdx = STATUS_ORDER.indexOf(statusKey) + 1;
            const nextStatus = nextIdx < STATUS_ORDER.length ? STATUS_ORDER[nextIdx] : null;
            return (
              <div key={statusKey} className="kanban-col">
                <div className="kanban-col-head">
                  <span style={{ color: meta.color }}>{meta.label}</span>
                  <span className="metric-chip">{colItems.length}</span>
                </div>
                {colItems.length === 0 ? (
                  <div style={{ fontSize: 12, color: '#94a3b8', textAlign: 'center', padding: '18px 4px' }}>空</div>
                ) : (
                  colItems.map((it) => {
                    const pMeta = PRIORITY_META[it.priority] || PRIORITY_META.medium;
                    return (
                      <div key={it.id} className="kanban-card">
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
                          <span style={{ fontSize: 11, fontWeight: 700, color: pMeta.color }}>● {pMeta.label}</span>
                          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{fmtTime(it.updated_at)}</span>
                        </div>
                        <div
                          style={{ fontWeight: 700, fontSize: 13, lineHeight: 1.4, cursor: 'pointer' }}
                          onClick={() => setEditing({ ...it })}
                        >
                          {it.title}
                        </div>
                        {it.core_angle && (
                          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 5 }}>{it.core_angle.slice(0, 68)}</div>
                        )}
                        {it.status === 'reviewed' && (
                          <div style={{ fontSize: 11, color: '#7c3aed', marginTop: 5 }}>
                            复盘：播 {fmtNum(it.review_views)} · 赞 {fmtNum(it.review_likes)}
                          </div>
                        )}
                        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 8 }}>
                          <button
                            className="btn btn-secondary"
                            style={{ padding: '3px 7px', fontSize: 11 }}
                            onClick={() => setEditing({ ...it })}
                          >
                            编辑/复盘
                          </button>
                          {nextStatus && (
                            <button
                              className="btn btn-primary"
                              style={{ padding: '3px 7px', fontSize: 11 }}
                              onClick={() => handleMoveStatus(it, nextStatus)}
                            >
                              → {BOARD_STATUS_META[nextStatus].label}
                            </button>
                          )}
                          {it.status === 'to_publish' && (
                            <button
                              className="btn btn-secondary"
                              style={{ padding: '3px 7px', fontSize: 11 }}
                              onClick={() =>
                                onSendToPublish({
                                  title: it.title,
                                  tags: safeJsonArray<string>(it.tags_json),
                                  sourceUrl: it.source_url,
                                })
                              }
                            >
                              <Send size={11} /> 发视频
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="panel-card">
          <table className="data-table">
            <thead>
              <tr>
                <th>选题标题与切入角度</th>
                <th style={{ width: 95 }}>优先级</th>
                <th style={{ width: 120 }}>状态流转</th>
                <th style={{ width: 160 }}>复盘表现</th>
                <th style={{ width: 140 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id}>
                  <td>
                    <div style={{ fontWeight: 700, cursor: 'pointer' }} onClick={() => setEditing({ ...it })}>
                      {it.title}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>{it.core_angle || '—'}</div>
                  </td>
                  <td>
                    <span style={{ color: (PRIORITY_META[it.priority] || PRIORITY_META.medium).color, fontWeight: 700 }}>
                      {(PRIORITY_META[it.priority] || PRIORITY_META.medium).label}
                    </span>
                  </td>
                  <td>
                    <select
                      className="input"
                      style={{ padding: '4px 6px', fontSize: 12 }}
                      value={it.status}
                      onChange={(e) => handleMoveStatus(it, e.target.value as TopicBoardItem['status'])}
                    >
                      {STATUS_ORDER.map((s) => (
                        <option key={s} value={s}>
                          {BOARD_STATUS_META[s].label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td style={{ fontSize: 12 }}>
                    播 {fmtNum(it.review_views)} · 赞 {fmtNum(it.review_likes)} · 藏 {fmtNum(it.review_favorites)}
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 5 }}>
                      <button className="btn btn-secondary" style={{ padding: '4px 8px', fontSize: 11.5 }} onClick={() => setEditing({ ...it })}>
                        编辑
                      </button>
                      <button
                        className="btn btn-secondary"
                        style={{ padding: '4px 7px', fontSize: 11.5, color: 'var(--danger)' }}
                        onClick={() => handleDelete(it.id)}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 选题详情 & 效果复盘弹窗 */}
      {editing && (
        <div className="modal-backdrop" onClick={() => setEditing(null)}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="panel-head" style={{ borderBottom: '1px solid var(--border)', paddingBottom: 10 }}>
              <div className="panel-title">编辑选题与发布效果复盘</div>
              {editing.source_url && (
                <a href={editing.source_url} target="_blank" rel="noreferrer" style={{ fontSize: 12.5, color: 'var(--primary)' }}>
                  查看原始参考 <ExternalLink size={12} />
                </a>
              )}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 10 }}>
              <div>
                <label className="field-label">选题标题</label>
                <input className="input" value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} />
              </div>
              <div>
                <label className="field-label">当前状态</label>
                <select
                  className="input"
                  value={editing.status}
                  onChange={(e) => setEditing({ ...editing, status: e.target.value as TopicBoardItem['status'] })}
                >
                  {STATUS_ORDER.map((s) => (
                    <option key={s} value={s}>
                      {BOARD_STATUS_META[s].label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="field-label">优先级</label>
                <select
                  className="input"
                  value={editing.priority}
                  onChange={(e) => setEditing({ ...editing, priority: e.target.value as 'high' | 'medium' | 'low' })}
                >
                  <option value="high">高优先级</option>
                  <option value="medium">中优先级</option>
                  <option value="low">备选</option>
                </select>
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <label className="field-label">差异化切入角度与脚本要点</label>
                <textarea
                  className="input"
                  rows={3}
                  value={editing.core_angle}
                  onChange={(e) => setEditing({ ...editing, core_angle: e.target.value })}
                />
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <label className="field-label">创作备注</label>
                <textarea
                  className="input"
                  rows={2}
                  value={editing.notes}
                  onChange={(e) => setEditing({ ...editing, notes: e.target.value })}
                />
              </div>
            </div>

            <div style={{ marginTop: 14, padding: 12, background: 'var(--surface-muted)', borderRadius: 10, border: '1px solid var(--border)' }}>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>发布后真实表现复盘（用于沉淀爆款经验）</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
                <input
                  className="input"
                  type="number"
                  placeholder="真实播放量"
                  value={editing.review_views ?? ''}
                  onChange={(e) => setEditing({ ...editing, review_views: e.target.value === '' ? null : Number(e.target.value) })}
                />
                <input
                  className="input"
                  type="number"
                  placeholder="真实点赞"
                  value={editing.review_likes ?? ''}
                  onChange={(e) => setEditing({ ...editing, review_likes: e.target.value === '' ? null : Number(e.target.value) })}
                />
                <input
                  className="input"
                  type="number"
                  placeholder="真实收藏"
                  value={editing.review_favorites ?? ''}
                  onChange={(e) => setEditing({ ...editing, review_favorites: e.target.value === '' ? null : Number(e.target.value) })}
                />
                <input
                  className="input"
                  type="number"
                  placeholder="真实评论"
                  value={editing.review_comments ?? ''}
                  onChange={(e) => setEditing({ ...editing, review_comments: e.target.value === '' ? null : Number(e.target.value) })}
                />
                <input
                  className="input"
                  style={{ gridColumn: '1 / -1' }}
                  placeholder="本人作品发布链接（选填）"
                  value={editing.published_url}
                  onChange={(e) => setEditing({ ...editing, published_url: e.target.value })}
                />
                <textarea
                  className="input"
                  style={{ gridColumn: '1 / -1' }}
                  rows={2}
                  placeholder="复盘总结：为什么爆了/为什么没跑起来？下一次怎么改标题和开头？"
                  value={editing.review_notes}
                  onChange={(e) => setEditing({ ...editing, review_notes: e.target.value })}
                />
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 16 }}>
              <button className="btn btn-danger" onClick={() => handleDelete(editing.id)}>
                <Trash2 size={14} /> 删除选题
              </button>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="btn btn-secondary"
                  onClick={() => {
                    onSendToPublish({
                      title: editing.title,
                      tags: safeJsonArray<string>(editing.tags_json),
                      sourceUrl: editing.source_url,
                    });
                    setEditing(null);
                  }}
                >
                  <Send size={14} /> 带入视频发布
                </button>
                <button className="btn btn-primary" onClick={handleSaveEdit}>
                  <CheckCircle2 size={14} /> 保存修改
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
