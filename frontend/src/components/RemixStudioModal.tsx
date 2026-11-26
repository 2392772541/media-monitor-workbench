import { useEffect, useState } from 'react';
import {
  X,
  Sparkles,
  Mic,
  Copy,
  Check,
  Send,
  Star,
  Flame,
  RefreshCw,
  FileText,
  Wand2,
  ExternalLink,
} from 'lucide-react';
import { apiRequest, fmtNum, PLATFORM_LABELS } from '../api';
import type { ContentRemixRecord, PublishInspirationDraft, RemixScriptDraft } from '../types';

interface RemixStudioModalProps {
  contentId: number | null;
  onClose: () => void;
  onChanged: () => void;
  onSendToPublish: (draft: PublishInspirationDraft) => void;
  onToast: (msg: string) => void;
}

interface ContentDetailLite {
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
    breakout_reason: string;
  };
  metrics: Array<{ views: number | null; likes: number | null; comments: number | null; favorites: number | null }>;
  tingwuJobs: Array<{ status: string; error_message: string | null }>;
}

const TONE_OPTIONS = ['接地气大白话', '硬核干货拆解', '犀利反常识', '轻松聊天风'] as const;
const LENGTH_OPTIONS = ['60秒短视频', '2分钟干货', '3分钟深度'] as const;

export function RemixStudioModal({
  contentId,
  onClose,
  onChanged,
  onSendToPublish,
  onToast,
}: RemixStudioModalProps) {
  const [detail, setDetail] = useState<ContentDetailLite | null>(null);
  const [record, setRecord] = useState<ContentRemixRecord | null>(null);
  const [leftTab, setLeftTab] = useState<'breakdown' | 'transcript'>('breakdown');
  const [loading, setLoading] = useState(false);

  const [busyBreakdown, setBusyBreakdown] = useState(false);
  const [busyRewrite, setBusyRewrite] = useState(false);
  const [busyTranscribe, setBusyTranscribe] = useState(false);
  const [savingBoard, setSavingBoard] = useState(false);

  const [angle, setAngle] = useState('');
  const [tone, setTone] = useState<string>('接地气大白话');
  const [lengthLabel, setLengthLabel] = useState<string>('2分钟干货');
  const [extraInstruction, setExtraInstruction] = useState('');

  const [activeDraftId, setActiveDraftId] = useState<string>('');
  const [editTitle, setEditTitle] = useState('');
  const [editScript, setEditScript] = useState('');
  const [editTags, setEditTags] = useState<string[]>([]);
  const [shootingTips, setShootingTips] = useState<string[]>([]);
  const [copiedScript, setCopiedScript] = useState(false);

  const applyDraftToEditor = (d: RemixScriptDraft | undefined) => {
    if (!d) {
      setActiveDraftId('');
      setEditTitle('');
      setEditScript('');
      setEditTags([]);
      setShootingTips([]);
      return;
    }
    setActiveDraftId(d.id);
    setEditTitle(d.newTitle);
    setEditScript(d.scriptText);
    setEditTags(d.tags || []);
    setShootingTips(d.shootingTips || []);
  };

  const loadAll = async (cid: number) => {
    setLoading(true);
    try {
      const [d, r] = await Promise.all([
        apiRequest<ContentDetailLite>(`/api/radar/intel/${cid}/detail`),
        apiRequest<{ record: ContentRemixRecord }>(`/api/radar/intel/${cid}/remix`),
      ]);
      setDetail(d);
      setRecord(r.record);
      if (r.record.breakdown?.remixAngles?.[0] && !angle) {
        const first = r.record.breakdown.remixAngles[0];
        setAngle(`${first.title}（${first.angle}）`);
      }
      if (r.record.drafts.length > 0) {
        applyDraftToEditor(r.record.drafts[0]);
      } else {
        applyDraftToEditor(undefined);
      }
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!contentId) {
      setDetail(null);
      setRecord(null);
      setAngle('');
      setExtraInstruction('');
      applyDraftToEditor(undefined);
      return;
    }
    setLeftTab('breakdown');
    void loadAll(contentId);
  }, [contentId]);

  // 如果本机显卡正在扒口播稿，每 2.5 秒自动轮询直到出稿
  useEffect(() => {
    if (!contentId || !detail) return;
    const st = detail.content.transcript_status;
    const jobSt = detail.tingwuJobs?.[0]?.status;
    const inFlight = st === 'transcribing' || jobSt === 'downloading' || jobSt === 'uploading';
    if (!inFlight) return;
    const timer = window.setInterval(() => {
      void apiRequest<ContentDetailLite>(`/api/radar/intel/${contentId}/detail`)
        .then((d) => {
          setDetail(d);
          if (d.content.transcript_status === 'done') {
            onToast('口播逐字稿已提取完成，现在拆解和二创会更精准！');
            onChanged();
          }
        })
        .catch(() => {});
    }, 2500);
    return () => window.clearInterval(timer);
  }, [contentId, detail?.content.transcript_status, detail?.tingwuJobs?.[0]?.status]);

  // Esc 快捷关闭
  useEffect(() => {
    if (!contentId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [contentId, onClose]);

  if (!contentId) return null;

  const content = detail?.content;
  const latest = detail?.metrics?.[detail.metrics.length - 1];
  const hasTranscript = Boolean(content?.transcript && content.transcript.trim().length >= 40);
  const isTranscribing = content?.transcript_status === 'transcribing';
  const breakdown = record?.breakdown || null;

  const handleStartTranscribe = async () => {
    if (!content) return;
    setBusyTranscribe(true);
    try {
      const res = await apiRequest<{ message?: string }>(`/api/radar/intel/${content.id}/transcribe`, { method: 'POST' });
      onToast(res.message || '已启动本机显卡离线转写');
      const d = await apiRequest<ContentDetailLite>(`/api/radar/intel/${content.id}/detail`);
      setDetail(d);
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setBusyTranscribe(false);
    }
  };

  const handleBreakdown = async (forceRefresh = false) => {
    if (!content) return;
    setBusyBreakdown(true);
    try {
      const res = await apiRequest<{ record: ContentRemixRecord }>(`/api/radar/intel/${content.id}/remix`, {
        method: 'POST',
        body: JSON.stringify({ mode: 'breakdown', forceRefresh }),
      });
      setRecord(res.record);
      if (res.record.breakdown?.remixAngles?.[0]) {
        const first = res.record.breakdown.remixAngles[0];
        setAngle(`${first.title}（${first.angle}）`);
      }
      onToast('爆款结构拆解完成！点下方任意二创角度就能一键写新稿');
      onChanged();
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setBusyBreakdown(false);
    }
  };

  const handleGenerateRewrite = async (forceRefresh = false) => {
    if (!content) return;
    setBusyRewrite(true);
    try {
      const res = await apiRequest<{ draft: RemixScriptDraft; record: ContentRemixRecord }>(
        `/api/radar/intel/${content.id}/remix`,
        {
          method: 'POST',
          body: JSON.stringify({
            mode: 'rewrite',
            angle: angle.trim() || '保留核心话题但换一个更痛点直击、更接地气的新视角',
            tone,
            lengthLabel,
            extraInstruction: extraInstruction.trim() || undefined,
            forceRefresh,
          }),
        }
      );
      setRecord(res.record);
      applyDraftToEditor(res.draft);
      onToast('二创原创口播稿已写好，可以直接微调或一键送去视频发布！');
      onChanged();
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setBusyRewrite(false);
    }
  };

  const handleCopyScript = async () => {
    if (!editScript.trim()) return;
    const text = editTitle.trim() ? `${editTitle.trim()}\n\n${editScript.trim()}` : editScript.trim();
    try {
      await navigator.clipboard.writeText(text);
      setCopiedScript(true);
      onToast('已复制二创口播稿（可直接贴进提词器）');
      window.setTimeout(() => setCopiedScript(false), 1800);
    } catch {
      onToast('复制失败，请手动选中复制');
    }
  };

  const handleSaveToBoard = async () => {
    if (!content || !editScript.trim()) return;
    setSavingBoard(true);
    try {
      await apiRequest('/api/radar/board', {
        method: 'POST',
        body: JSON.stringify({
          title: editTitle.trim() || content.title,
          source_content_id: content.id,
          core_angle: angle.trim() || '二创口播成稿',
          notes: editScript.trim(),
          tags: editTags.length > 0 ? editTags : [PLATFORM_LABELS[content.platform] || content.platform, '二创成稿'],
          source_url: content.canonical_url,
          status: 'to_create',
        }),
      });
      onToast('已将这篇二创口播稿存入「简易收藏本」');
      onChanged();
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setSavingBoard(false);
    }
  };

  const handleSendDraftToPublish = () => {
    if (!content) return;
    const scriptBody = editScript.trim() || content.transcript || content.summary || content.title;
    onSendToPublish({
      title: editTitle.trim() || content.title,
      tags: editTags.length > 0 ? editTags : [PLATFORM_LABELS[content.platform] || '爆款二创'],
      script: scriptBody,
      sourceName: `二创自 · ${content.source_name}`,
      sourceUrl: content.canonical_url,
    });
    onClose();
  };

  // 按正常口播语速约 260 字/分钟估算时长
  const charCount = editScript.replace(/\s+/g, '').length;
  const estSeconds = Math.round((charCount / 260) * 60);
  const estDurationText =
    charCount === 0
      ? ''
      : estSeconds >= 60
        ? `约 ${Math.floor(estSeconds / 60)} 分 ${estSeconds % 60} 秒`
        : `约 ${estSeconds} 秒`;

  return (
    <div className="modal-backdrop" onClick={onClose} style={{ zIndex: 60 }}>
      <div className="remix-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="爆款拆解与二创写稿工坊">
        {/* 顶部栏 */}
        <div className="remix-head">
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
              <span className="badge badge-blue">
                <Wand2 size={12} style={{ marginRight: 4 }} /> 爆款拆解 & 二创写稿工坊
              </span>
              {content && (
                <>
                  <span className="badge badge-gray">{PLATFORM_LABELS[content.platform] || content.platform} · {content.source_name}</span>
                  {content.breakout_ratio != null && content.breakout_ratio >= 1.6 && (
                    <span className="breakout-badge">
                      <Flame size={12} /> {content.breakout_ratio}x 爆款
                    </span>
                  )}
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {latest?.views != null ? `播放 ${fmtNum(latest.views)} · ` : ''}
                    点赞 {fmtNum(latest?.likes)} · 评论 {fmtNum(latest?.comments)}
                  </span>
                </>
              )}
            </div>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)', lineHeight: 1.4 }}>
              {content ? content.title : loading ? '正在加载原视频资料...' : '未找到作品'}
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            {content && !hasTranscript && (
              <button
                type="button"
                className="btn btn-sm"
                disabled={busyTranscribe || isTranscribing}
                onClick={() => void handleStartTranscribe()}
              >
                <Mic size={13} /> {isTranscribing ? '显卡转口播中...' : '先用显卡扒原口播稿'}
              </button>
            )}
            {content?.canonical_url && (
              <a
                href={content.canonical_url}
                target="_blank"
                rel="noreferrer"
                className="btn btn-sm"
                style={{ textDecoration: 'none' }}
              >
                <ExternalLink size={13} /> 原视频
              </a>
            )}
            <button type="button" className="btn btn-sm" onClick={onClose}>
              <X size={14} /> 关闭
            </button>
          </div>
        </div>

        {/* 主体左右分栏：左拆原爆款 / 右写我的二创口播稿 */}
        <div className="remix-split">
          {/* 左栏：原视频拆解与口播全文 */}
          <div className="remix-col">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
              <div className="pill-group">
                <button
                  type="button"
                  className={`pill-btn ${leftTab === 'breakdown' ? 'active' : ''}`}
                  onClick={() => setLeftTab('breakdown')}
                >
                  <Sparkles size={13} /> AI 爆款拆解
                </button>
                <button
                  type="button"
                  className={`pill-btn ${leftTab === 'transcript' ? 'active' : ''}`}
                  onClick={() => setLeftTab('transcript')}
                >
                  <FileText size={13} /> 原口播稿 {hasTranscript ? `(${content?.transcript.length}字)` : '(待提取)'}
                </button>
              </div>
              {leftTab === 'breakdown' && (
                <button
                  type="button"
                  data-testid="remix-breakdown-btn"
                  className="btn btn-primary btn-sm"
                  disabled={busyBreakdown || !content}
                  onClick={() => void handleBreakdown(Boolean(breakdown))}
                >
                  <Sparkles size={13} /> {busyBreakdown ? 'AI 正在拆解...' : breakdown ? '重新拆解' : '一键 AI 拆解爆款结构'}
                </button>
              )}
            </div>

            {leftTab === 'breakdown' ? (
              breakdown ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {!breakdown.usedTranscript && (
                    <div className="alert-banner-warn" style={{ marginBottom: 0 }}>
                      本次拆解基于标题与简介；若想按逐字原话拆解，可点右上角「先用显卡扒原口播稿」再重拆。
                    </div>
                  )}

                  <div className="accent-box accent-indigo">
                    <div className="accent-box-label">黄金前 3 秒钩子拆解</div>
                    <div className="accent-box-text">{breakdown.hookAnalysis}</div>
                  </div>

                  <div className="accent-box accent-amber">
                    <div className="accent-box-label">爆款骨架公式（可套用结构）</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
                      {breakdown.structureSteps.map((st, idx) => (
                        <div key={idx} style={{ fontSize: 12.5, lineHeight: 1.5, color: '#334155' }}>
                          <strong>{idx + 1}. {st.stage}：</strong>
                          {st.summary}
                          {st.technique && <span style={{ color: '#92400e' }}>（技巧：{st.technique}）</span>}
                        </div>
                      ))}
                    </div>
                  </div>

                  {breakdown.viralDrivers.length > 0 && (
                    <div className="accent-box accent-green">
                      <div className="accent-box-label">为什么这条会爆</div>
                      <ul className="comments-ai-ul">
                        {breakdown.viralDrivers.map((d, i) => (
                          <li key={i}>{d}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div>
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text)', marginBottom: 6 }}>
                      点击下面任意二创角度，直接带入右侧写稿：
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                      {breakdown.remixAngles.map((item, idx) => {
                        const val = `${item.title}（${item.angle}）`;
                        const picked = angle === val;
                        return (
                          <button
                            key={idx}
                            type="button"
                            className={`remix-angle-btn ${picked ? 'active' : ''}`}
                            onClick={() => setAngle(val)}
                          >
                            <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--text)' }}>
                              角度 {idx + 1}：{item.title}
                            </div>
                            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                              {item.angle} {item.whyBetter ? `· 优势：${item.whyBetter}` : ''}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="remix-empty-card">
                  <Sparkles size={26} color="#4f46e5" style={{ marginBottom: 8 }} />
                  <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text)' }}>先拆透它为什么爆，再动笔二创</div>
                  <div style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '6px 0 14px', maxWidth: 340 }}>
                    {hasTranscript
                      ? '已检测到完整视频口播逐字稿，点下方按钮直接拆出开头钩子、骨架公式和 3 个差异化二创角度。'
                      : '可以先点右上角用本机显卡免登录扒出完整口播稿，也可以直接基于标题和简介快速拆解。'}
                  </div>
                  <button
                    type="button"
                    data-testid="remix-breakdown-cta"
                    className="btn btn-primary"
                    disabled={busyBreakdown || !content}
                    onClick={() => void handleBreakdown(false)}
                  >
                    <Sparkles size={14} /> {busyBreakdown ? 'AI 正在拆解...' : '一键 AI 拆解爆款结构'}
                  </button>
                </div>
              )
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {hasTranscript ? '本机 RTX 显卡已提取完整口播原文' : '暂未提取完整口播，下方为原视频简介'}
                  </span>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busyTranscribe || isTranscribing}
                    onClick={() => void handleStartTranscribe()}
                  >
                    <RefreshCw size={12} /> {isTranscribing ? '显卡转写中...' : hasTranscript ? '重新转写' : '本机显卡免费提取'}
                  </button>
                </div>
                <div className="transcript-box" style={{ maxHeight: 440, flex: 1 }}>
                  {content?.transcript || content?.body || content?.summary || '暂无文案内容'}
                </div>
              </div>
            )}
          </div>

          {/* 右栏：一键生成我的原创二创口播稿 */}
          <div className="remix-col">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 8, flexWrap: 'wrap' }}>
              <div style={{ fontWeight: 700, fontSize: 14.5, color: 'var(--text)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <Wand2 size={15} color="#4f46e5" /> 我的原创二创口播稿
              </div>
              {record && record.drafts.length > 1 && (
                <select
                  className="select"
                  style={{ width: 170, padding: '5px 8px', fontSize: 12 }}
                  value={activeDraftId}
                  onChange={(e) => {
                    const found = record.drafts.find((d) => d.id === e.target.value);
                    applyDraftToEditor(found);
                  }}
                >
                  {record.drafts.map((d, i) => (
                    <option key={d.id} value={d.id}>
                      版本 {record.drafts.length - i}：{d.newTitle.slice(0, 12)}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div style={{ display: 'grid', gap: 10, marginBottom: 12 }}>
              <div>
                <label className="form-label" style={{ fontSize: 12 }}>1. 我的二创切入角度（可点左侧推荐角度，或自己改写）</label>
                <input
                  className="input"
                  data-testid="remix-angle-input"
                  value={angle}
                  onChange={(e) => setAngle(e.target.value)}
                  placeholder="例如：针对普通上班族，把高门槛工具换成 3 个零成本免费平替方案"
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 5 }}>2. 说话口吻</div>
                  <div className="pill-group">
                    {TONE_OPTIONS.map((t) => (
                      <button
                        key={t}
                        type="button"
                        className={`pill-btn ${tone === t ? 'active' : ''}`}
                        onClick={() => setTone(t)}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 5 }}>3. 目标时长</div>
                  <div className="pill-group">
                    {LENGTH_OPTIONS.map((len) => (
                      <button
                        key={len}
                        type="button"
                        className={`pill-btn ${lengthLabel === len ? 'active' : ''}`}
                        onClick={() => setLengthLabel(len)}
                      >
                        {len}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  className="input"
                  value={extraInstruction}
                  onChange={(e) => setExtraInstruction(e.target.value)}
                  placeholder="可选补充（例如：结尾引导评论区扣 1 领资料 / 结合我自己的实战案例）"
                />
                <button
                  type="button"
                  data-testid="remix-generate-btn"
                  className="btn btn-primary"
                  disabled={busyRewrite || !content}
                  onClick={() => void handleGenerateRewrite(true)}
                >
                  <Sparkles size={14} /> {busyRewrite ? '正在写新口播稿...' : editScript ? '重新写一版' : '一键生成二创口播稿'}
                </button>
              </div>
            </div>

            {editScript ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, flex: 1 }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>建议新标题（可直接改）</div>
                  <input
                    className="input"
                    data-testid="remix-result-title"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                  />
                </div>

                <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                    <span style={{ fontWeight: 600 }}>提词器级口播逐字稿（已去脚本标记，张嘴就能念）</span>
                    <span style={{ color: 'var(--text-muted)' }}>
                      {charCount} 字 {estDurationText ? `· ${estDurationText}` : ''}
                    </span>
                  </div>
                  <textarea
                    className="textarea"
                    data-testid="remix-result-script"
                    rows={11}
                    style={{ flex: 1, lineHeight: 1.7, fontSize: 13.5 }}
                    value={editScript}
                    onChange={(e) => setEditScript(e.target.value)}
                  />
                </div>

                {shootingTips.length > 0 && (
                  <div style={{ fontSize: 12, color: '#4338ca', background: '#eef2ff', padding: '8px 12px', borderRadius: 8 }}>
                    <strong>拍摄小贴士：</strong>{shootingTips.join('；')}
                  </div>
                )}

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap', paddingTop: 4 }}>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button type="button" className="btn btn-sm" onClick={() => void handleCopyScript()}>
                      {copiedScript ? <Check size={13} /> : <Copy size={13} />} {copiedScript ? '已复制' : '复制口播稿'}
                    </button>
                    <button type="button" className="btn btn-sm" disabled={savingBoard} onClick={() => void handleSaveToBoard()}>
                      <Star size={13} /> {savingBoard ? '保存中...' : '存入收藏本'}
                    </button>
                  </div>
                  <button
                    type="button"
                    data-testid="remix-to-publish-btn"
                    className="btn btn-primary btn-sm"
                    onClick={handleSendDraftToPublish}
                  >
                    <Send size={13} /> 带稿去「视频发布」自动写四平台标题标签
                  </button>
                </div>
              </div>
            ) : (
              <div className="remix-empty-card">
                <Wand2 size={26} color="#4f46e5" style={{ marginBottom: 8 }} />
                <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text)' }}>选好角度与口吻，一键生成你的原创口播稿</div>
                <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 6, maxWidth: 360 }}>
                  不会照抄原博主句子，而是套用爆款结构按你的切入角度重写，生成后可直接复制到提词器，或一键带去「视频发布」自动配四平台标题标签。
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
