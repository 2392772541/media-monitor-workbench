import { useEffect, useState } from 'react';
import { Radar, Plus, Sparkles, Trash2, BellRing, BookmarkPlus, ExternalLink } from 'lucide-react';
import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts';
import { apiRequest, fmtNum, fmtTime, PLATFORM_LABELS, safeJsonArray } from '../api';
import type { TrackedTopic } from '../types';

interface TopicRadarPageProps {
  activeAccountId: number;
  onToast: (msg: string) => void;
  onOpenIntelDetail: (contentId: number) => void;
}

interface TopicDetailResp {
  topic: TrackedTopic;
  trend: Array<{ day: string; count: number; avgHeat: number }>;
  matches: Array<{
    id: number;
    content_id: number;
    match_mode: 'rule' | 'semantic' | 'both';
    relevance_score: number;
    match_reason: string;
    matched_at: string;
    title: string;
    platform: string;
    canonical_url: string;
    source_name: string;
    brief: string;
    breakout_ratio: number | null;
    latest_views: number | null;
    latest_likes: number | null;
    published_at: string | null;
    discovered_at: string;
  }>;
}

function splitTerms(raw: string): string[] {
  return raw
    .split(/[,，、\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function TopicRadarPage({ activeAccountId, onToast, onOpenIntelDetail }: TopicRadarPageProps) {
  const [topics, setTopics] = useState<TrackedTopic[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<TopicDetailResp | null>(null);
  const [scanningId, setScanningId] = useState<number | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [keywordsText, setKeywordsText] = useState('');
  const [relatedText, setRelatedText] = useState('');
  const [excludeText, setExcludeText] = useState('');
  const [description, setDescription] = useState('');
  const [threshold, setThreshold] = useState(3);

  const loadTopics = async () => {
    try {
      const list = await apiRequest<TrackedTopic[]>('/api/radar/topics');
      setTopics(list);
      if (list.length > 0 && (!selectedId || !list.some((x) => x.id === selectedId))) {
        setSelectedId(list[0].id);
      } else if (list.length === 0) {
        setSelectedId(null);
        setDetail(null);
      }
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  const loadDetail = async (id: number) => {
    try {
      const d = await apiRequest<TopicDetailResp>(`/api/radar/topics/${id}/detail`);
      setDetail(d);
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  useEffect(() => {
    void loadTopics();
  }, []);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
  }, [selectedId]);

  const handleCreate = async () => {
    if (!name.trim()) {
      onToast('请填写追踪话题名称');
      return;
    }
    try {
      const res = await apiRequest<{ topic: TrackedTopic }>('/api/radar/topics', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          domain: domain.trim(),
          keywords: splitTerms(keywordsText || name),
          related_terms: splitTerms(relatedText),
          exclude_terms: splitTerms(excludeText),
          description: description.trim(),
          alert_threshold: threshold,
        }),
      });
      onToast(`已创建追踪话题「${res.topic.name}」并完成首次规则扫描`);
      setName('');
      setDomain('');
      setKeywordsText('');
      setRelatedText('');
      setExcludeText('');
      setDescription('');
      setShowForm(false);
      await loadTopics();
      setSelectedId(res.topic.id);
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  const handleScan = async (id: number) => {
    setScanningId(id);
    try {
      const res = await apiRequest<{ ruleMatched: number; semanticMatched: number }>(`/api/radar/topics/${id}/scan`, {
        method: 'POST',
        body: JSON.stringify({ useSemanticAi: true }),
      });
      onToast(`扫描完成：规则命中 ${res.ruleMatched} 条，AI 语义新发现 ${res.semanticMatched} 条`);
      await loadTopics();
      if (selectedId === id) await loadDetail(id);
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setScanningId(null);
    }
  };

  const handleDelete = async (t: TrackedTopic) => {
    if (!window.confirm(`确定删除追踪话题「${t.name}」吗？`)) return;
    await apiRequest(`/api/radar/topics/${t.id}`, { method: 'DELETE' });
    onToast('已删除话题');
    void loadTopics();
  };

  const handleAddBoard = async (m: TopicDetailResp['matches'][number]) => {
    await apiRequest('/api/radar/board', {
      method: 'POST',
      body: JSON.stringify({
        title: m.title,
        account_id: activeAccountId,
        source_content_id: m.content_id,
        core_angle: `${detail?.topic.name || ''} 话题关联：${m.match_reason}`,
        tags: [detail?.topic.name || '话题雷达', PLATFORM_LABELS[m.platform] || m.platform],
        source_url: m.canonical_url,
      }),
    });
    onToast('已一键加入个人选题库');
  };

  return (
    <div>
      <div className="panel-card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div>
          <strong style={{ fontSize: 15 }}>自定义话题语义雷达</strong>
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 2 }}>
            支持主关键词 + 关联词 + 排除词 + AI 语义联想，不只靠字面匹配，自动统计 14 天热度曲线与预警。
          </div>
        </div>
        <button className="btn btn-primary" onClick={() => setShowForm((v) => !v)}>
          <Plus size={14} /> 新建追踪话题
        </button>
      </div>

      {showForm && (
        <div className="panel-card" style={{ borderColor: '#c7d2fe', background: '#fafbff' }}>
          <div className="panel-title" style={{ marginBottom: 10 }}>
            创建长期追踪话题
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
            <div>
              <label className="field-label">话题名称 *</label>
              <input className="input" placeholder="如：AI Agent 落地实战 / 柑橘转色增甜" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div>
              <label className="field-label">关注领域</label>
              <input className="input" placeholder="如：AI 应用 / 作物营养" value={domain} onChange={(e) => setDomain(e.target.value)} />
            </div>
            <div>
              <label className="field-label">7日预警阈值（命中条数）</label>
              <input className="input" type="number" min={1} max={100} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} />
            </div>
            <div>
              <label className="field-label">核心关键词（逗号分隔）</label>
              <input className="input" placeholder="如：Agent, 智能体, 工作流" value={keywordsText} onChange={(e) => setKeywordsText(e.target.value)} />
            </div>
            <div>
              <label className="field-label">关联词（逗号分隔）</label>
              <input className="input" placeholder="如：MCP, 自动化, 提效, 副业" value={relatedText} onChange={(e) => setRelatedText(e.target.value)} />
            </div>
            <div>
              <label className="field-label">排除词（逗号分隔，命中即剔除）</label>
              <input className="input" placeholder="如：招聘, 广告, 抽奖" value={excludeText} onChange={(e) => setExcludeText(e.target.value)} />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label className="field-label">AI 语义追踪说明（告诉大模型你真正想抓哪类隐性关联内容）</label>
              <textarea
                className="input"
                rows={2}
                placeholder="例如：即使标题没提 Agent，只要讲到用 AI 替代人工重复流程、自动跑通业务闭环的案例都算相关"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="btn btn-primary" onClick={handleCreate}>
              保存并开始追踪
            </button>
            <button className="btn btn-secondary" onClick={() => setShowForm(false)}>
              取消
            </button>
          </div>
        </div>
      )}

      <div className="split-workbench">
        {/* 左侧话题卡片 */}
        <div className="panel-card">
          <div className="panel-head">
            <div className="panel-title">
              <Radar size={16} color="#4f46e5" />
              <span>我的追踪话题 ({topics.length})</span>
            </div>
          </div>
          {topics.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '22px 6px', textAlign: 'center' }}>
              暂无自定义话题，点右上角创建一个长期关注词试试 AI 语义追踪。
            </div>
          ) : (
            topics.map((t) => {
              const alerted = t.recent_7d_matches >= t.alert_threshold;
              const kws = safeJsonArray<string>(t.keywords_json);
              return (
                <div
                  key={t.id}
                  className={`selectable-row ${selectedId === t.id ? 'selected' : ''}`}
                  onClick={() => setSelectedId(t.id)}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                    <strong style={{ fontSize: 14 }}>{t.name}</strong>
                    {alerted ? (
                      <span className="breakout-badge">
                        <BellRing size={11} /> 预警 · 近7日 {t.recent_7d_matches} 条
                      </span>
                    ) : (
                      <span className="metric-chip">近7日 {t.recent_7d_matches} 条</span>
                    )}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>
                    关键词：{kws.join('、') || '—'} {t.domain ? `· ${t.domain}` : ''}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>上次扫描：{fmtTime(t.last_scanned_at)}</span>
                    <div style={{ display: 'flex', gap: 6 }} onClick={(e) => e.stopPropagation()}>
                      <button
                        className="btn btn-primary"
                        style={{ padding: '3px 8px', fontSize: 11.5 }}
                        disabled={scanningId === t.id}
                        onClick={() => handleScan(t.id)}
                      >
                        <Sparkles size={11} /> {scanningId === t.id ? '语义扫描中...' : 'AI 语义扫描'}
                      </button>
                      <button
                        className="btn btn-secondary"
                        style={{ padding: '3px 7px', fontSize: 11.5, color: 'var(--danger)' }}
                        onClick={() => handleDelete(t)}
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* 右侧趋势图表与关联内容 */}
        <div>
          {!detail ? (
            <div className="panel-card" style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>
              在左侧选择一个追踪话题，即可查看 14 天传播趋势曲线和 AI 语义关联内容。
            </div>
          ) : (
            <>
              <div className="panel-card">
                <div className="panel-head">
                  <div>
                    <strong style={{ fontSize: 16 }}>{detail.topic.name}</strong>
                    {detail.topic.description && (
                      <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 3 }}>{detail.topic.description}</div>
                    )}
                  </div>
                  <button
                    className="btn btn-primary"
                    disabled={scanningId === detail.topic.id}
                    onClick={() => handleScan(detail.topic.id)}
                  >
                    <Sparkles size={13} /> {scanningId === detail.topic.id ? '语义扫描中...' : '执行规则+AI语义扫描'}
                  </button>
                </div>

                <div style={{ width: '100%', height: 210 }}>
                  <ResponsiveContainer>
                    <ComposedChart data={detail.trend} margin={{ top: 8, right: 12, left: -14, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                      <XAxis dataKey="day" tick={{ fontSize: 11, fill: '#64748b' }} />
                      <YAxis yAxisId="left" allowDecimals={false} tick={{ fontSize: 11, fill: '#64748b' }} />
                      <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11, fill: '#ea580c' }} />
                      <Tooltip />
                      <Bar yAxisId="left" dataKey="count" name="每日命中条数" fill="#818cf8" radius={[4, 4, 0, 0]} />
                      <Line yAxisId="right" type="monotone" dataKey="avgHeat" name="平均热度/相关度" stroke="#ea580c" strokeWidth={2} dot={{ r: 3 }} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div className="panel-card">
                <div className="panel-head">
                  <div className="panel-title">语义追踪关联内容 ({detail.matches.length})</div>
                </div>
                {detail.matches.length === 0 ? (
                  <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                    当前情报库暂无命中内容，点击上方「执行规则+AI语义扫描」或先去抓取更多博主和热榜内容。
                  </div>
                ) : (
                  detail.matches.map((m) => (
                    <div key={m.id} className="rec-card" style={{ padding: 12 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                          <span className={`score-pill ${m.relevance_score >= 80 ? 'score-high' : 'score-mid'}`} style={{ fontSize: 11.5 }}>
                            相关度 {m.relevance_score}
                          </span>
                          <span className="metric-chip">
                            {m.match_mode === 'semantic' ? '🧠 AI语义发现' : m.match_mode === 'both' ? '⚡ 规则+语义' : '🔍 关键词命中'}
                          </span>
                          <span className="metric-chip">{PLATFORM_LABELS[m.platform] || m.platform}</span>
                          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                            {m.source_name} · {fmtTime(m.published_at || m.discovered_at)}
                          </span>
                        </div>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button className="btn btn-primary" style={{ padding: '4px 8px', fontSize: 11.5 }} onClick={() => handleAddBoard(m)}>
                            <BookmarkPlus size={12} /> 选题
                          </button>
                          <a href={m.canonical_url} target="_blank" rel="noreferrer" className="btn btn-secondary" style={{ padding: '4px 7px', fontSize: 11.5 }}>
                            <ExternalLink size={12} />
                          </a>
                        </div>
                      </div>
                      <div
                        style={{ fontWeight: 700, fontSize: 14, marginTop: 6, cursor: 'pointer' }}
                        onClick={() => onOpenIntelDetail(m.content_id)}
                      >
                        {m.title}
                      </div>
                      <div style={{ fontSize: 12, color: '#4338ca', marginTop: 4 }}>{m.match_reason}</div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                        播放 {fmtNum(m.latest_views)} · 赞 {fmtNum(m.latest_likes)}
                        {m.breakout_ratio != null ? ` · 异常 ${m.breakout_ratio}x` : ''}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
