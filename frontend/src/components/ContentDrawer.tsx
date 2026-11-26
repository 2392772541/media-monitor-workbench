import { useEffect, useState } from 'react';
import {
  X,
  Star,
  ExternalLink,
  Send,
  Sparkles,
  Mic,
  MessageSquareText,
  RefreshCw,
  Copy,
  Check,
  Flame,
  Wand2,
} from 'lucide-react';
import { apiRequest, fmtNum, fmtTime, PLATFORM_LABELS, safeJsonArray } from '../api';
import type { MetricSnapshot, PublishInspirationDraft } from '../types';

export type DrawerTab = 'point' | 'transcript' | 'comments';

export interface DrawerTarget {
  contentId: number;
  initialTab?: DrawerTab;
  savedBoardId?: number | null;
}

interface ContentDrawerProps {
  target: DrawerTarget | null;
  onClose: () => void;
  onChanged: () => void;
  onSendToPublish: (draft: PublishInspirationDraft) => void;
  onOpenRemix?: (contentId: number) => void;
  onToast: (msg: string) => void;
}

interface DetailResp {
  content: {
    id: number;
    platform: string;
    canonical_url: string;
    title: string;
    author: string;
    source_name: string;
    summary: string;
    body: string;
    transcript: string;
    transcript_status: string;
    breakout_ratio: number | null;
    breakout_score: number | null;
    breakout_reason: string;
    follower_count: number | null;
    published_at: string | null;
    discovered_at: string;
  };
  metrics: MetricSnapshot[];
  comments: Array<{
    id: number;
    author: string;
    text: string;
    likes: number | null;
    published_at: string | null;
  }>;
  analysis: {
    category: string;
    summary_zh: string;
    core_points_json: string;
    diff_angles_json: string;
    trend_judgement: string;
    content_form_advice: string;
    analyzed_at: string;
  } | null;
  tingwuJobs: Array<{
    id: number;
    status: string;
    error_message: string | null;
    updated_at: string;
  }>;
}

const PLATFORM_COLORS: Record<string, string> = {
  bilibili: '#4f46e5',
  douyin: '#e11d48',
  youtube: '#dc2626',
  rss: '#0284c7',
  website: '#0d9488',
  x: '#0f172a',
};

export function ContentDrawer({
  target,
  onClose,
  onChanged,
  onSendToPublish,
  onOpenRemix,
  onToast,
}: ContentDrawerProps) {
  const [detail, setDetail] = useState<DetailResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<DrawerTab>('point');
  const [busy, setBusy] = useState<string | null>(null);
  const [savedBoardId, setSavedBoardId] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  // 加载内容详情与收藏状态
  const loadDetail = async (contentId: number) => {
    setLoading(true);
    try {
      const [d, boardRes] = await Promise.all([
        apiRequest<DetailResp>(`/api/radar/intel/${contentId}/detail`),
        apiRequest<{ items: Array<{ id: number; source_content_id: number | null; source_url: string }> }>('/api/radar/board'),
      ]);
      setDetail(d);
      const hit = boardRes.items.find(
        (b) => b.source_content_id === contentId || (d.content.canonical_url && b.source_url === d.content.canonical_url)
      );
      setSavedBoardId(hit ? hit.id : null);
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!target) {
      setDetail(null);
      return;
    }
    setTab(target.initialTab || 'point');
    setSavedBoardId(target.savedBoardId ?? null);
    void loadDetail(target.contentId);
  }, [target?.contentId, target?.initialTab]);

  // 当本机显卡正在后台抽音频/转写时，每 2.5 秒静默刷新一次进度直到出稿
  useEffect(() => {
    if (!target || !detail) return;
    const st = detail.content.transcript_status;
    const jobSt = detail.tingwuJobs[0]?.status;
    const inFlight = st === 'transcribing' || jobSt === 'downloading' || jobSt === 'uploading';
    if (!inFlight) return;
    const timer = setInterval(() => {
      void apiRequest<DetailResp>(`/api/radar/intel/${target.contentId}/detail`)
        .then((d) => {
          setDetail(d);
          if (d.content.transcript_status === 'done') {
            onToast('本机显卡口播逐字稿已转写完成！');
            onChanged();
          }
        })
        .catch(() => {});
    }, 2500);
    return () => clearInterval(timer);
  }, [target?.contentId, detail?.content.transcript_status, detail?.tingwuJobs?.[0]?.status]);

  // 支持按 Esc 快捷关闭抽屉
  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [target, onClose]);

  if (!target) return null;

  const latestMetric = detail?.metrics?.[detail.metrics.length - 1];
  const content = detail?.content;
  const analysis = detail?.analysis;
  const platColor = PLATFORM_COLORS[content?.platform || ''] || '#4f46e5';

  // 收藏 / 取消收藏
  const handleToggleSave = async () => {
    if (!content) return;
    setBusy('save');
    try {
      if (savedBoardId) {
        await apiRequest(`/api/radar/board/${savedBoardId}`, { method: 'DELETE' });
        setSavedBoardId(null);
        onToast('已从收藏本移除');
      } else {
        const res = await apiRequest<{ item: { id: number } }>('/api/radar/board', {
          method: 'POST',
          body: JSON.stringify({
            title: content.title,
            source_content_id: content.id,
            core_angle: analysis?.summary_zh || content.summary || '',
            tags: [PLATFORM_LABELS[content.platform] || content.platform, analysis?.category || ''].filter(Boolean),
            source_url: content.canonical_url,
          }),
        });
        setSavedBoardId(res.item.id);
        onToast('已收藏到「简易收藏本」');
      }
      onChanged();
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  // AI 一句话看点分析
  const handleAnalyze = async (force = false) => {
    if (!content) return;
    setBusy('analyze');
    try {
      const res = await apiRequest<{ cached?: boolean }>(`/api/radar/intel/${content.id}/analyze`, {
        method: 'POST',
        body: JSON.stringify({ force }),
      });
      onToast(res.cached ? '已载入缓存看点' : 'AI 看点提炼完成');
      await loadDetail(content.id);
      onChanged();
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  // 本机 RTX 显卡开源语音转写（免登录）
  const handleTranscribe = async () => {
    if (!content) return;
    setBusy('transcribe');
    try {
      const res = await apiRequest<{ message?: string }>(`/api/radar/intel/${content.id}/transcribe`, {
        method: 'POST',
      });
      onToast(res.message || '已启动本机显卡离线转写，约 10~25 秒自动出稿');
      await loadDetail(content.id);
      onChanged();
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  // 手动刷新最新转写状态
  const handleSyncTingwu = async () => {
    if (!content) return;
    setBusy('sync');
    try {
      await apiRequest('/api/radar/tingwu/sync', { method: 'POST' });
      await loadDetail(content.id);
      onToast('已刷新最新口播转写状态');
      onChanged();
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  // 抓取真实高赞热评（B站/抖音直连秒抓 + MediaCrawler 补全）
  const handleFetchComments = async () => {
    if (!content) return;
    setBusy('comments');
    try {
      const res = await apiRequest<{ message?: string }>(`/api/radar/intel/${content.id}/comments`, {
        method: 'POST',
      });
      onToast(res.message || '热评抓取完成');
      await loadDetail(content.id);
      onChanged();
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const handleCopyText = async (text: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      onToast('已复制口播逐字稿');
      setTimeout(() => setCopied(false), 1800);
    } catch {
      onToast('复制失败，请手动选中复制');
    }
  };

  const corePoints = safeJsonArray<string>(analysis?.core_points_json);
  const diffAngles = safeJsonArray<string>(analysis?.diff_angles_json);
  const canCrawlComments = content && ['douyin', 'bilibili', 'kuaishou'].includes(content.platform);
  const displayTranscript = content?.transcript || content?.body || content?.summary || '';

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer-panel" role="dialog" aria-label="内容深读抽屉">
        {/* 顶部固定头 */}
        <div className="drawer-head">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              {content && (
                <>
                  <span className="plat-badge" style={{ background: platColor }}>
                    {PLATFORM_LABELS[content.platform] || content.platform}
                  </span>
                  <span className="badge badge-gray">{content.author || content.source_name}</span>
                  {content.breakout_ratio != null && content.breakout_ratio >= 1.6 && (
                    <span className="breakout-badge">
                      <Flame size={12} /> {content.breakout_ratio}x 爆款
                    </span>
                  )}
                </>
              )}
            </div>
            <button className="btn btn-secondary btn-sm" onClick={onClose} aria-label="关闭抽屉">
              <X size={14} /> 关闭
            </button>
          </div>

          <h2 className="drawer-title">{content ? content.title : loading ? '正在加载详情...' : '未找到内容'}</h2>

          {content && (
            <>
              <div className="drawer-metrics">
                <span>播放 {fmtNum(latestMetric?.views)}</span>
                <span>·</span>
                <span>点赞 {fmtNum(latestMetric?.likes)}</span>
                <span>·</span>
                <span>评论 {fmtNum(latestMetric?.comments)}</span>
                <span>·</span>
                <span>收藏 {fmtNum(latestMetric?.favorites)}</span>
                <span>·</span>
                <span>{fmtTime(content.published_at || content.discovered_at)}</span>
              </div>

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                {onOpenRemix && (
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => onOpenRemix(content.id)}
                  >
                    <Wand2 size={13} /> 拆解与二创写稿
                  </button>
                )}
                <button
                  className={`btn btn-sm ${savedBoardId ? 'btn-star-active' : 'btn-secondary'}`}
                  disabled={busy === 'save'}
                  onClick={handleToggleSave}
                >
                  <Star size={13} fill={savedBoardId ? 'currentColor' : 'none'} />
                  {savedBoardId ? '已收藏' : '收藏到本子'}
                </button>
                <a
                  href={content.canonical_url}
                  target="_blank"
                  rel="noreferrer"
                  className="btn btn-secondary btn-sm"
                  style={{ textDecoration: 'none' }}
                >
                  <ExternalLink size={13} /> 打开原链接
                </a>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => {
                    onSendToPublish({
                      title: content.title,
                      tags: [analysis?.category || PLATFORM_LABELS[content.platform] || '热点'],
                      sourceName: content.source_name,
                      sourceUrl: content.canonical_url,
                    });
                    onClose();
                  }}
                >
                  <Send size={13} /> 去发布
                </button>
              </div>
            </>
          )}
        </div>

        {/* 3 个极简标签：看点 / 口播稿 / 热评 */}
        <div className="drawer-tabs">
          <button
            className={`drawer-tab ${tab === 'point' ? 'active' : ''}`}
            onClick={() => setTab('point')}
          >
            <Sparkles size={14} /> 一句话看点
          </button>
          <button
            className={`drawer-tab ${tab === 'transcript' ? 'active' : ''}`}
            onClick={() => setTab('transcript')}
          >
            <Mic size={14} /> 口播逐字稿
            {content?.transcript ? <span className="drawer-dot-ok" /> : null}
          </button>
          <button
            className={`drawer-tab ${tab === 'comments' ? 'active' : ''}`}
            onClick={() => setTab('comments')}
          >
            <MessageSquareText size={14} /> 真实热评 ({detail?.comments.length || 0})
          </button>
        </div>

        {/* 抽屉正文区 */}
        <div className="drawer-body">
          {loading && !detail ? (
            <div style={{ padding: 36, textAlign: 'center', color: 'var(--text-muted)' }}>加载内容中...</div>
          ) : !content ? (
            <div style={{ padding: 36, textAlign: 'center', color: 'var(--text-muted)' }}>内容不存在或已删除</div>
          ) : tab === 'point' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {analysis ? (
                <>
                  <div className="accent-box accent-indigo">
                    <div className="accent-box-label">一句话看点</div>
                    <div className="accent-box-text">{analysis.summary_zh || content.summary || '暂无摘要'}</div>
                  </div>
                  <div className="accent-box accent-amber">
                    <div className="accent-box-label">为什么这条值得看</div>
                    <div className="accent-box-text">
                      {analysis.trend_judgement || corePoints[0] || content.breakout_reason || '互动表现突出'}
                    </div>
                  </div>
                  <div className="accent-box accent-green">
                    <div className="accent-box-label">你可以怎么借势拍</div>
                    <div className="accent-box-text">
                      {diffAngles[0] || analysis.content_form_advice || '建议从普通人最关心的痛点直接给结论'}
                    </div>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      提炼于 {fmtTime(analysis.analyzed_at)}
                    </span>
                    <button
                      className="btn btn-secondary btn-sm"
                      disabled={busy === 'analyze'}
                      onClick={() => void handleAnalyze(true)}
                    >
                      <RefreshCw size={12} /> {busy === 'analyze' ? '重新生成中...' : '换个角度重提炼'}
                    </button>
                  </div>
                </>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {content.summary && (
                    <div className="accent-box accent-indigo">
                      <div className="accent-box-label">原始简介</div>
                      <div className="accent-box-text">{content.summary}</div>
                    </div>
                  )}
                  {content.breakout_reason && (
                    <div className="accent-box accent-amber">
                      <div className="accent-box-label">爆款数据说明</div>
                      <div className="accent-box-text">{content.breakout_reason}</div>
                    </div>
                  )}
                  <div style={{ padding: '18px 14px', background: 'var(--surface-muted)', borderRadius: 10, textAlign: 'center' }}>
                    <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 10 }}>
                      还没生成 AI 一句话看点，点一下自动提炼核心亮点与借势思路
                    </div>
                    <button
                      className="btn btn-primary"
                      disabled={busy === 'analyze'}
                      onClick={() => void handleAnalyze(false)}
                    >
                      <Sparkles size={14} /> {busy === 'analyze' ? 'AI 提炼中...' : 'AI 一句话提炼看点'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : tab === 'transcript' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  状态：
                  <strong style={{ color: content.transcript_status === 'done' ? 'var(--success)' : 'var(--text)' }}>
                    {content.transcript_status === 'done'
                      ? '已完成本机显卡转写'
                      : detail?.tingwuJobs?.[0]?.status === 'downloading'
                        ? '第 1/2 步：免登录提取视频纯音频...'
                        : detail?.tingwuJobs?.[0]?.status === 'uploading' || content.transcript_status === 'transcribing'
                          ? '第 2/2 步：RTX 显卡高速离线转写中（自动刷新）...'
                          : content.transcript_status === 'failed'
                            ? '上次转写未完成（可重试）'
                            : '暂未转写'}
                  </strong>
                </span>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={busy === 'transcribe' || content.transcript_status === 'transcribing'}
                    onClick={() => void handleTranscribe()}
                  >
                    <Mic size={13} /> {busy === 'transcribe' || content.transcript_status === 'transcribing' ? '显卡转写中...' : '本机显卡转口播稿 (免登录)'}
                  </button>
                  <button
                    className="btn btn-secondary btn-sm"
                    disabled={busy === 'sync'}
                    onClick={() => void handleSyncTingwu()}
                  >
                    <RefreshCw size={12} /> 刷新
                  </button>
                  {displayTranscript && (
                    <button className="btn btn-secondary btn-sm" onClick={() => void handleCopyText(displayTranscript)}>
                      {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? '已复制' : '复制'}
                    </button>
                  )}
                </div>
              </div>

              {detail?.tingwuJobs?.[0]?.error_message && (
                <div className="alert-banner-warn" style={{ marginBottom: 0 }}>
                  <span>{detail.tingwuJobs[0].error_message.replace(/^LOGIN_REQUIRED:\s*/, '')}</span>
                </div>
              )}

              <div className="transcript-box">
                {content.transcript ? (
                  content.transcript
                ) : displayTranscript ? (
                  <>
                    <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 8 }}>
                      （当前显示原网页正文/摘要，点击上方「本机显卡转口播稿」即可免登录提取纯视频逐字稿）
                    </div>
                    {displayTranscript}
                  </>
                ) : (
                  <span style={{ color: 'var(--text-muted)' }}>
                    暂无口播稿。点击上方「本机显卡转口播稿 (免登录)」会自动用本机 RTX 显卡提取无时间轴逐字稿，永久免费不掉线。
                  </span>
                )}
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  抖音 / B站直连抓取真实高赞热评（按点赞从高到低）
                </span>
                {canCrawlComments ? (
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={busy === 'comments'}
                    onClick={() => void handleFetchComments()}
                  >
                    <RefreshCw size={12} /> {busy === 'comments' ? '正在抓取热评...' : '抓取真实热评'}
                  </button>
                ) : (
                  <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>当前支持抖音 / B站 / 快手</span>
                )}
              </div>

              {detail && detail.comments.length > 0 ? (
                <div className="feed-list">
                  {detail.comments.map((cm) => (
                    <div key={cm.id} className="comment-row">
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                        <strong>{cm.author || '匿名观众'}</strong>
                        <span style={{ color: '#ea580c', fontWeight: 600 }}>
                          👍 {cm.likes ?? 0} · <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>{fmtTime(cm.published_at)}</span>
                        </span>
                      </div>
                      <div style={{ fontSize: 13, lineHeight: 1.55, color: '#334155' }}>{cm.text}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ padding: '24px 12px', textAlign: 'center', color: 'var(--text-muted)', background: 'var(--surface-muted)', borderRadius: 10 }}>
                  {canCrawlComments
                    ? '还没抓过这条作品的评论，点右上角「抓取真实热评」就能把高赞评论拉回来。'
                    : '该来源暂不支持自动抓取评论，可点击顶部「打开原链接」查看。'}
                </div>
              )}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
