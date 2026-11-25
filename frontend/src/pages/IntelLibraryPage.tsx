import { useEffect, useState } from 'react';
import {
  Search,
  Sparkles,
  Mic,
  MessageSquareText,
  BookmarkPlus,
  Send,
  ExternalLink,
  Layers,
  AlertTriangle,
  RefreshCw,
} from 'lucide-react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { apiRequest, CONTENT_TYPE_LABELS, fmtNum, fmtTime, PLATFORM_LABELS, safeJsonArray } from '../api';
import type { IntelItem, MetricSnapshot, PublishInspirationDraft, TopicCluster, TopicRecommendation } from '../types';

interface IntelLibraryPageProps {
  activeAccountId: number;
  initialContentId?: number | null;
  onClearInitialContent?: () => void;
  onSendToPublish: (draft: PublishInspirationDraft) => void;
  onToast: (msg: string) => void;
}

interface IntelDetailResp {
  content: IntelItem & { body: string; transcript: string; baseline_views: number | null; baseline_likes: number | null; baseline_sample_size: number };
  metrics: MetricSnapshot[];
  comments: Array<{ id: number; author: string; text: string; likes: number | null; published_at: string | null }>;
  analysis: {
    category: string;
    summary_zh: string;
    core_points_json: string;
    audience_needs_json: string;
    comment_pain_points_json: string;
    diff_angles_json: string;
    trend_judgement: string;
    content_form_advice: string;
    evidence_note: string;
    analyzed_at: string;
  } | null;
  recommendation: TopicRecommendation | null;
  tingwuJobs: Array<{ id: number; status: string; error_message: string | null; updated_at: string }>;
  clusterSiblings: Array<{ id: number; title: string; platform: string; canonical_url: string; source_name: string }>;
  duplicates: Array<{ title: string; status: string; similarity: number }>;
}

export function IntelLibraryPage({
  activeAccountId,
  initialContentId,
  onClearInitialContent,
  onSendToPublish,
  onToast,
}: IntelLibraryPageProps) {
  const [viewMode, setViewMode] = useState<'list' | 'clusters'>('list');
  const [items, setItems] = useState<IntelItem[]>([]);
  const [clusters, setClusters] = useState<TopicCluster[]>([]);
  const [platform, setPlatform] = useState('');
  const [contentType, setContentType] = useState('');
  const [onlyBreakout, setOnlyBreakout] = useState(false);
  const [hasTranscript, setHasTranscript] = useState(false);
  const [q, setQ] = useState('');

  const [selectedId, setSelectedId] = useState<number | null>(initialContentId || null);
  const [detail, setDetail] = useState<IntelDetailResp | null>(null);
  const [detailTab, setDetailTab] = useState<'ai' | 'transcript' | 'comments' | 'sources'>('ai');
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const loadList = async () => {
    try {
      if (viewMode === 'clusters') {
        const cls = await apiRequest<TopicCluster[]>('/api/radar/clusters');
        setClusters(cls);
        return;
      }
      const qs = new URLSearchParams({ accountId: String(activeAccountId) });
      if (platform) qs.set('platform', platform);
      if (contentType) qs.set('contentType', contentType);
      if (onlyBreakout) qs.set('onlyBreakout', 'true');
      if (hasTranscript) qs.set('hasTranscript', 'true');
      if (q.trim()) qs.set('q', q.trim());
      const res = await apiRequest<{ items: IntelItem[] }>(`/api/radar/intel?${qs.toString()}`);
      setItems(res.items);
      if (!selectedId && res.items.length > 0) {
        setSelectedId(res.items[0].id);
      }
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  const loadDetail = async (id: number) => {
    try {
      const d = await apiRequest<IntelDetailResp>(`/api/radar/intel/${id}/detail?accountId=${activeAccountId}`);
      setDetail(d);
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  useEffect(() => {
    if (initialContentId) {
      setViewMode('list');
      setSelectedId(initialContentId);
      onClearInitialContent?.();
    }
  }, [initialContentId]);

  useEffect(() => {
    void loadList();
  }, [viewMode, platform, contentType, onlyBreakout, hasTranscript, activeAccountId]);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
  }, [selectedId, activeAccountId]);

  const runAction = async (key: string, fn: () => Promise<void>) => {
    setBusyAction(key);
    try {
      await fn();
      if (selectedId) await loadDetail(selectedId);
      await loadList();
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setBusyAction(null);
    }
  };

  const handleRebuildClusters = () =>
    runAction('cluster', async () => {
      const res = await apiRequest<{ clustersCreated: number; linked: number }>('/api/radar/clusters/rebuild', { method: 'POST' });
      onToast(`已完成事件聚类：归并 ${res.clustersCreated} 个话题，关联 ${res.linked} 条内容`);
    });

  const handleAddBoard = async () => {
    if (!detail) return;
    const c = detail.content;
    const rec = detail.recommendation;
    const res = await apiRequest<{ duplicates: Array<{ title: string; similarity: number }> }>('/api/radar/board', {
      method: 'POST',
      body: JSON.stringify({
        title: rec?.recommended_title || c.title,
        account_id: activeAccountId,
        source_content_id: c.id,
        recommendation_id: rec?.id ?? null,
        cluster_id: c.cluster_id,
        core_angle: rec ? `${rec.core_viewpoint}\n差异化角度：${rec.diff_angle}` : detail.analysis?.summary_zh || c.summary,
        tags: [detail.analysis?.category || '', PLATFORM_LABELS[c.platform] || c.platform].filter(Boolean),
        priority: (rec?.score_total || 0) >= 75 || (c.breakout_ratio || 0) >= 2 ? 'high' : 'medium',
        source_url: c.canonical_url,
      }),
    });
    onToast(
      res.duplicates.length > 0
        ? `已加入选题库！提示：与历史选题「${res.duplicates[0].title}」相似 ${res.duplicates[0].similarity}%`
        : '已一键加入个人选题库'
    );
  };

  const metricChart = (detail?.metrics || []).map((m) => ({
    time: fmtTime(m.captured_at),
    views: m.views ?? 0,
    likes: m.likes ?? 0,
    comments: m.comments ?? 0,
  }));

  return (
    <div>
      {/* 顶部多维筛选栏 */}
      <div className="panel-card" style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <div className="sub-tabs">
            <button className={`sub-tab-btn ${viewMode === 'list' ? 'active' : ''}`} onClick={() => setViewMode('list')}>
              全量情报库
            </button>
            <button className={`sub-tab-btn ${viewMode === 'clusters' ? 'active' : ''}`} onClick={() => setViewMode('clusters')}>
              <Layers size={13} style={{ verticalAlign: 'middle', marginRight: 4 }} />
              按事件聚簇视图
            </button>
          </div>
          {viewMode === 'list' && (
            <>
              <select className="input" style={{ width: 118 }} value={platform} onChange={(e) => setPlatform(e.target.value)}>
                <option value="">全部平台</option>
                <option value="douyin">抖音</option>
                <option value="bilibili">B站</option>
                <option value="youtube">YouTube</option>
                <option value="rss">RSS</option>
                <option value="website">行业网站</option>
              </select>
              <select className="input" style={{ width: 110 }} value={contentType} onChange={(e) => setContentType(e.target.value)}>
                <option value="">全部形态</option>
                <option value="video">视频</option>
                <option value="article">文章</option>
                <option value="hot_topic">热榜</option>
              </select>
              <label style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
                <input type="checkbox" checked={onlyBreakout} onChange={(e) => setOnlyBreakout(e.target.checked)} />
                仅看潜力爆款
              </label>
              <label style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
                <input type="checkbox" checked={hasTranscript} onChange={(e) => setHasTranscript(e.target.checked)} />
                已有听悟口播稿
              </label>
              <div style={{ display: 'flex', gap: 5 }}>
                <input
                  className="input"
                  style={{ width: 180 }}
                  placeholder="全文搜索标题/口播/摘要..."
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void loadList()}
                />
                <button className="btn btn-secondary" onClick={() => void loadList()}>
                  <Search size={14} />
                </button>
              </div>
            </>
          )}
        </div>
        <button className="btn btn-secondary" disabled={busyAction === 'cluster'} onClick={handleRebuildClusters}>
          <RefreshCw size={13} /> {busyAction === 'cluster' ? 'AI 聚类中...' : '刷新多源事件聚簇'}
        </button>
      </div>

      {/* 事件聚簇视图 */}
      {viewMode === 'clusters' ? (
        <div className="panel-card">
          <div className="panel-head">
            <div className="panel-title">
              <Layers size={17} color="#7c3aed" />
              <span>多博主/多来源事件聚簇 ({clusters.length})</span>
            </div>
          </div>
          {clusters.length === 0 ? (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>
              暂无聚类话题，点右上角「刷新多源事件聚簇」将同一事件的各平台报道自动归并。
            </div>
          ) : (
            clusters.map((cl) => (
              <div key={cl.id} className="rec-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <strong style={{ fontSize: 15.5 }}>{cl.title}</strong>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <span className="score-pill score-mid">热度 {cl.heat_score}</span>
                    <span className="metric-chip">{cl.source_count} 个独立来源</span>
                  </div>
                </div>
                <div style={{ fontSize: 13, color: '#334155', marginTop: 6 }}>{cl.summary}</div>
                <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {(cl.members || []).map((m) => (
                    <div
                      key={m.id}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '6px 10px',
                        background: 'var(--surface-muted)',
                        borderRadius: 8,
                        cursor: 'pointer',
                      }}
                      onClick={() => {
                        setViewMode('list');
                        setSelectedId(m.id);
                      }}
                    >
                      <span style={{ fontSize: 13 }}>
                        <strong>[{PLATFORM_LABELS[m.platform] || m.platform} · {m.source_name}]</strong> {m.title}
                      </span>
                      <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                        播 {fmtNum(m.latest_views)} · 赞 {fmtNum(m.latest_likes)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      ) : (
        /* 全量情报双栏工作台 */
        <div className="split-workbench">
          {/* 左：高密度情报列表 */}
          <div className="panel-card" style={{ maxHeight: '78vh', overflowY: 'auto' }}>
            <div className="panel-head">
              <div className="panel-title">情报列表 ({items.length})</div>
            </div>
            {items.length === 0 ? (
              <div style={{ padding: 28, textAlign: 'center', color: 'var(--text-muted)' }}>暂无符合条件的内容。</div>
            ) : (
              items.map((it) => (
                <div
                  key={it.id}
                  className={`selectable-row ${selectedId === it.id ? 'selected' : ''}`}
                  onClick={() => setSelectedId(it.id)}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' }}>
                      <span className="metric-chip">{PLATFORM_LABELS[it.platform] || it.platform}</span>
                      <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{it.source_name}</span>
                      {it.breakout_ratio != null && it.breakout_ratio >= 1.6 && (
                        <span className="breakout-badge">🔥 {it.breakout_ratio}x</span>
                      )}
                    </div>
                    {it.rec_score != null && (
                      <span className={`score-pill ${it.rec_score >= 75 ? 'score-high' : 'score-mid'}`} style={{ fontSize: 11.5, padding: '2px 7px' }}>
                        {it.rec_score}分
                      </span>
                    )}
                  </div>
                  <div style={{ fontWeight: 600, fontSize: 13.5, lineHeight: 1.4 }}>{it.title}</div>
                  {it.summary_zh && (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>{it.summary_zh.slice(0, 75)}...</div>
                  )}
                  <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 6, fontSize: 11.5 }}>
                    <span className="metric-chip">播 {fmtNum(it.latest_views)}</span>
                    <span className="metric-chip">赞 {fmtNum(it.latest_likes)}</span>
                    <span className="metric-chip">评 {fmtNum(it.latest_comments)}</span>
                    {it.transcript_status === 'done' && <span className="metric-chip" style={{ color: '#16a34a' }}>🎙 已有口播</span>}
                    {it.comment_rows > 0 && <span className="metric-chip" style={{ color: '#4f46e5' }}>💬 {it.comment_rows}热评</span>}
                  </div>
                </div>
              ))
            )}
          </div>

          {/* 右：深度情报详情抽屉 */}
          <div>
            {!detail ? (
              <div className="panel-card" style={{ textAlign: 'center', padding: 48, color: 'var(--text-muted)' }}>
                点击左侧任意情报，可查看真实互动数据、一键调用通义听悟转写、拉取 MediaCrawler 评论并生成 6 维选题分析。
              </div>
            ) : (
              <div className="panel-card">
                {/* 历史选题查重提醒 */}
                {detail.duplicates.length > 0 && (
                  <div className="alert-banner-warn" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <AlertTriangle size={16} />
                    <span>
                      历史选题查重提醒：与已有记录「<strong>{detail.duplicates[0].title}</strong>」（{detail.duplicates[0].status}）相似度达{' '}
                      <strong>{detail.duplicates[0].similarity}%</strong>，创作前注意切入差异化。
                    </span>
                  </div>
                )}

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                  <div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                      <span className="metric-chip">{PLATFORM_LABELS[detail.content.platform] || detail.content.platform}</span>
                      <span className="metric-chip">{CONTENT_TYPE_LABELS[detail.content.content_type] || detail.content.content_type}</span>
                      <span className="metric-chip">{detail.content.source_name}</span>
                      {detail.content.breakout_ratio != null && (
                        <span className="breakout-badge">异常倍数 {detail.content.breakout_ratio}x</span>
                      )}
                      <span style={{ fontSize: 12, color: 'var(--text-muted)', alignSelf: 'center' }}>
                        {fmtTime(detail.content.published_at || detail.content.discovered_at)}
                      </span>
                    </div>
                    <h3 style={{ margin: 0, fontSize: 17, lineHeight: 1.4 }}>{detail.content.title}</h3>
                  </div>
                  <a href={detail.content.canonical_url} target="_blank" rel="noreferrer" className="btn btn-secondary" style={{ flexShrink: 0, textDecoration: 'none' }}>
                    <ExternalLink size={14} /> 原链接
                  </a>
                </div>

                {/* 真实互动指标条（绝不造假，缺项清晰写“未提供”） */}
                <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginTop: 12 }}>
                  <span className="metric-chip">播放：{fmtNum(detail.metrics[detail.metrics.length - 1]?.views)}</span>
                  <span className="metric-chip">点赞：{fmtNum(detail.metrics[detail.metrics.length - 1]?.likes)}</span>
                  <span className="metric-chip">评论：{fmtNum(detail.metrics[detail.metrics.length - 1]?.comments)}</span>
                  <span className="metric-chip">收藏：{fmtNum(detail.metrics[detail.metrics.length - 1]?.favorites)}</span>
                  <span className="metric-chip">转发：{fmtNum(detail.metrics[detail.metrics.length - 1]?.shares)}</span>
                  <span className="metric-chip">博主粉丝：{fmtNum(detail.content.follower_count)}</span>
                </div>
                {detail.content.breakout_reason && (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
                    潜力基线说明：{detail.content.breakout_reason}
                  </div>
                )}

                {/* 一键动作条 */}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
                  <button
                    className="btn btn-primary"
                    disabled={busyAction !== null}
                    onClick={() =>
                      runAction('recommend', async () => {
                        const res = await apiRequest<{ cached: boolean }>(`/api/radar/intel/${detail.content.id}/recommend`, {
                          method: 'POST',
                          body: JSON.stringify({ accountId: activeAccountId, force: true }),
                        });
                        onToast(res.cached ? '命中 AI 缓存，已载入 6 维选题卡' : '已完成 AI 深度拆解与 6 维选题评分');
                      })
                    }
                  >
                    <Sparkles size={13} /> {busyAction === 'recommend' ? 'AI 分析中...' : 'AI 深度拆解 + 6维推荐'}
                  </button>
                  <button
                    className="btn btn-secondary"
                    disabled={busyAction !== null}
                    onClick={() =>
                      runAction('tingwu', async () => {
                        const res = await apiRequest<{ message: string }>(`/api/radar/intel/${detail.content.id}/transcribe`, {
                          method: 'POST',
                        });
                        onToast(res.message);
                      })
                    }
                  >
                    <Mic size={13} /> {busyAction === 'tingwu' ? '提交中...' : '通义听悟抽音频转写'}
                  </button>
                  {['douyin', 'bilibili', 'kuaishou'].includes(detail.content.platform) && (
                    <button
                      className="btn btn-secondary"
                      disabled={busyAction !== null}
                      onClick={() =>
                        runAction('comments', async () => {
                          const res = await apiRequest<{ message: string }>(`/api/radar/intel/${detail.content.id}/comments`, {
                            method: 'POST',
                          });
                          onToast(res.message);
                        })
                      }
                    >
                      <MessageSquareText size={13} /> {busyAction === 'comments' ? 'MediaCrawler 抓取中...' : 'MediaCrawler 抓热评'}
                    </button>
                  )}
                  <button className="btn btn-secondary" onClick={handleAddBoard}>
                    <BookmarkPlus size={13} /> 加入个人选题库
                  </button>
                  <button
                    className="btn btn-secondary"
                    onClick={() =>
                      onSendToPublish({
                        title: detail.recommendation?.recommended_title || detail.content.title,
                        tags: [detail.analysis?.category || '热点选题'],
                        sourceName: detail.content.source_name,
                        sourceUrl: detail.content.canonical_url,
                      })
                    }
                  >
                    <Send size={13} /> 送入视频发布
                  </button>
                </div>

                {/* 互动快照增长曲线（仅在有 >=2 次真实快照时显示） */}
                {metricChart.length >= 2 && (
                  <div style={{ marginTop: 14 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 6 }}>真实互动增长快照曲线（{metricChart.length} 个时间点）</div>
                    <div style={{ width: '100%', height: 150 }}>
                      <ResponsiveContainer>
                        <LineChart data={metricChart} margin={{ top: 5, right: 12, left: -12, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                          <XAxis dataKey="time" tick={{ fontSize: 10.5 }} />
                          <YAxis tick={{ fontSize: 10.5 }} />
                          <Tooltip />
                          <Line type="monotone" dataKey="likes" name="点赞" stroke="#ea580c" strokeWidth={2} />
                          <Line type="monotone" dataKey="comments" name="评论" stroke="#4f46e5" strokeWidth={2} />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                )}

                {/* 详情子页签 */}
                <div style={{ marginTop: 14, marginBottom: 12 }}>
                  <div className="sub-tabs">
                    <button className={`sub-tab-btn ${detailTab === 'ai' ? 'active' : ''}`} onClick={() => setDetailTab('ai')}>
                      AI 深度拆解 & 选题卡
                    </button>
                    <button className={`sub-tab-btn ${detailTab === 'transcript' ? 'active' : ''}`} onClick={() => setDetailTab('transcript')}>
                      听悟口播 / 正文 ({detail.content.transcript ? `${detail.content.transcript.length}字` : `${detail.content.body.length}字`})
                    </button>
                    <button className={`sub-tab-btn ${detailTab === 'comments' ? 'active' : ''}`} onClick={() => setDetailTab('comments')}>
                      真实热评 ({detail.comments.length})
                    </button>
                    <button className={`sub-tab-btn ${detailTab === 'sources' ? 'active' : ''}`} onClick={() => setDetailTab('sources')}>
                      同事件来源 ({detail.clusterSiblings.length + 1})
                    </button>
                  </div>
                </div>

                {detailTab === 'ai' && (
                  <div>
                    {!detail.analysis && !detail.recommendation ? (
                      <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '16px 0' }}>
                        尚未对此条内容运行 AI 深度拆解，点击上方「AI 深度拆解 + 6维推荐」即可生成（自动缓存不重复花钱）。
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13 }}>
                        {detail.recommendation && (
                          <div style={{ padding: 12, background: '#f5f7ff', borderRadius: 10, border: '1px solid #c7d2fe' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <strong>推荐标题：{detail.recommendation.recommended_title}</strong>
                              <span className="score-pill score-high">{detail.recommendation.score_total} 分</span>
                            </div>
                            <div style={{ marginTop: 6 }}><strong>核心观点：</strong>{detail.recommendation.core_viewpoint}</div>
                            <div style={{ marginTop: 4 }}><strong>差异化角度：</strong>{detail.recommendation.diff_angle}</div>
                            <div style={{ marginTop: 4 }}><strong>创作建议：</strong>{detail.recommendation.creation_advice}</div>
                            <div style={{ marginTop: 4, fontSize: 12, color: 'var(--text-muted)' }}>
                              <strong>热度依据：</strong>{detail.recommendation.heat_evidence}
                            </div>
                          </div>
                        )}
                        {detail.analysis && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                            <div><strong>中文摘要：</strong>{detail.analysis.summary_zh}</div>
                            <div><strong>趋势判断：</strong>{detail.analysis.trend_judgement || '—'} · <strong>推荐形式：</strong>{detail.analysis.content_form_advice || '—'}</div>
                            <div>
                              <strong>核心观点：</strong>
                              <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>
                                {safeJsonArray<string>(detail.analysis.core_points_json).map((p, i) => <li key={i}>{p}</li>)}
                              </ul>
                            </div>
                            <div>
                              <strong>受众需求：</strong>
                              {safeJsonArray<string>(detail.analysis.audience_needs_json).join(' ｜ ') || '—'}
                            </div>
                            <div>
                              <strong>评论区痛点挖掘：</strong>
                              {safeJsonArray<string>(detail.analysis.comment_pain_points_json).length > 0
                                ? safeJsonArray<string>(detail.analysis.comment_pain_points_json).join(' ｜ ')
                                : '未采集评论区（点击上方「MediaCrawler 抓热评」后再点一次 AI 拆解即可基于真实评论挖掘痛点）'}
                            </div>
                            <div>
                              <strong>差异化切入备选：</strong>
                              {safeJsonArray<string>(detail.analysis.diff_angles_json).join(' ｜ ') || '—'}
                            </div>
                            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                              材料依据：{detail.analysis.evidence_note}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {detailTab === 'transcript' && (
                  <div style={{ fontSize: 13 }}>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
                      听悟转录状态：<strong>{detail.content.transcript_status}</strong>
                      {detail.tingwuJobs[0]?.error_message ? `（${detail.tingwuJobs[0].error_message}）` : ''}
                    </div>
                    <pre
                      style={{
                        whiteSpace: 'pre-wrap',
                        background: 'var(--surface-muted)',
                        padding: 12,
                        borderRadius: 10,
                        maxHeight: 340,
                        overflowY: 'auto',
                        fontFamily: 'inherit',
                        margin: 0,
                      }}
                    >
                      {detail.content.transcript || detail.content.body || detail.content.summary || '（暂无正文或口播文字，视频类内容可点上方「通义听悟抽音频转写」）'}
                    </pre>
                  </div>
                )}

                {detailTab === 'comments' && (
                  <div>
                    {detail.comments.length === 0 ? (
                      <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '12px 0' }}>
                        暂未采集此作品评论。对于抖音、B站、快手作品，点击上方「MediaCrawler 抓热评」即可通过本机最新版 MediaCrawler 拉回真实高赞评论。
                      </div>
                    ) : (
                      detail.comments.map((cm) => (
                        <div key={cm.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: 'var(--text-muted)' }}>
                            <strong>{cm.author || '匿名用户'}</strong>
                            <span>👍 {cm.likes ?? 0} · {fmtTime(cm.published_at)}</span>
                          </div>
                          <div style={{ marginTop: 3 }}>{cm.text}</div>
                        </div>
                      ))
                    )}
                  </div>
                )}

                {detailTab === 'sources' && (
                  <div style={{ fontSize: 13 }}>
                    <div style={{ padding: '8px 10px', background: 'var(--surface-muted)', borderRadius: 8, marginBottom: 8 }}>
                      <strong>[当前条目 · {detail.content.source_name}]</strong> {detail.content.title}
                    </div>
                    {detail.clusterSiblings.map((s) => (
                      <div
                        key={s.id}
                        className="selectable-row"
                        onClick={() => setSelectedId(s.id)}
                      >
                        <strong>[{PLATFORM_LABELS[s.platform] || s.platform} · {s.source_name}]</strong> {s.title}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
