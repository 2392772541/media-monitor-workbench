import { useEffect, useState } from 'react';
import {
  Sparkles,
  Flame,
  TrendingUp,
  BookmarkPlus,
  Send,
  RefreshCw,
  ExternalLink,
  Layers,
  BellRing,
  Sliders,
  Compass,
} from 'lucide-react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts';
import { apiRequest, FEEDBACK_LABELS, fmtNum, fmtTime, PLATFORM_LABELS, safeJsonArray } from '../api';
import type { CockpitData, PublishInspirationDraft, TopicRecommendation } from '../types';

interface CockpitPageProps {
  activeAccountId: number;
  onNavigate: (tab: string) => void;
  onOpenAccountModal: () => void;
  onSendToPublish: (draft: PublishInspirationDraft) => void;
  onOpenIntelDetail: (contentId: number) => void;
  onToast: (msg: string) => void;
}

export function CockpitPage({
  activeAccountId,
  onNavigate,
  onOpenAccountModal,
  onSendToPublish,
  onOpenIntelDetail,
  onToast,
}: CockpitPageProps) {
  const [data, setData] = useState<CockpitData | null>(null);
  const [loading, setLoading] = useState(true);
  const [runningAi, setRunningAi] = useState(false);
  const [refreshingHot, setRefreshingHot] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const qs = activeAccountId ? `?accountId=${activeAccountId}` : '';
      const res = await apiRequest<CockpitData>(`/api/radar/cockpit${qs}`);
      setData(res);
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [activeAccountId]);

  const handleBatchRecommend = async () => {
    setRunningAi(true);
    try {
      const res = await apiRequest<{ processed: number; cachedHits: number; errors: string[] }>(
        '/api/radar/recommendations/batch',
        {
          method: 'POST',
          body: JSON.stringify({ accountId: activeAccountId, limit: 8 }),
        }
      );
      onToast(
        `AI 选题推荐完成：评估 ${res.processed} 条（缓存命中 ${res.cachedHits} 条）${res.errors.length ? `，失败 ${res.errors.length} 条` : ''}`
      );
      await load();
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setRunningAi(false);
    }
  };

  const handleRefreshHot = async () => {
    setRefreshingHot(true);
    try {
      const res = await apiRequest<{ totalSaved: number; aiScored: number }>('/api/radar/hot-board/refresh', {
        method: 'POST',
        body: JSON.stringify({ scoreWithAi: true, accountId: activeAccountId }),
      });
      onToast(`热榜已刷新：拉取 ${res.totalSaved} 条真实热榜，AI 相关性筛分 ${res.aiScored} 条`);
      await load();
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setRefreshingHot(false);
    }
  };

  const handleAddToBoard = async (rec: TopicRecommendation) => {
    try {
      const res = await apiRequest<{ duplicates: Array<{ title: string; similarity: number }> }>('/api/radar/board', {
        method: 'POST',
        body: JSON.stringify({
          title: rec.recommended_title,
          account_id: rec.account_id,
          source_content_id: rec.content_id,
          recommendation_id: rec.id,
          cluster_id: rec.cluster_id,
          core_angle: `${rec.core_viewpoint}\n切入角度：${rec.diff_angle}\n创作建议：${rec.creation_advice}`,
          tags: [rec.suitable_format, PLATFORM_LABELS[rec.platform || ''] || rec.platform || ''].filter(Boolean),
          priority: rec.score_total >= 78 ? 'high' : 'medium',
          source_url: rec.canonical_url || '',
          references: safeJsonArray(rec.reference_sources_json),
        }),
      });
      if (res.duplicates.length > 0) {
        onToast(`已加入选题库！提示：与历史选题「${res.duplicates[0].title}」相似度 ${res.duplicates[0].similarity}%`);
      } else {
        onToast('已一键加入「个人选题库」（状态：待研究）');
      }
      await load();
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  const handleFeedback = async (recId: number, status: string) => {
    try {
      await apiRequest(`/api/radar/recommendations/${recId}/feedback`, {
        method: 'POST',
        body: JSON.stringify({ status }),
      });
      onToast(`已标记「${FEEDBACK_LABELS[status] || status}」，后续推荐会自动参考此偏好`);
      await load();
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  if (loading && !data) {
    return <div className="panel-card">正在加载选题驾驶舱...</div>;
  }
  if (!data) {
    return <div className="panel-card">加载驾驶舱失败，请刷新重试。</div>;
  }

  const acc = data.activeAccount;
  const triggeredAlerts = data.topicAlerts.filter((t) => t.recent_hits >= t.alert_threshold);

  return (
    <div>
      {/* 顶部账号定位摘要与快捷动作栏 */}
      <div
        className="panel-card"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 14,
          flexWrap: 'wrap',
          background: 'linear-gradient(135deg, #ffffff 0%, #f5f7ff 100%)',
        }}
      >
        <div style={{ minWidth: 260, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span className="score-pill score-mid">当前视角</span>
            <strong style={{ fontSize: 16 }}>{acc.name}</strong>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>({acc.platform_focus})</span>
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 5 }}>
            赛道：{acc.niche || '未填写'} · 受众：{acc.target_audience || '未填写'}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>
            权重：定位 {acc.weight_match} / 热度 {acc.weight_heat} / 差异化 {acc.weight_diff} / 经验 {acc.weight_experience} / 时效{' '}
            {acc.weight_timeliness} / 可行性 {acc.weight_feasibility} · AI 引擎：
            <strong style={{ color: data.aiHealth.configured ? 'var(--success)' : 'var(--danger)' }}>
              {data.aiHealth.configured ? `${data.aiHealth.model}（缓存 ${data.aiHealth.okReceipts} 次）` : '未配置 Key'}
            </strong>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-secondary" onClick={onOpenAccountModal}>
            <Sliders size={14} /> 账号定位与权重
          </button>
          <button className="btn btn-secondary" disabled={refreshingHot} onClick={handleRefreshHot}>
            <Flame size={14} /> {refreshingHot ? '抓热榜中...' : '刷新全平台热榜'}
          </button>
          <button className="btn btn-primary" disabled={runningAi} onClick={handleBatchRecommend}>
            <Sparkles size={14} /> {runningAi ? 'AI 分析推题中...' : '生成今日推荐选题'}
          </button>
        </div>
      </div>

      {/* KPI 概况条 */}
      <div className="kpi-strip">
        <div className="kpi-tile" style={{ cursor: 'pointer' }} onClick={() => onNavigate('intel')}>
          <div className="kpi-tile-label">
            <span>今日新入库情报</span>
            <TrendingUp size={15} color="#4f46e5" />
          </div>
          <div className="kpi-tile-val">{data.stats.todayNew}</div>
          <div className="kpi-tile-sub">情报库累计 {data.stats.totalContents} 条</div>
        </div>
        <div className="kpi-tile" style={{ cursor: 'pointer' }} onClick={() => onNavigate('intel')}>
          <div className="kpi-tile-label">
            <span>识别潜力爆款</span>
            <Flame size={15} color="#ea580c" />
          </div>
          <div className="kpi-tile-val" style={{ color: '#ea580c' }}>
            {data.stats.breakoutCount}
          </div>
          <div className="kpi-tile-sub">相对博主常态倍数 ≥ 1.6x</div>
        </div>
        <div className="kpi-tile" style={{ cursor: 'pointer' }} onClick={() => onNavigate('creators')}>
          <div className="kpi-tile-label">
            <span>监控博主与源</span>
            <Compass size={15} color="#0284c7" />
          </div>
          <div className="kpi-tile-val">{data.stats.totalSources}</div>
          <div className="kpi-tile-sub">行业热榜已收 {data.stats.hotBoardCount} 条</div>
        </div>
        <div className="kpi-tile" style={{ cursor: 'pointer' }} onClick={() => onNavigate('radar')}>
          <div className="kpi-tile-label">
            <span>话题雷达预警</span>
            <BellRing size={15} color="#d97706" />
          </div>
          <div className="kpi-tile-val" style={{ color: triggeredAlerts.length ? '#d97706' : 'var(--text)' }}>
            {triggeredAlerts.length}
          </div>
          <div className="kpi-tile-sub">活跃追踪话题 {data.topicAlerts.length} 个</div>
        </div>
        <div className="kpi-tile" style={{ cursor: 'pointer' }} onClick={() => onNavigate('board')}>
          <div className="kpi-tile-label">
            <span>选题库推进中</span>
            <BookmarkPlus size={15} color="#16a34a" />
          </div>
          <div className="kpi-tile-val" style={{ color: '#16a34a' }}>
            {data.stats.boardActiveCount}
          </div>
          <div className="kpi-tile-sub">待研究 / 创作 / 待发布</div>
        </div>
      </div>

      <div className="cockpit-grid">
        {/* 左主栏：今日推荐选题 + 7日趋势曲线 */}
        <div>
          <div className="panel-card">
            <div className="panel-head">
              <div className="panel-title">
                <Sparkles size={17} color="#4f46e5" />
                <span>今日智能推荐选题（6 维加权排序）</span>
              </div>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                所有评分均基于真实指标与素材，绝不编造播放/趋势
              </span>
            </div>

            {data.recommendations.length === 0 ? (
              <div style={{ padding: '26px 12px', textAlign: 'center', color: 'var(--text-muted)' }}>
                <div style={{ marginBottom: 10 }}>
                  还没有生成当前账号的推荐选题。先在「博主监控」或「行业热榜」抓回真实内容，再点击右上角「生成今日推荐选题」。
                </div>
                <div style={{ display: 'flex', justifyContent: 'center', gap: 10 }}>
                  <button className="btn btn-secondary" onClick={() => onNavigate('creators')}>
                    去添加监控博主
                  </button>
                  <button className="btn btn-secondary" onClick={() => onNavigate('hotboard')}>
                    去抓行业热榜
                  </button>
                </div>
              </div>
            ) : (
              data.recommendations.map((rec) => {
                const scoreCls = rec.score_total >= 78 ? 'score-high' : rec.score_total >= 60 ? 'score-mid' : 'score-low';
                const refs = safeJsonArray<{ title: string; url: string; source: string }>(rec.reference_sources_json);
                const dims = [
                  { k: '定位匹配', v: rec.score_match },
                  { k: '热度增长', v: rec.score_heat },
                  { k: '差异空间', v: rec.score_diff },
                  { k: '个人经验', v: rec.score_experience },
                  { k: '时效性', v: rec.score_timeliness },
                  { k: '可行性', v: rec.score_feasibility },
                ];

                return (
                  <div key={rec.id} className="rec-card">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 5 }}>
                          <span className={`score-pill ${scoreCls}`}>{rec.score_total} 分</span>
                          <span className="metric-chip">{PLATFORM_LABELS[rec.platform || ''] || rec.platform}</span>
                          {rec.suitable_format && <span className="metric-chip">{rec.suitable_format}</span>}
                          {rec.breakout_ratio != null && rec.breakout_ratio >= 1.6 && (
                            <span className="breakout-badge">🔥 异常 {rec.breakout_ratio}x</span>
                          )}
                          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                            来源：{rec.source_name} · {fmtTime(rec.published_at || rec.discovered_at)}
                          </span>
                        </div>
                        <div
                          style={{ fontSize: 15.5, fontWeight: 700, color: 'var(--text)', cursor: 'pointer' }}
                          onClick={() => onOpenIntelDetail(rec.content_id)}
                        >
                          {rec.recommended_title}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                        <button
                          className="btn btn-primary"
                          style={{ padding: '5px 10px', fontSize: 12 }}
                          onClick={() => handleAddToBoard(rec)}
                        >
                          <BookmarkPlus size={13} /> {(rec.in_board_count || 0) > 0 ? '已在选题库' : '入选题库'}
                        </button>
                        <button
                          className="btn btn-secondary"
                          style={{ padding: '5px 9px', fontSize: 12 }}
                          onClick={() =>
                            onSendToPublish({
                              title: rec.recommended_title,
                              tags: [rec.suitable_format || '爆款选题'],
                              sourceName: rec.source_name,
                              sourceUrl: rec.canonical_url,
                            })
                          }
                        >
                          <Send size={13} /> 发布
                        </button>
                      </div>
                    </div>

                    <div style={{ fontSize: 13, marginTop: 8, color: '#1e293b' }}>
                      <strong>核心观点：</strong>
                      {rec.core_viewpoint || rec.recommend_reason}
                    </div>
                    <div style={{ fontSize: 12.5, marginTop: 5, color: '#334155' }}>
                      <strong>差异化切入：</strong>
                      {rec.diff_angle || '—'}
                    </div>
                    <div style={{ fontSize: 12.5, marginTop: 4, color: '#475569' }}>
                      <strong>创作建议：</strong>
                      {rec.creation_advice || '—'}
                    </div>
                    <div style={{ fontSize: 12, marginTop: 5, color: 'var(--text-muted)' }}>
                      <strong>热度依据：</strong>
                      {rec.heat_evidence}（播放 {fmtNum(rec.latest_views)} · 赞 {fmtNum(rec.latest_likes)} · 评{' '}
                      {fmtNum(rec.latest_comments)}）
                    </div>

                    <div className="dim-bars">
                      {dims.map((d) => (
                        <div key={d.k} className="dim-row">
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span style={{ color: 'var(--text-muted)' }}>{d.k}</span>
                            <strong>{d.v}</strong>
                          </div>
                          <div className="dim-bar-track">
                            <div className="dim-bar-fill" style={{ width: `${Math.min(100, d.v)}%` }} />
                          </div>
                        </div>
                      ))}
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <div className="feedback-strip">
                        {Object.entries(FEEDBACK_LABELS).map(([key, label]) => (
                          <button
                            key={key}
                            className={`fb-chip ${rec.feedback_status === key ? 'active' : ''}`}
                            onClick={() => handleFeedback(rec.id, key)}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      <div style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 12 }}>
                        <button
                          className="btn-link"
                          style={{ background: 'none', border: 'none', color: 'var(--primary)', cursor: 'pointer', fontSize: 12 }}
                          onClick={() => onOpenIntelDetail(rec.content_id)}
                        >
                          查看情报详情 & 评论/听悟
                        </button>
                        {refs[0]?.url && (
                          <a href={refs[0].url} target="_blank" rel="noreferrer" style={{ color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                            原链接 <ExternalLink size={12} />
                          </a>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* 7 日采集量与潜力爆款趋势图 */}
          <div className="panel-card">
            <div className="panel-head">
              <div className="panel-title">
                <TrendingUp size={17} color="#4f46e5" />
                <span>近 7 日监控情报与潜力爆款趋势</span>
              </div>
              <button className="btn btn-secondary" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => void load()}>
                <RefreshCw size={12} /> 刷新
              </button>
            </div>
            <div style={{ width: '100%', height: 210 }}>
              <ResponsiveContainer>
                <AreaChart data={data.trend7d} margin={{ top: 8, right: 12, left: -18, bottom: 0 }}>
                  <defs>
                    <linearGradient id="gradTotal" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#6366f1" stopOpacity={0.28} />
                      <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="gradBreak" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#ea580c" stopOpacity={0.32} />
                      <stop offset="95%" stopColor="#ea580c" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="day" tick={{ fontSize: 12, fill: '#64748b' }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: '#64748b' }} />
                  <Tooltip />
                  <Area type="monotone" dataKey="total" name="新增情报" stroke="#4f46e5" fill="url(#gradTotal)" strokeWidth={2} />
                  <Area type="monotone" dataKey="breakouts" name="潜力爆款" stroke="#ea580c" fill="url(#gradBreak)" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>

        {/* 右副栏：潜力爆款雷达 + 话题聚簇 + 重要动态 */}
        <div>
          <div className="panel-card">
            <div className="panel-head">
              <div className="panel-title">
                <Flame size={17} color="#ea580c" />
                <span>潜力爆款雷达</span>
              </div>
              <button
                className="btn btn-secondary"
                style={{ fontSize: 12, padding: '4px 9px' }}
                onClick={() => onNavigate('creators')}
              >
                博主基线
              </button>
            </div>
            {data.breakouts.length === 0 ? (
              <div style={{ fontSize: 12.5, color: 'var(--text-muted)', padding: '8px 0' }}>
                当某个博主积累满 3 条带互动数据的作品后，系统会自动识别相对常态异常增长的作品（不按纯绝对点赞拍脑袋）。
              </div>
            ) : (
              data.breakouts.map((b) => (
                <div
                  key={b.id}
                  className="selectable-row"
                  onClick={() => onOpenIntelDetail(b.id)}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <span className="breakout-badge">
                      {b.breakout_ratio != null ? `${b.breakout_ratio}x 常态` : `潜力 ${b.breakout_score}`}
                    </span>
                    <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                      {PLATFORM_LABELS[b.platform] || b.platform} · {b.source_name}
                    </span>
                  </div>
                  <div style={{ fontWeight: 600, fontSize: 13.5, lineHeight: 1.4 }}>{b.title}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>{b.breakout_reason}</div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                    <span className="metric-chip">播放 {fmtNum(b.latest_views)}</span>
                    <span className="metric-chip">赞 {fmtNum(b.latest_likes)}</span>
                    <span className="metric-chip">评 {fmtNum(b.latest_comments)}</span>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="panel-card">
            <div className="panel-head">
              <div className="panel-title">
                <Layers size={17} color="#7c3aed" />
                <span>多源热点聚簇</span>
              </div>
              <button
                className="btn btn-secondary"
                style={{ fontSize: 12, padding: '4px 9px' }}
                onClick={() => onNavigate('intel')}
              >
                全部聚簇
              </button>
            </div>
            {data.clusters.length === 0 ? (
              <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
                点击「生成今日推荐选题」后会自动把多博主讨论的同一事件合并成话题聚簇。
              </div>
            ) : (
              data.clusters.map((cl) => (
                <div
                  key={cl.id}
                  style={{ padding: '9px 0', borderBottom: '1px solid var(--border)' }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                    <strong style={{ fontSize: 13.5 }}>{cl.title}</strong>
                    <span className="metric-chip">{cl.source_count} 个来源</span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>{cl.summary}</div>
                </div>
              ))
            )}
          </div>

          <div className="panel-card">
            <div className="panel-head">
              <div className="panel-title">
                <BellRing size={17} color="#d97706" />
                <span>重要动态时间线</span>
              </div>
            </div>
            {data.recentItems.length === 0 ? (
              <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>暂无监控动态。</div>
            ) : (
              data.recentItems.map((it) => (
                <div
                  key={it.id}
                  style={{ padding: '8px 0', borderBottom: '1px solid var(--border)', cursor: 'pointer' }}
                  onClick={() => onOpenIntelDetail(it.id)}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: 'var(--text-muted)' }}>
                    <span>
                      {PLATFORM_LABELS[it.platform] || it.platform} · {it.source_name}
                    </span>
                    <span>{fmtTime(it.published_at || it.discovered_at)}</span>
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 600, marginTop: 2 }}>{it.title}</div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
