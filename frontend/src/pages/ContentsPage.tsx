import { useEffect, useState } from 'react';
import { Star, ExternalLink, Search, CheckCircle2, BookOpen, Send, CheckCheck } from 'lucide-react';
import { apiRequest, fmtNum, fmtTime, PLATFORM_LABELS } from '../api';
import type { Category, ContentSummary, MetricSnapshot, PublishInspirationDraft, SourceItem } from '../types';

function parseTagsJson(raw?: string): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map((x) => String(x).trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function ContentsPage({
  onToast,
  onSendToPublish,
}: {
  onToast: (msg: string) => void;
  onSendToPublish?: (draft: PublishInspirationDraft) => void;
}) {
  const [items, setItems] = useState<ContentSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [sources, setSources] = useState<SourceItem[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [platform, setPlatform] = useState('all');
  const [sourceId, setSourceId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [isFavorite, setIsFavorite] = useState(false);
  const [isRead, setIsRead] = useState<'all' | '0' | '1'>('all');
  const [days, setDays] = useState('');
  const [sort, setSort] = useState<'latest' | 'likes' | 'views'>('latest');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [savingTplId, setSavingTplId] = useState<number | null>(null);

  const [detail, setDetail] = useState<{ item: ContentSummary & { body?: string; source_url?: string }; metricsHistory: MetricSnapshot[] } | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (platform !== 'all') params.set('platform', platform);
      if (sourceId) params.set('sourceId', sourceId);
      if (categoryId) params.set('categoryId', categoryId);
      if (isFavorite) params.set('isFavorite', '1');
      if (isRead !== 'all') params.set('isRead', isRead);
      if (days) params.set('days', days);
      if (sort !== 'latest') params.set('sort', sort);
      if (query.trim()) params.set('q', query.trim());
      params.set('limit', '50');
      const res = await apiRequest<{ items: ContentSummary[]; total: number }>(`/api/contents?${params.toString()}`);
      setItems(res.items);
      setTotal(res.total);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    apiRequest<SourceItem[]>('/api/sources').then(setSources).catch(() => {});
    apiRequest<Category[]>('/api/categories').then(setCategories).catch(() => {});
  }, []);

  useEffect(() => {
    void load();
  }, [platform, sourceId, categoryId, isFavorite, isRead, days, sort]);

  const openDetail = async (item: ContentSummary) => {
    const res = await apiRequest<{ item: ContentSummary & { body?: string; source_url?: string }; metricsHistory: MetricSnapshot[] }>(
      `/api/contents/${item.id}`
    );
    setDetail(res);
    if (!item.is_read) {
      await apiRequest(`/api/contents/${item.id}`, { method: 'PATCH', body: JSON.stringify({ is_read: true }) });
      setItems((prev) => prev.map((x) => (x.id === item.id ? { ...x, is_read: 1 } : x)));
    }
  };

  const toggleFavorite = async (id: number, currentFav: number, e?: React.MouseEvent) => {
    e?.stopPropagation();
    const next = !currentFav;
    await apiRequest(`/api/contents/${id}`, { method: 'PATCH', body: JSON.stringify({ is_favorite: next }) });
    setItems((prev) => prev.map((x) => (x.id === id ? { ...x, is_favorite: next ? 1 : 0 } : x)));
    if (detail && detail.item.id === id) {
      setDetail({ ...detail, item: { ...detail.item, is_favorite: next ? 1 : 0 } });
    }
    onToast(next ? '已加入收藏' : '已取消收藏');
  };

  // 一键将当前列表未读内容标为已读
  const handleMarkAllRead = async () => {
    const res = await apiRequest<{ ok: boolean; updated: number }>('/api/contents/mark-all-read', {
      method: 'POST',
      body: JSON.stringify({
        platform: platform !== 'all' ? platform : undefined,
        sourceId: sourceId ? Number(sourceId) : undefined,
      }),
    });
    setItems((prev) => prev.map((x) => ({ ...x, is_read: 1 })));
    onToast(res.updated > 0 ? `已将 ${res.updated} 条内容标为已读` : '当前筛选下没有未读内容');
  };

  // 将监控到的对标爆款标题直接提取存入视频发布「标题文案库」
  const handleSaveAsTemplate = async (item: ContentSummary, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setSavingTplId(item.id);
    try {
      const tags = parseTagsJson(item.tags_json);
      const fallbackTags = tags.length > 0 ? tags : [PLATFORM_LABELS[item.platform] || item.platform];
      await apiRequest('/api/sau/title-templates', {
        method: 'POST',
        body: JSON.stringify({
          category: '干货拆解',
          title: item.title,
          tags: fallbackTags,
          note: `对标灵感：${item.source_name}`,
        }),
      });
      onToast('已提取存入「视频发布 → 标题文案库」');
    } catch (err) {
      onToast(`存入标题库失败：${(err as Error).message}`);
    } finally {
      setSavingTplId(null);
    }
  };

  // 一键携带标题与标签跳转至批量视频发布页进行二创跟进
  const handleJumpToPublish = (item: ContentSummary, e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (!onSendToPublish) return;
    const tags = parseTagsJson(item.tags_json);
    onSendToPublish({
      title: item.title,
      tags,
      sourceName: item.source_name,
      sourceUrl: item.canonical_url,
    });
  };

  const unreadInView = items.filter((x) => !x.is_read).length;

  return (
    <div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <div style={{ display: 'flex', gap: 6, flex: '1 1 240px' }}>
            <input
              className="input"
              data-testid="input-search-content"
              placeholder="搜索标题、作者、摘要或正文关键词..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void load()}
            />
            <button className="btn btn-primary" onClick={() => void load()}>
              <Search size={14} /> 搜索
            </button>
          </div>

          <select className="select" style={{ width: 132 }} value={platform} onChange={(e) => setPlatform(e.target.value)}>
            <option value="all">全部平台</option>
            <option value="website">普通网站</option>
            <option value="rss">RSS 订阅</option>
            <option value="douyin">抖音</option>
            <option value="kuaishou">快手</option>
            <option value="wechat-channels">微信视频号</option>
            <option value="x">X (Twitter)</option>
            <option value="youtube">YouTube</option>
          </select>

          <select className="select" style={{ width: 155 }} value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
            <option value="">全部博主/网站</option>
            {sources.map((s) => (
              <option key={s.id} value={String(s.id)}>{s.name}</option>
            ))}
          </select>

          <select className="select" style={{ width: 120 }} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">全部分类</option>
            {categories.map((c) => (
              <option key={c.id} value={String(c.id)}>{c.name}</option>
            ))}
          </select>

          <select className="select" style={{ width: 112 }} value={days} onChange={(e) => setDays(e.target.value)}>
            <option value="">全部时间</option>
            <option value="1">近 24 小时</option>
            <option value="7">近 7 天</option>
            <option value="30">近 30 天</option>
          </select>

          <select className="select" style={{ width: 132 }} value={sort} onChange={(e) => setSort(e.target.value as 'latest' | 'likes' | 'views')}>
            <option value="latest">按最新发布</option>
            <option value="likes">按最高点赞（爆款）</option>
            <option value="views">按最高播放（爆款）</option>
          </select>

          <select className="select" style={{ width: 108 }} value={isRead} onChange={(e) => setIsRead(e.target.value as 'all' | '0' | '1')}>
            <option value="all">全部状态</option>
            <option value="0">仅未读</option>
            <option value="1">仅已读</option>
          </select>

          <button className={`btn ${isFavorite ? 'btn-primary' : ''}`} onClick={() => setIsFavorite(!isFavorite)}>
            <Star size={14} /> {isFavorite ? '只看收藏中' : '只看收藏'}
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 10, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          共匹配 {total} 条内容 {loading ? '（加载中...）' : ''}
        </div>
        {unreadInView > 0 && (
          <button className="btn btn-sm" onClick={() => void handleMarkAllRead()}>
            <CheckCheck size={13} /> 当前全部标为已读
          </button>
        )}
      </div>

      <div className="content-list">
        {items.length === 0 ? (
          <div className="card" style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 40 }}>
            暂无符合条件的内容。你可以先在“监控对象”页面添加网站或博主并执行检查。
          </div>
        ) : (
          items.map((item) => (
            <div
              key={item.id}
              data-testid={`content-card-${item.id}`}
              className={`content-card ${item.is_read ? '' : 'unread'}`}
              onClick={() => void openDetail(item)}
            >
              {item.cover_url && (
                <img
                  src={item.cover_url}
                  alt=""
                  className="content-cover"
                  referrerPolicy="no-referrer"
                  onError={(e) => {
                    e.currentTarget.style.display = 'none';
                  }}
                />
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                  <div style={{ fontSize: 15, fontWeight: 600 }}>{item.title}</div>
                  <button
                    className="btn btn-sm"
                    data-testid={`btn-fav-${item.id}`}
                    onClick={(e) => void toggleFavorite(item.id, item.is_favorite, e)}
                    style={{ color: item.is_favorite ? '#eab308' : 'var(--text-muted)' }}
                  >
                    <Star size={14} fill={item.is_favorite ? '#eab308' : 'none'} />
                  </button>
                </div>

                <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 6, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                  {item.summary || '点击查看详细正文与来源链接'}
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginTop: 10 }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, fontSize: 12, color: 'var(--text-muted)', alignItems: 'center' }}>
                    <span className="badge badge-blue">{PLATFORM_LABELS[item.platform] || item.platform}</span>
                    <span>来源：{item.source_name}</span>
                    {item.author && <span>作者：{item.author}</span>}
                    <span>发布：{fmtTime(item.published_at)}</span>
                    <span>发现：{fmtTime(item.discovered_at)}</span>
                    {item.latest_likes !== null && <span>赞 {fmtNum(item.latest_likes)}</span>}
                    {item.latest_views !== null && <span>播放 {fmtNum(item.latest_views)}</span>}
                    {item.is_read ? (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                        <CheckCircle2 size={12} /> 已读
                      </span>
                    ) : (
                      <span className="badge badge-amber">未读</span>
                    )}
                  </div>

                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      className="btn btn-sm"
                      disabled={savingTplId === item.id}
                      onClick={(e) => void handleSaveAsTemplate(item, e)}
                      title="提取标题与标签存入视频发布标题文案库"
                    >
                      <BookOpen size={12} /> 存入标题库
                    </button>
                    {onSendToPublish && (
                      <button
                        className="btn btn-sm btn-primary"
                        onClick={(e) => handleJumpToPublish(item, e)}
                        title="携带该爆款选题直接进入批量视频发布"
                      >
                        <Send size={12} /> 去二创发布
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {detail && (
        <div className="modal-backdrop" onClick={() => setDetail(null)}>
          <div className="modal-card" style={{ maxWidth: 820 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="badge badge-blue">{PLATFORM_LABELS[detail.item.platform] || detail.item.platform}</span>
                <strong>内容详情</strong>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn btn-sm" onClick={(e) => void handleSaveAsTemplate(detail.item, e)}>
                  <BookOpen size={14} /> 存入标题库
                </button>
                {onSendToPublish && (
                  <button
                    className="btn btn-sm"
                    onClick={(e) => {
                      setDetail(null);
                      handleJumpToPublish(detail.item, e);
                    }}
                  >
                    <Send size={14} /> 去二创发布
                  </button>
                )}
                <button className="btn btn-sm" onClick={(e) => void toggleFavorite(detail.item.id, detail.item.is_favorite, e)}>
                  <Star size={14} fill={detail.item.is_favorite ? '#eab308' : 'none'} color={detail.item.is_favorite ? '#eab308' : 'currentColor'} />
                  {detail.item.is_favorite ? '已收藏' : '收藏'}
                </button>
                <a className="btn btn-sm btn-primary" href={detail.item.canonical_url} target="_blank" rel="noreferrer">
                  <ExternalLink size={14} /> 打开原始链接
                </a>
                <button className="btn btn-sm" onClick={() => setDetail(null)}>关闭</button>
              </div>
            </div>
            <div className="modal-body">
              <h2 style={{ margin: '0 0 10px', fontSize: 19 }}>{detail.item.title}</h2>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14, display: 'flex', flexWrap: 'wrap', gap: 14 }}>
                <span>来源：{detail.item.source_name}</span>
                <span>作者：{detail.item.author || '—'}</span>
                <span>发布时间：{fmtTime(detail.item.published_at)}</span>
                <span>发现时间：{fmtTime(detail.item.discovered_at)}</span>
              </div>
              {detail.item.cover_url && (
                <img
                  src={detail.item.cover_url}
                  alt=""
                  referrerPolicy="no-referrer"
                  style={{ maxWidth: '100%', maxHeight: 320, borderRadius: 8, marginBottom: 16, objectFit: 'contain' }}
                />
              )}
              <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.75, fontSize: 14, background: 'var(--surface-muted)', padding: 16, borderRadius: 8 }}>
                {detail.item.body || detail.item.summary || '（该条内容暂无正文文本，可点击右上角打开原始链接查看）'}
              </div>

              {detail.metricsHistory.length > 0 && (
                <div style={{ marginTop: 18 }}>
                  <h4 style={{ margin: '0 0 8px', fontSize: 14 }}>历史互动数据快照（保留历史变化，不覆盖）</h4>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>记录时间</th>
                          <th>播放/浏览</th>
                          <th>点赞</th>
                          <th>评论</th>
                          <th>分享</th>
                          <th>收藏</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.metricsHistory.map((m) => (
                          <tr key={m.id}>
                            <td>{fmtTime(m.captured_at)}</td>
                            <td>{fmtNum(m.views)}</td>
                            <td>{fmtNum(m.likes)}</td>
                            <td>{fmtNum(m.comments)}</td>
                            <td>{fmtNum(m.shares)}</td>
                            <td>{fmtNum(m.favorites)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
