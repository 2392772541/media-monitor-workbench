import { useEffect, useMemo, useState } from 'react';
import {
  Bot,
  CheckCircle2,
  Clock,
  Flame,
  MessageCircleReply,
  Pause,
  Play,
  RefreshCw,
  Send,
  Settings2,
  ShieldAlert,
  Sparkles,
  XCircle,
} from 'lucide-react';
import { apiRequest, fmtNum, fmtTime } from '../api';
import type {
  CommentGuardLogItem,
  CommentGuardOverview,
  CommentGuardSettings,
  CreatorPublishedVideo,
  CreatorVideoComment,
  WarmupCommentItem,
  WarmupJobItem,
} from '../types';

type SubTab = 'inbox' | 'warmup' | 'settings' | 'logs';

const PLATFORM_META: Record<number, { label: string; badge: string }> = {
  3: { label: '抖音', badge: 'badge-red' },
  4: { label: '快手', badge: 'badge-amber' },
  1: { label: '小红书', badge: 'badge-pink' },
  2: { label: '微信视频号', badge: 'badge-green' },
};

const REPLY_STATUS_META: Record<string, { label: string; badge: string }> = {
  pending: { label: '待生成回复', badge: 'badge-amber' },
  draft_ready: { label: '待你确认发出', badge: 'badge-blue' },
  replied: { label: '已自动回复', badge: 'badge-green' },
  skipped_spam: { label: '已拦截广告/无效', badge: 'badge-gray' },
  skipped_author: { label: '作者自己的评论', badge: 'badge-gray' },
  skipped_already_replied: { label: '平台已有作者回复', badge: 'badge-gray' },
  ignored: { label: '已手动忽略', badge: 'badge-gray' },
  failed: { label: '发送失败', badge: 'badge-red' },
};

const WARMUP_STATUS_META: Record<string, { label: string; badge: string }> = {
  queued: { label: '排队等待发出', badge: 'badge-blue' },
  pending_approval: { label: '待你确认发出', badge: 'badge-amber' },
  running: { label: '正在发送中', badge: 'badge-blue' },
  done: { label: '已全部发出', badge: 'badge-green' },
  partial: { label: '部分发出', badge: 'badge-amber' },
  failed: { label: '发送失败', badge: 'badge-red' },
  cancelled: { label: '已取消', badge: 'badge-gray' },
};

function pMeta(pType: number | null | undefined) {
  if (!pType) return { label: '全局', badge: 'badge-gray' };
  return PLATFORM_META[pType] || { label: `平台(${pType})`, badge: 'badge-gray' };
}

export function CommentGuardPage({
  onToast,
  onNavigate,
}: {
  onToast: (msg: string) => void;
  onNavigate?: (tab: string) => void;
}) {
  const [subTab, setSubTab] = useState<SubTab>('inbox');
  const [overview, setOverview] = useState<CommentGuardOverview | null>(null);
  const [comments, setComments] = useState<CreatorVideoComment[]>([]);
  const [warmups, setWarmups] = useState<WarmupJobItem[]>([]);
  const [videos, setVideos] = useState<CreatorPublishedVideo[]>([]);
  const [logs, setLogs] = useState<CommentGuardLogItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [patrolling, setPatrolling] = useState(false);

  // 收件箱筛选与行内编辑草稿
  const [platformFilter, setPlatformFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [searchText, setSearchText] = useState('');
  const [replyDrafts, setReplyDrafts] = useState<Record<number, string>>({});
  const [busyCommentId, setBusyCommentId] = useState<number | null>(null);

  // 暖评队列行内编辑与手动创建暖评
  const [warmupDrafts, setWarmupDrafts] = useState<Record<number, WarmupCommentItem[]>>({});
  const [busyWarmupId, setBusyWarmupId] = useState<number | null>(null);
  const [manualPlatform, setManualPlatform] = useState<number>(3);
  const [manualVideoId, setManualVideoId] = useState<string>('');
  const [manualVideoTitle, setManualVideoTitle] = useState<string>('');
  const [manualVideoScript, setManualVideoScript] = useState<string>('');
  const [manualCount, setManualCount] = useState<number>(3);
  const [manualStyle, setManualStyle] = useState<'debate' | 'insight' | 'poll'>('debate');
  const [manualComments, setManualComments] = useState<Array<{ angle: string; text: string }>>([]);
  const [previewingManual, setPreviewingManual] = useState(false);
  const [creatingManual, setCreatingManual] = useState(false);

  // 规则设置表单
  const [form, setForm] = useState<CommentGuardSettings | null>(null);
  const [spamText, setSpamText] = useState('');
  const [forbiddenText, setForbiddenText] = useState('');
  const [savingSettings, setSavingSettings] = useState(false);

  const loadAll = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (platformFilter !== 'all') qs.set('platformType', platformFilter);
      if (statusFilter !== 'all') qs.set('status', statusFilter);
      if (searchText.trim()) qs.set('q', searchText.trim());

      const [ov, cm, wm, vd, lg] = await Promise.all([
        apiRequest<CommentGuardOverview>('/api/comment-guard/overview'),
        apiRequest<{ items: CreatorVideoComment[] }>(`/api/comment-guard/comments?${qs.toString()}`),
        apiRequest<{ items: WarmupJobItem[] }>('/api/comment-guard/warmups?limit=40'),
        apiRequest<{ items: CreatorPublishedVideo[] }>('/api/comment-guard/videos?limit=40'),
        apiRequest<{ items: CommentGuardLogItem[] }>('/api/comment-guard/logs?limit=60'),
      ]);

      setOverview(ov);
      setComments(cm.items || []);
      setWarmups(wm.items || []);
      setVideos(vd.items || []);
      setLogs(lg.items || []);

      setForm((prev) => {
        if (prev && silent) return prev;
        setSpamText((ov.settings.spamKeywords || []).join('，'));
        setForbiddenText((ov.settings.forbiddenReplyWords || []).join('，'));
        return ov.settings;
      });
    } catch (err) {
      if (!silent) onToast((err as Error).message);
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    void loadAll();
  }, []);

  useEffect(() => {
    const qs = new URLSearchParams();
    if (platformFilter !== 'all') qs.set('platformType', platformFilter);
    if (statusFilter !== 'all') qs.set('status', statusFilter);
    if (searchText.trim()) qs.set('q', searchText.trim());
    apiRequest<{ items: CreatorVideoComment[] }>(`/api/comment-guard/comments?${qs.toString()}`)
      .then((res) => setComments(res.items || []))
      .catch(() => {});
  }, [platformFilter, statusFilter, searchText]);

  const handleToggleMaster = async () => {
    if (!overview) return;
    const nextEnabled = !overview.settings.enabled;
    try {
      const res = await apiRequest<{ ok: boolean; settings: CommentGuardSettings }>('/api/comment-guard/settings', {
        method: 'PATCH',
        body: JSON.stringify({ enabled: nextEnabled }),
      });
      setOverview((prev) => (prev ? { ...prev, settings: res.settings } : prev));
      setForm(res.settings);
      onToast(nextEnabled ? '已开启评论自动托管（发片自动暖评 + 定时巡检自动回复）' : '已一键暂停全部自动暖评与自动回复');
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  const handleQuickModeSwitch = async (nextMode: 'auto' | 'draft') => {
    try {
      const res = await apiRequest<{ ok: boolean; settings: CommentGuardSettings }>('/api/comment-guard/settings', {
        method: 'PATCH',
        body: JSON.stringify({ mode: nextMode }),
      });
      setOverview((prev) => (prev ? { ...prev, settings: res.settings } : prev));
      setForm(res.settings);
      onToast(nextMode === 'auto' ? '已切到「全自动发出去」模式（自带限速防风控）' : '已切到「先写草稿我确认再发」模式');
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  const handleRunPatrol = async (syncOnly = false) => {
    setPatrolling(true);
    try {
      const res = await apiRequest<{ ok: boolean; message: string }>('/api/comment-guard/patrol', {
        method: 'POST',
        body: JSON.stringify({ syncOnly }),
      });
      onToast(res.message);
      await loadAll(true);
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setPatrolling(false);
    }
  };

  const handleRegenerateReply = async (commentId: number) => {
    setBusyCommentId(commentId);
    try {
      const res = await apiRequest<{ ok: boolean; comment: CreatorVideoComment }>(
        `/api/comment-guard/comments/${commentId}/regenerate`,
        { method: 'POST' }
      );
      setComments((prev) => prev.map((c) => (c.id === commentId ? res.comment : c)));
      setReplyDrafts((prev) => ({ ...prev, [commentId]: res.comment.ai_reply_text }));
      onToast('已让 AI 重新拟好一条自然回复');
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setBusyCommentId(null);
    }
  };

  const handleSendReply = async (c: CreatorVideoComment) => {
    const text = (replyDrafts[c.id] ?? c.ai_reply_text ?? '').trim();
    if (!text) {
      onToast('回复内容不能为空，点「AI 重写」或手动填一句再发');
      return;
    }
    setBusyCommentId(c.id);
    try {
      const res = await apiRequest<{ ok: boolean; message: string; comment?: CreatorVideoComment }>(
        `/api/comment-guard/comments/${c.id}/send`,
        {
          method: 'POST',
          body: JSON.stringify({ replyText: text }),
        }
      );
      onToast(res.message);
      if (res.comment) {
        setComments((prev) => prev.map((item) => (item.id === c.id ? res.comment! : item)));
      }
      await loadAll(true);
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setBusyCommentId(null);
    }
  };

  const handleIgnoreComment = async (commentId: number) => {
    setBusyCommentId(commentId);
    try {
      await apiRequest(`/api/comment-guard/comments/${commentId}/ignore`, { method: 'POST' });
      onToast('已忽略该条评论，以后不会再自动回复');
      await loadAll(true);
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setBusyCommentId(null);
    }
  };

  const handlePickVideoForManualWarmup = async (v: CreatorPublishedVideo) => {
    setManualPlatform(v.platform_type);
    setManualVideoId(v.platform_video_id);
    setManualVideoTitle(v.title);
    setManualVideoScript('');
    setPreviewingManual(true);
    try {
      const res = await apiRequest<{ ok: boolean; comments: WarmupCommentItem[] }>('/api/comment-guard/warmups/preview', {
        method: 'POST',
        body: JSON.stringify({
          platformType: v.platform_type,
          videoTitle: v.title,
          count: manualCount,
          style: manualStyle,
        }),
      });
      setManualComments((res.comments || []).map((c) => ({ angle: c.angle, text: c.text })));
      onToast('已为这条视频生成暖场讨论评论，确认后可一键发出');
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setPreviewingManual(false);
    }
  };

  const handlePreviewManualWarmup = async () => {
    if (!manualVideoTitle.trim()) {
      onToast('请先从下方选一条视频，或输入视频标题');
      return;
    }
    setPreviewingManual(true);
    try {
      const res = await apiRequest<{ ok: boolean; comments: WarmupCommentItem[] }>('/api/comment-guard/warmups/preview', {
        method: 'POST',
        body: JSON.stringify({
          platformType: manualPlatform,
          videoTitle: manualVideoTitle.trim(),
          videoScript: manualVideoScript.trim(),
          count: manualCount,
          style: manualStyle,
        }),
      });
      setManualComments((res.comments || []).map((c) => ({ angle: c.angle, text: c.text })));
      onToast('AI 已生成暖场讨论评论');
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setPreviewingManual(false);
    }
  };

  const handleCreateManualWarmup = async (sendNow: boolean) => {
    if (!manualVideoTitle.trim()) {
      onToast('请先填写目标视频标题');
      return;
    }
    setCreatingManual(true);
    try {
      const res = await apiRequest<{ ok: boolean; runResult?: { message?: string } }>('/api/comment-guard/warmups', {
        method: 'POST',
        body: JSON.stringify({
          platformType: manualPlatform,
          videoId: manualVideoId,
          videoTitle: manualVideoTitle.trim(),
          videoScript: manualVideoScript.trim(),
          comments: manualComments.filter((c) => c.text.trim()),
          count: manualCount,
          style: manualStyle,
          sendNow,
        }),
      });
      onToast(sendNow ? res.runResult?.message || '暖场评论已提交发送' : '已加入暖评任务队列');
      setManualComments([]);
      setManualVideoId('');
      await loadAll(true);
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setCreatingManual(false);
    }
  };

  const handleSaveWarmupEdits = async (job: WarmupJobItem) => {
    const edited = warmupDrafts[job.id];
    if (!edited) return;
    setBusyWarmupId(job.id);
    try {
      await apiRequest(`/api/comment-guard/warmups/${job.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ comments: edited }),
      });
      onToast('暖评文案修改已保存');
      await loadAll(true);
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setBusyWarmupId(null);
    }
  };

  const handleRegenerateWarmup = async (jobId: number) => {
    setBusyWarmupId(jobId);
    try {
      const res = await apiRequest<{ ok: boolean; job: WarmupJobItem }>(`/api/comment-guard/warmups/${jobId}/regenerate`, {
        method: 'POST',
      });
      setWarmups((prev) => prev.map((w) => (w.id === jobId ? res.job : w)));
      setWarmupDrafts((prev) => {
        const next = { ...prev };
        delete next[jobId];
        return next;
      });
      onToast('已重新生成一批暖场评论');
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setBusyWarmupId(null);
    }
  };

  const handleRunWarmupNow = async (jobId: number) => {
    setBusyWarmupId(jobId);
    try {
      const res = await apiRequest<{ ok: boolean; message: string }>(`/api/comment-guard/warmups/${jobId}/run`, {
        method: 'POST',
        body: JSON.stringify({ dryRun: false }),
      });
      onToast(res.message);
      await loadAll(true);
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setBusyWarmupId(null);
    }
  };

  const handleCancelWarmup = async (jobId: number) => {
    setBusyWarmupId(jobId);
    try {
      await apiRequest(`/api/comment-guard/warmups/${jobId}/cancel`, { method: 'POST' });
      onToast('已取消该条暖评排队任务');
      await loadAll(true);
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setBusyWarmupId(null);
    }
  };

  const handleSaveSettings = async () => {
    if (!form) return;
    setSavingSettings(true);
    try {
      const payload: Partial<CommentGuardSettings> = {
        ...form,
        spamKeywords: spamText
          .split(/[\n,，、;；]+/)
          .map((x) => x.trim())
          .filter(Boolean),
        forbiddenReplyWords: forbiddenText
          .split(/[\n,，、;；]+/)
          .map((x) => x.trim())
          .filter(Boolean),
      };
      const res = await apiRequest<{ ok: boolean; settings: CommentGuardSettings }>('/api/comment-guard/settings', {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      setForm(res.settings);
      setOverview((prev) => (prev ? { ...prev, settings: res.settings } : prev));
      onToast('评论托管规则与防风控设置已保存生效');
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setSavingSettings(false);
    }
  };

  const actionableCount = useMemo(
    () => (overview?.stats.pendingCount || 0) + (overview?.stats.failedCount || 0),
    [overview]
  );

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {/* 顶部总控栏 */}
      <div className="publish-hero">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              background: overview?.settings.enabled ? 'var(--success-soft)' : 'var(--warn-soft)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <Bot size={22} color={overview?.settings.enabled ? '#16a34a' : '#d97706'} />
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 16, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              自有视频评论托管中心
              <span className={`badge ${overview?.settings.enabled ? 'badge-green' : 'badge-amber'}`}>
                {overview?.settings.enabled ? '● 自动托管运行中' : '● 已暂停托管'}
              </span>
              <span className={`badge ${overview?.settings.mode === 'auto' ? 'badge-blue' : 'badge-gray'}`}>
                {overview?.settings.mode === 'auto' ? '全自动回复（带防风控间隔）' : '先写草稿你确认再发'}
              </span>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 4, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <span>每 {overview?.settings.patrolIntervalMinutes ?? 20} 分钟自动巡检</span>
              <span>· 上次巡检：{fmtTime(overview?.runtime.lastPatrolAt)}</span>
              {overview?.runtime.nextPatrolAt && <span>· 下次预计：{fmtTime(overview.runtime.nextPatrolAt)}</span>}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button
            data-testid="comment-guard-toggle-btn"
            className={`btn btn-sm ${overview?.settings.enabled ? 'btn-danger' : 'btn-primary'}`}
            onClick={() => void handleToggleMaster()}
          >
            {overview?.settings.enabled ? (
              <>
                <Pause size={13} /> 一键暂停自动回复
              </>
            ) : (
              <>
                <Play size={13} /> 恢复自动托管
              </>
            )}
          </button>
          <button
            data-testid="comment-guard-patrol-btn"
            className="btn btn-primary btn-sm"
            disabled={patrolling}
            onClick={() => void handleRunPatrol(false)}
          >
            <RefreshCw size={13} className={patrolling ? 'spin' : ''} /> {patrolling ? '正在巡检各平台...' : '立即巡检一次'}
          </button>
          <button className="btn btn-sm" disabled={patrolling} onClick={() => void handleRunPatrol(true)}>
            仅同步评论（不发送）
          </button>
          <button className="btn btn-sm" disabled={loading} onClick={() => void loadAll()}>
            刷新界面
          </button>
        </div>
      </div>

      {/* 四大实时数据卡 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12 }}>
        <div className="card" style={{ padding: 14 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>今日自动回复粉丝</div>
          <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4, color: 'var(--success)' }}>
            {overview?.stats.todayReplied ?? 0}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
            累计已回复 {overview?.stats.totalReplied ?? 0} 条
          </div>
        </div>
        <div className="card" style={{ padding: 14 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>今日已发暖场讨论评</div>
          <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4, color: 'var(--primary)' }}>
            {overview?.stats.todayWarmupSent ?? 0}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
            排队待发任务 {overview?.stats.activeWarmupJobs ?? 0} 个
          </div>
        </div>
        <div className="card" style={{ padding: 14 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>待处理 / 待确认评论</div>
          <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4, color: actionableCount > 0 ? 'var(--warn)' : 'var(--text)' }}>
            {actionableCount}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
            已同步自有作品 {overview?.stats.syncedVideoCount ?? 0} 条
          </div>
        </div>
        <div className="card" style={{ padding: 14 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>已自动拦截广告乱评</div>
          <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4, color: '#64748b' }}>
            {overview?.stats.spamBlockedCount ?? 0}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
            绝不回复自己发过的评论
          </div>
        </div>
      </div>

      {/* 平台接入状态条 */}
      <div className="card" style={{ padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, fontWeight: 700 }}>平台接入状态：</span>
          {(overview?.capabilities || []).map((cap) => (
            <div
              key={cap.platformType}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 10px',
                borderRadius: 999,
                fontSize: 12,
                background: cap.supported && cap.hasValidAccount ? '#f0fdf4' : '#f8fafc',
                border: `1px solid ${cap.supported && cap.hasValidAccount ? '#bbf7d0' : 'var(--border)'}`,
                color: cap.reserved ? '#64748b' : 'var(--text)',
              }}
              title={cap.note}
            >
              <strong>{cap.name}</strong>
              {cap.reserved ? (
                <span style={{ fontSize: 11, color: '#64748b' }}>已预留（后续扫码可用）</span>
              ) : cap.hasValidAccount ? (
                <span style={{ fontSize: 11, color: '#16a34a', fontWeight: 600 }}>
                  ● 已就绪（{cap.accounts.map((a) => a.accountName).join(' / ')}）
                </span>
              ) : (
                <button
                  style={{ border: 'none', background: 'none', color: '#4f46e5', cursor: 'pointer', fontSize: 11, padding: 0, textDecoration: 'underline' }}
                  onClick={() => onNavigate?.('publish:accounts')}
                >
                  去扫码绑定
                </button>
              )}
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
          <span style={{ color: 'var(--text-muted)' }}>发送模式：</span>
          <button
            className={`btn btn-sm ${overview?.settings.mode === 'auto' ? 'btn-primary' : ''}`}
            onClick={() => void handleQuickModeSwitch('auto')}
          >
            全自动发出
          </button>
          <button
            className={`btn btn-sm ${overview?.settings.mode === 'draft' ? 'btn-primary' : ''}`}
            onClick={() => void handleQuickModeSwitch('draft')}
          >
            先写草稿我确认
          </button>
        </div>
      </div>

      {/* 四大功能子标签 */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          data-testid="cg-tab-inbox"
          className={`btn ${subTab === 'inbox' ? 'btn-primary' : ''}`}
          onClick={() => setSubTab('inbox')}
        >
          <MessageCircleReply size={15} /> 粉丝评论与回复 ({comments.length})
        </button>
        <button
          data-testid="cg-tab-warmup"
          className={`btn ${subTab === 'warmup' ? 'btn-primary' : ''}`}
          onClick={() => setSubTab('warmup')}
        >
          <Flame size={15} /> 发片暖评管理 ({warmups.length})
        </button>
        <button
          data-testid="cg-tab-settings"
          className={`btn ${subTab === 'settings' ? 'btn-primary' : ''}`}
          onClick={() => setSubTab('settings')}
        >
          <Settings2 size={15} /> 托管规则与防风控
        </button>
        <button
          data-testid="cg-tab-logs"
          className={`btn ${subTab === 'logs' ? 'btn-primary' : ''}`}
          onClick={() => setSubTab('logs')}
        >
          <Clock size={15} /> 巡检与发送记录 ({logs.length})
        </button>
      </div>

      {/* 子页 1：粉丝评论收件箱 */}
      {subTab === 'inbox' && (
        <div className="card" style={{ display: 'grid', gap: 14 }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <select className="select" value={platformFilter} onChange={(e) => setPlatformFilter(e.target.value)} style={{ width: 130 }}>
                <option value="all">全部平台</option>
                <option value="3">抖音</option>
                <option value="4">快手</option>
                <option value="1">小红书（预留）</option>
                <option value="2">微信视频号（预留）</option>
              </select>
              <select className="select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ width: 160 }}>
                <option value="all">全部状态</option>
                <option value="actionable">待处理 / 待确认 / 失败</option>
                <option value="replied">已自动回复</option>
                <option value="skipped_spam">已拦截广告/无效</option>
                <option value="skipped_already_replied">平台已有回复</option>
                <option value="ignored">已手动忽略</option>
              </select>
              <input
                className="input"
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                placeholder="搜粉丝昵称、评论或视频标题..."
                style={{ width: 240 }}
              />
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              只处理你自有作品下方的粉丝评论，已回复过的绝不重复刷评
            </div>
          </div>

          {comments.length === 0 ? (
            <div style={{ padding: '36px 16px', textAlign: 'center', color: 'var(--text-muted)' }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>
                当前筛选下暂无评论记录
              </div>
              <div style={{ fontSize: 13, marginBottom: 12 }}>
                点右上角「立即巡检一次」或「仅同步评论」，就会立刻拉取你抖音和快手所有已发视频的真实粉丝留言。
              </div>
              <button className="btn btn-primary btn-sm" disabled={patrolling} onClick={() => void handleRunPatrol(true)}>
                先同步一次自有视频评论
              </button>
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 12 }}>
              {comments.map((c) => {
                const pm = pMeta(c.platform_type);
                const sm = REPLY_STATUS_META[c.reply_status] || { label: c.reply_status, badge: 'badge-gray' };
                const isEditable = ['pending', 'draft_ready', 'failed'].includes(c.reply_status) && !c.is_author_comment;
                const draftVal = replyDrafts[c.id] ?? c.ai_reply_text ?? '';
                const busy = busyCommentId === c.id;

                return (
                  <div
                    key={c.id}
                    style={{
                      padding: 14,
                      borderRadius: 12,
                      border: '1px solid var(--border)',
                      background: 'var(--surface-muted)',
                      display: 'grid',
                      gap: 10,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12.5 }}>
                        <span className={`badge ${pm.badge}`}>{pm.label}</span>
                        <span className={`badge ${sm.badge}`}>{sm.label}</span>
                        {c.parent_comment_id && <span className="badge badge-blue">二级追评</span>}
                        <span style={{ fontWeight: 600, color: 'var(--text)' }}>
                          作品：{c.video_title.slice(0, 42)}{c.video_title.length > 42 ? '…' : ''}
                        </span>
                      </div>
                      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        {fmtTime(c.comment_created_at || c.discovered_at)}
                      </span>
                    </div>

                    <div style={{ background: '#ffffff', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border)' }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: '#334155', marginBottom: 4 }}>
                        {c.author_name || '粉丝'} 说：
                      </div>
                      <div style={{ fontSize: 14, color: 'var(--text)', lineHeight: 1.55 }}>{c.comment_text}</div>
                    </div>

                    {c.skip_reason && (
                      <div style={{ fontSize: 12, color: '#64748b', display: 'flex', alignItems: 'center', gap: 6 }}>
                        <ShieldAlert size={13} /> 处理说明：{c.skip_reason}
                      </div>
                    )}

                    {c.reply_status === 'replied' && (
                      <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', padding: '10px 12px', borderRadius: 10 }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: '#15803d', marginBottom: 4, display: 'flex', justifyContent: 'space-between' }}>
                          <span><CheckCircle2 size={13} style={{ verticalAlign: -2, marginRight: 4 }} />已发出作者回复：</span>
                          <span style={{ fontWeight: 400 }}>{fmtTime(c.replied_at)}</span>
                        </div>
                        <div style={{ fontSize: 13.5, color: '#14532d' }}>{c.sent_reply_text || c.ai_reply_text}</div>
                      </div>
                    )}

                    {c.last_error && (
                      <div style={{ fontSize: 12, color: 'var(--danger)' }}>上次发送失败：{c.last_error}</div>
                    )}

                    {isEditable && (
                      <div style={{ display: 'grid', gap: 8 }}>
                        <textarea
                          className="input"
                          rows={2}
                          value={draftVal}
                          onChange={(e) => setReplyDrafts((prev) => ({ ...prev, [c.id]: e.target.value }))}
                          placeholder="AI 拟好的回复会显示在这里，你也可以直接修改..."
                        />
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void handleSendReply(c)}>
                            <Send size={13} /> {busy ? '发送中...' : '确认发送这条回复'}
                          </button>
                          <button className="btn btn-sm" disabled={busy} onClick={() => void handleRegenerateReply(c.id)}>
                            <Sparkles size={13} /> 让 AI 重写一句
                          </button>
                          <button className="btn btn-sm" disabled={busy} onClick={() => void handleIgnoreComment(c.id)}>
                            <XCircle size={13} /> 忽略不回
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* 子页 2：发片暖评管理 */}
      {subTab === 'warmup' && (
        <div style={{ display: 'grid', gap: 16 }}>
          {/* 手动补暖评工作区 */}
          <div className="card" style={{ display: 'grid', gap: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 15 }}>给视频手动生成 / 补发 2～3 条暖场讨论评</div>
                <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 2 }}>
                  新发布的视频默认会在发完后自动排队暖评；如果想给已经发出去的老视频补暖评，在下面点选视频或填标题即可。
                </div>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '130px 1fr 110px 140px', gap: 10 }}>
              <select className="select" value={manualPlatform} onChange={(e) => setManualPlatform(Number(e.target.value))}>
                <option value={3}>抖音</option>
                <option value={4}>快手</option>
              </select>
              <input
                className="input"
                value={manualVideoTitle}
                onChange={(e) => setManualVideoTitle(e.target.value)}
                placeholder="输入视频标题，或直接点下方已同步视频的「AI 写暖评」"
              />
              <select className="select" value={manualCount} onChange={(e) => setManualCount(Number(e.target.value))}>
                <option value={2}>生成 2 条</option>
                <option value={3}>生成 3 条</option>
              </select>
              <select className="select" value={manualStyle} onChange={(e) => setManualStyle(e.target.value as 'debate' | 'insight' | 'poll')}>
                <option value="debate">抛出争议讨论</option>
                <option value="poll">站队互动提问</option>
                <option value="insight">补充干货反问</option>
              </select>
            </div>

            <textarea
              className="input"
              rows={2}
              value={manualVideoScript}
              onChange={(e) => setManualVideoScript(e.target.value)}
              placeholder="可选：贴一点视频口播重点或核心观点，AI 写出来的讨论暖评会更扎心、更有针对性"
            />

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                data-testid="cg-manual-preview-btn"
                className="btn btn-primary btn-sm"
                disabled={previewingManual}
                onClick={() => void handlePreviewManualWarmup()}
              >
                <Sparkles size={13} /> {previewingManual ? 'AI 构思暖评中...' : 'AI 生成暖场讨论评'}
              </button>
              {manualComments.length > 0 && (
                <>
                  <button
                    className="btn btn-sm"
                    disabled={creatingManual}
                    onClick={() => void handleCreateManualWarmup(false)}
                  >
                    加入排队稍后自动发
                  </button>
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={creatingManual}
                    onClick={() => void handleCreateManualWarmup(true)}
                  >
                    <Send size={13} /> {creatingManual ? '正在发送...' : '立刻错开间隔发到评论区'}
                  </button>
                </>
              )}
            </div>

            {manualComments.length > 0 && (
              <div style={{ display: 'grid', gap: 8, padding: 12, borderRadius: 10, background: 'var(--surface-muted)', border: '1px solid var(--border)' }}>
                <div style={{ fontSize: 12.5, fontWeight: 700 }}>预览与微调（发出时每条之间会自动隔开几十秒防风控）：</div>
                {manualComments.map((mc, idx) => (
                  <div key={idx} style={{ display: 'grid', gap: 4 }}>
                    <span className="badge badge-blue" style={{ width: 'fit-content' }}>第 {idx + 1} 条 · {mc.angle}</span>
                    <textarea
                      className="input"
                      rows={2}
                      value={mc.text}
                      onChange={(e) =>
                        setManualComments((prev) =>
                          prev.map((item, i) => (i === idx ? { ...item, text: e.target.value } : item))
                        )
                      }
                    />
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 暖评自动任务队列 */}
          <div className="card" style={{ display: 'grid', gap: 12 }}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>暖场评论队列与发送记录</div>
            {warmups.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '16px 0' }}>
                还没有暖评任务。下次发布视频成功后会自动在这里生成 2～3 条暖场评排队发出，你也可以在上方手动创建。
              </div>
            ) : (
              <div style={{ display: 'grid', gap: 12 }}>
                {warmups.map((job) => {
                  const pm = pMeta(job.platform_type);
                  const sm = WARMUP_STATUS_META[job.status] || { label: job.status, badge: 'badge-gray' };
                  const list = warmupDrafts[job.id] ?? job.comments;
                  const canEdit = ['queued', 'pending_approval', 'failed', 'partial'].includes(job.status);
                  const busy = busyWarmupId === job.id;

                  return (
                    <div key={job.id} style={{ padding: 14, borderRadius: 12, border: '1px solid var(--border)', background: 'var(--surface-muted)', display: 'grid', gap: 10 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <span className={`badge ${pm.badge}`}>{pm.label}</span>
                          <span className={`badge ${sm.badge}`}>{sm.label}</span>
                          <strong>{job.video_title}</strong>
                          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                            进度 {job.sent_count}/{job.target_count}
                          </span>
                        </div>
                        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                          计划发送：{fmtTime(job.scheduled_for)}
                        </span>
                      </div>

                      <div style={{ display: 'grid', gap: 8 }}>
                        {list.map((it, idx) => (
                          <div key={idx} style={{ background: '#fff', padding: 10, borderRadius: 10, border: '1px solid var(--border)', display: 'grid', gap: 6 }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12 }}>
                              <span className="badge badge-blue">第 {idx + 1} 条 · {it.angle}</span>
                              <span className={`badge ${it.status === 'sent' ? 'badge-green' : it.status === 'failed' ? 'badge-red' : 'badge-gray'}`}>
                                {it.status === 'sent' ? '已发出' : it.status === 'failed' ? '发送失败' : '待发出'}
                              </span>
                            </div>
                            {canEdit && it.status !== 'sent' ? (
                              <textarea
                                className="input"
                                rows={2}
                                value={it.text}
                                onChange={(e) => {
                                  const next = list.map((x, i) => (i === idx ? { ...x, text: e.target.value } : x));
                                  setWarmupDrafts((prev) => ({ ...prev, [job.id]: next }));
                                }}
                              />
                            ) : (
                              <div style={{ fontSize: 13.5 }}>{it.text}</div>
                            )}
                            {it.error && <div style={{ fontSize: 12, color: 'var(--danger)' }}>{it.error}</div>}
                          </div>
                        ))}
                      </div>

                      {job.last_error && <div style={{ fontSize: 12, color: 'var(--danger)' }}>备注：{job.last_error}</div>}

                      {canEdit && (
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          {warmupDrafts[job.id] && (
                            <button className="btn btn-sm" disabled={busy} onClick={() => void handleSaveWarmupEdits(job)}>
                              保存修改
                            </button>
                          )}
                          <button className="btn btn-sm" disabled={busy} onClick={() => void handleRegenerateWarmup(job.id)}>
                            <Sparkles size={13} /> 换一批 AI 暖评
                          </button>
                          <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void handleRunWarmupNow(job.id)}>
                            <Send size={13} /> {busy ? '发送中...' : '立刻发出待发暖评'}
                          </button>
                          <button className="btn btn-sm" disabled={busy} onClick={() => void handleCancelWarmup(job.id)}>
                            取消任务
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* 我的已发布作品快捷列表 */}
          <div className="card" style={{ display: 'grid', gap: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontWeight: 700, fontSize: 15 }}>我已发布的视频（同步自抖音/快手）</div>
              <button className="btn btn-sm" disabled={patrolling} onClick={() => void handleRunPatrol(true)}>
                <RefreshCw size={13} /> 刷新我的作品列表
              </button>
            </div>
            {videos.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                暂未同步作品，点右侧「刷新我的作品列表」即可拉取你抖音和快手的已发布视频。
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>平台</th>
                      <th>作品标题</th>
                      <th>评论 / 点赞</th>
                      <th>发布时间</th>
                      <th style={{ width: 130 }}>快捷操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {videos.slice(0, 20).map((v) => {
                      const pm = pMeta(v.platform_type);
                      return (
                        <tr key={v.id}>
                          <td><span className={`badge ${pm.badge}`}>{pm.label}</span></td>
                          <td style={{ maxWidth: 420 }}>{v.title.slice(0, 56)}{v.title.length > 56 ? '…' : ''}</td>
                          <td style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
                            评 {fmtNum(v.comment_count, '0')} · 赞 {fmtNum(v.like_count, '0')}
                          </td>
                          <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{fmtTime(v.published_at || v.last_synced_at)}</td>
                          <td>
                            <button
                              className="btn btn-sm"
                              disabled={previewingManual}
                              onClick={() => void handlePickVideoForManualWarmup(v)}
                            >
                              <Sparkles size={12} /> AI 写暖评
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 子页 3：托管规则与防风控 */}
      {subTab === 'settings' && form && (
        <div className="card" style={{ display: 'grid', gap: 16 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>评论托管规则、作者人设与安全防风控</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 18 }}>
            <div style={{ display: 'grid', gap: 12, alignContent: 'start' }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>一、发片暖评与定时巡检</div>

              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5, fontWeight: 600 }}>
                <input
                  type="checkbox"
                  checked={form.warmupEnabled}
                  onChange={(e) => setForm({ ...form, warmupEnabled: e.target.checked })}
                />
                视频发布成功后自动留暖场讨论评论
              </label>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <label style={{ fontSize: 12.5 }}>
                  每次暖评条数
                  <select
                    className="select"
                    value={form.warmupCount}
                    onChange={(e) => setForm({ ...form, warmupCount: Number(e.target.value) })}
                    style={{ marginTop: 4 }}
                  >
                    <option value={2}>2 条（稳妥）</option>
                    <option value={3}>3 条（更热闹）</option>
                  </select>
                </label>
                <label style={{ fontSize: 12.5 }}>
                  发完视频等几分钟再暖评
                  <input
                    className="input"
                    type="number"
                    min={0}
                    max={60}
                    value={form.warmupDelayMinutes}
                    onChange={(e) => setForm({ ...form, warmupDelayMinutes: Number(e.target.value) || 0 })}
                    style={{ marginTop: 4 }}
                  />
                </label>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <label style={{ fontSize: 12.5 }}>
                  暖评主风格
                  <select
                    className="select"
                    value={form.warmupStyle}
                    onChange={(e) => setForm({ ...form, warmupStyle: e.target.value as 'debate' | 'insight' | 'poll' })}
                    style={{ marginTop: 4 }}
                  >
                    <option value="debate">抛出争议观点（最容易引发讨论）</option>
                    <option value="poll">站队互动提问</option>
                    <option value="insight">作者补充干货反问</option>
                  </select>
                </label>
                <label style={{ fontSize: 12.5 }}>
                  定时巡检频率
                  <select
                    className="select"
                    value={form.patrolIntervalMinutes}
                    onChange={(e) => setForm({ ...form, patrolIntervalMinutes: Number(e.target.value) })}
                    style={{ marginTop: 4 }}
                  >
                    <option value={10}>每 10 分钟检查一次</option>
                    <option value={20}>每 20 分钟检查一次（推荐）</option>
                    <option value={30}>每 30 分钟检查一次</option>
                    <option value={60}>每 60 分钟检查一次</option>
                  </select>
                </label>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
                <label style={{ fontSize: 12.5 }}>
                  每轮最多回几条
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={20}
                    value={form.maxRepliesPerPatrol}
                    onChange={(e) => setForm({ ...form, maxRepliesPerPatrol: Number(e.target.value) || 5 })}
                    style={{ marginTop: 4 }}
                  />
                </label>
                <label style={{ fontSize: 12.5 }}>
                  单平台每日上限
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={100}
                    value={form.dailyReplyCapPerPlatform}
                    onChange={(e) => setForm({ ...form, dailyReplyCapPerPlatform: Number(e.target.value) || 30 })}
                    style={{ marginTop: 4 }}
                  />
                </label>
                <label style={{ fontSize: 12.5 }}>
                  回复间隔（秒）
                  <input
                    className="input"
                    type="number"
                    min={5}
                    max={120}
                    value={form.replySpacingMinSec}
                    onChange={(e) => {
                      const v = Number(e.target.value) || 12;
                      setForm({ ...form, replySpacingMinSec: v, replySpacingMaxSec: Math.max(v + 10, form.replySpacingMaxSec) });
                    }}
                    style={{ marginTop: 4 }}
                  />
                </label>
              </div>

              <div style={{ fontSize: 12.5 }}>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>启用巡检的平台</div>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  {[3, 4, 1, 2].map((pt) => {
                    const isReserved = pt === 1 || pt === 2;
                    const checked = form.enabledPlatforms.includes(pt);
                    return (
                      <label key={pt} style={{ display: 'flex', alignItems: 'center', gap: 5, color: isReserved ? '#94a3b8' : 'var(--text)' }}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            const next = e.target.checked
                              ? Array.from(new Set([...form.enabledPlatforms, pt]))
                              : form.enabledPlatforms.filter((x) => x !== pt);
                            setForm({ ...form, enabledPlatforms: next });
                          }}
                        />
                        {pMeta(pt).label}{isReserved ? '（预留）' : ''}
                      </label>
                    );
                  })}
                </div>
              </div>
            </div>

            <div style={{ display: 'grid', gap: 12, alignContent: 'start' }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>二、作者人设与广告过滤</div>
              <label style={{ fontSize: 12.5 }}>
                回复粉丝的语气风格
                <select
                  className="select"
                  value={form.toneStyle}
                  onChange={(e) => setForm({ ...form, toneStyle: e.target.value as 'friendly' | 'sharp' | 'expert' })}
                  style={{ marginTop: 4 }}
                >
                  <option value="friendly">接地气真诚聊（像朋友互动）</option>
                  <option value="sharp">观点犀利带讨论（鼓励反驳交流）</option>
                  <option value="expert">专业干货答疑（一针见血）</option>
                </select>
              </label>

              <label style={{ fontSize: 12.5 }}>
                作者人设与说话习惯
                <textarea
                  className="input"
                  rows={3}
                  value={form.persona}
                  onChange={(e) => setForm({ ...form, persona: e.target.value })}
                  style={{ marginTop: 4 }}
                />
              </label>

              <label style={{ fontSize: 12.5 }}>
                广告 / 垃圾评论屏蔽词（命中自动跳过不回，逗号分隔）
                <textarea
                  className="input"
                  rows={2}
                  value={spamText}
                  onChange={(e) => setSpamText(e.target.value)}
                  style={{ marginTop: 4 }}
                />
              </label>

              <label style={{ fontSize: 12.5 }}>
                绝不让 AI 说出口的禁说词（逗号分隔）
                <input
                  className="input"
                  value={forbiddenText}
                  onChange={(e) => setForbiddenText(e.target.value)}
                  style={{ marginTop: 4 }}
                />
              </label>
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: 8, borderTop: '1px solid var(--border)' }}>
            <button
              data-testid="cg-save-settings-btn"
              className="btn btn-primary"
              disabled={savingSettings}
              onClick={() => void handleSaveSettings()}
            >
              {savingSettings ? '正在保存...' : '保存托管规则与防风控设置'}
            </button>
          </div>
        </div>
      )}

      {/* 子页 4：运行日志 */}
      {subTab === 'logs' && (
        <div className="card" style={{ display: 'grid', gap: 10 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>最近巡检、暖评与自动回复记录</div>
          {logs.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>暂无运行记录</div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 135 }}>时间</th>
                    <th style={{ width: 90 }}>平台</th>
                    <th style={{ width: 95 }}>类型</th>
                    <th>执行摘要</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((lg) => {
                    const pm = pMeta(lg.platform_type);
                    const typeLabel =
                      lg.action_type === 'patrol'
                        ? '定时巡检'
                        : lg.action_type === 'warmup'
                          ? '暖场评论'
                          : lg.action_type === 'reply'
                            ? '回复粉丝'
                            : lg.action_type === 'publish_hook'
                              ? '发片联动'
                              : '规则更新';
                    return (
                      <tr key={lg.id}>
                        <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{fmtTime(lg.created_at)}</td>
                        <td><span className={`badge ${pm.badge}`}>{pm.label}</span></td>
                        <td>
                          <span className={`badge ${lg.level === 'ERROR' ? 'badge-red' : lg.level === 'WARN' ? 'badge-amber' : 'badge-blue'}`}>
                            {typeLabel}
                          </span>
                        </td>
                        <td style={{ fontSize: 13 }}>{lg.summary}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
