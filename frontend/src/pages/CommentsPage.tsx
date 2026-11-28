import { useEffect, useMemo, useState } from 'react';
import {
  MessageSquareText,
  Search,
  Link2,
  UserSearch,
  Sparkles,
  Download,
  Copy,
  Check,
  Trash2,
  RefreshCw,
  ExternalLink,
  AlertTriangle,
  Star,
} from 'lucide-react';
import { apiRequest, fmtTime, saveTopicToBoard } from '../api';
import type { CommentCrawlJob, CommentCrawlJobSummary, TopicBoardItem } from '../types';

type PlatformKey = 'douyin' | 'bilibili' | 'xiaohongshu' | 'kuaishou';
type CrawlMode = 'detail' | 'search' | 'creator';

const PLATFORMS: Array<{ id: PlatformKey; label: string; color: string }> = [
  { id: 'douyin', label: '抖音', color: '#e11d48' },
  { id: 'bilibili', label: 'B站', color: '#4f46e5' },
  { id: 'xiaohongshu', label: '小红书', color: '#f43f5e' },
  { id: 'kuaishou', label: '快手', color: '#ea580c' },
];

const MODES: Array<{ id: CrawlMode; label: string; desc: string; icon: typeof Link2 }> = [
  { id: 'detail', label: '贴链接抓评论', desc: '单条视频 / 笔记高赞热评', icon: Link2 },
  { id: 'search', label: '关键词搜评论', desc: '按主题词批量扫评论区', icon: Search },
  { id: 'creator', label: '抓博主评论', desc: '拉取指定博主近期评论', icon: UserSearch },
];

function getPlaceholder(platform: PlatformKey, mode: CrawlMode): string {
  if (mode === 'detail') {
    if (platform === 'douyin') return '直接粘贴抖音分享口令、v.douyin.com 短链或视频链接';
    if (platform === 'bilibili') return '粘贴 B站视频网址或 BV 号（如 BV1...，免登录秒出）';
    if (platform === 'xiaohongshu') return '粘贴小红书笔记链接（首次采集建议勾选右侧「需扫码时弹窗口」）';
    return '粘贴快手视频链接或作品 ID';
  }
  if (mode === 'search') {
    return '输入想调研的关键词，例如：AI工作流 / 剪辑教程 / 副业避坑';
  }
  if (platform === 'douyin') return '粘贴抖音博主主页链接、分享口令或 sec_uid';
  if (platform === 'bilibili') return '粘贴 B站 UP 主空间网址或数字 UID';
  return '粘贴博主主页链接或博主 ID';
}

function modeLabel(mode: string): string {
  if (mode === 'detail') return '单条';
  if (mode === 'search') return '关键词';
  return '博主';
}

function platformLabel(p: string): string {
  return PLATFORMS.find((x) => x.id === p)?.label || p;
}

function platformColor(p: string): string {
  return PLATFORMS.find((x) => x.id === p)?.color || '#475569';
}

export function CommentsPage({
  onToast,
  onNavigate,
  onRefreshBadge,
}: {
  onToast: (msg: string) => void;
  onNavigate?: (tab: string) => void;
  onRefreshBadge?: () => void;
}) {
  const [platform, setPlatform] = useState<PlatformKey>('douyin');
  const [mode, setMode] = useState<CrawlMode>('detail');
  const [input, setInput] = useState('');
  const [maxComments, setMaxComments] = useState(30);
  const [showBrowser, setShowBrowser] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [jobs, setJobs] = useState<CommentCrawlJobSummary[]>([]);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [activeJob, setActiveJob] = useState<CommentCrawlJob | null>(null);
  const [analyzing, setAnalyzing] = useState(false);

  const [searchText, setSearchText] = useState('');
  const [sortBy, setSortBy] = useState<'likes' | 'time'>('likes');
  const [copiedTop, setCopiedTop] = useState(false);
  const [savedBoardTitles, setSavedBoardTitles] = useState<Set<string>>(() => new Set());
  const [savingAngleKey, setSavingAngleKey] = useState<string | null>(null);

  const loadBoardTitles = async () => {
    try {
      const res = await apiRequest<{ items: TopicBoardItem[] }>('/api/radar/board');
      setSavedBoardTitles(new Set((res.items || []).map((it) => String(it.title || '').trim()).filter(Boolean)));
    } catch {
      // 忽略静默查询异常
    }
  };

  // 加载历史任务列表
  const loadJobs = async (autoSelectFirst = false) => {
    try {
      const res = await apiRequest<{ jobs: CommentCrawlJobSummary[] }>('/api/comments/jobs');
      setJobs(res.jobs || []);
      if (autoSelectFirst && !activeJobId && res.jobs.length > 0) {
        setActiveJobId(res.jobs[0].id);
      }
    } catch {
      // 忽略静默轮询异常
    }
  };

  // 加载当前选中任务的完整评论明细
  const loadJobDetail = async (id: string) => {
    try {
      const res = await apiRequest<{ job: CommentCrawlJob }>(`/api/comments/jobs/${id}`);
      setActiveJob(res.job);
    } catch {
      setActiveJob(null);
    }
  };

  useEffect(() => {
    void loadJobs(true);
    void loadBoardTitles();
  }, []);

  useEffect(() => {
    if (!activeJobId) {
      setActiveJob(null);
      return;
    }
    void loadJobDetail(activeJobId);
  }, [activeJobId]);

  // 有任务正在执行时，每 2.5 秒自动刷新进度与结果
  const hasRunning = useMemo(
    () => jobs.some((j) => j.status === 'running') || activeJob?.status === 'running',
    [jobs, activeJob?.status]
  );

  useEffect(() => {
    if (!hasRunning) return;
    const timer = window.setInterval(() => {
      void loadJobs(false);
      if (activeJobId) void loadJobDetail(activeJobId);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [hasRunning, activeJobId]);

  // 切换到需要 MediaCrawler 浏览器的平台或模式时，提示是否弹窗口
  const isFastDirect = (platform === 'bilibili' || platform === 'douyin') && mode === 'detail';

  const handleStartCrawl = async () => {
    const trimmed = input.trim();
    if (!trimmed) {
      onToast('请先粘贴链接、关键词或博主主页');
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiRequest<{ started: boolean; jobId?: string; job?: { id: string }; message: string }>('/api/comments/crawl', {
        method: 'POST',
        body: JSON.stringify({
          platform,
          mode,
          input: trimmed,
          maxComments,
          showBrowser,
        }),
      });
      onToast(res.message);
      const newJobId = res.jobId || res.job?.id;
      if (newJobId) {
        setActiveJobId(newJobId);
        await loadJobs(false);
        await loadJobDetail(newJobId);
      }
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleAnalyze = async () => {
    if (!activeJob || activeJob.comments.length === 0) return;
    setAnalyzing(true);
    try {
      await apiRequest(`/api/comments/jobs/${activeJob.id}/analyze`, { method: 'POST' });
      onToast('AI 评论区痛点提炼完成');
      await loadJobDetail(activeJob.id);
      await loadJobs(false);
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setAnalyzing(false);
    }
  };

  const handleDeleteJob = async (id: string) => {
    try {
      await apiRequest(`/api/comments/jobs/${id}`, { method: 'DELETE' });
      const next = jobs.filter((j) => j.id !== id);
      setJobs(next);
      if (activeJobId === id) {
        setActiveJobId(next[0]?.id || null);
      }
      onToast('已删除该条采集记录');
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  const handleSaveAngleToBoard = async (key: string, titleText: string, kindLabel: string) => {
    if (!activeJob) return;
    const cleanTitle = titleText.trim();
    if (!cleanTitle || savedBoardTitles.has(cleanTitle)) return;
    setSavingAngleKey(key);
    try {
      const topEvidence = [...activeJob.comments]
        .sort((a, b) => (b.likes || 0) - (a.likes || 0))
        .slice(0, 3)
        .map((c) => `[👍${c.likes ?? 0}] ${c.author || '观众'}：${c.text}`)
        .join('\n');
      const sourceUrl = activeJob.input.trim().startsWith('http') ? activeJob.input.trim() : '';
      await saveTopicToBoard({
        title: cleanTitle,
        source_content_id: null,
        core_angle: activeJob.aiSummary?.oneLineTakeaway || `来自评论区${kindLabel}`,
        notes: [
          `来源：${platformLabel(activeJob.platform)} · ${modeLabel(activeJob.mode)}采集（${activeJob.input}）`,
          topEvidence ? `代表热评：\n${topEvidence}` : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
        tags: ['评论话题', platformLabel(activeJob.platform)],
        source_url: sourceUrl,
      });
      setSavedBoardTitles((prev) => {
        const next = new Set(prev);
        next.add(cleanTitle);
        return next;
      });
      onToast('已存入选题库，可在「简易收藏本」查看');
      onRefreshBadge?.();
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setSavingAngleKey(null);
    }
  };

  const visibleComments = useMemo(() => {
    const rows = activeJob?.comments || [];
    const kw = searchText.trim().toLowerCase();
    const filtered = kw
      ? rows.filter(
          (c) =>
            c.text.toLowerCase().includes(kw) ||
            c.author.toLowerCase().includes(kw) ||
            (c.postTitle || '').toLowerCase().includes(kw)
        )
      : rows;
    return [...filtered].sort((a, b) => {
      if (sortBy === 'likes') return (b.likes || 0) - (a.likes || 0);
      return String(b.publishedAt || '').localeCompare(String(a.publishedAt || ''));
    });
  }, [activeJob?.comments, searchText, sortBy]);

  const maxLikes = useMemo(() => {
    const rows = activeJob?.comments || [];
    return rows.reduce((m, c) => Math.max(m, c.likes || 0), 0);
  }, [activeJob?.comments]);

  const handleCopyTop20 = async () => {
    if (visibleComments.length === 0) return;
    const text = visibleComments
      .slice(0, 20)
      .map((c, idx) => `${idx + 1}. [👍${c.likes}] ${c.author}: ${c.text}`)
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopiedTop(true);
      onToast('已复制前 20 条高赞评论');
      window.setTimeout(() => setCopiedTop(false), 1800);
    } catch {
      onToast('复制失败，请手动选中复制');
    }
  };

  const handleExportCsv = () => {
    if (!activeJob || visibleComments.length === 0) return;
    const esc = (v: string | number | null | undefined) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = ['作者', '点赞数', '评论内容', '时间', '所属作品', '原链接'].join(',');
    const lines = visibleComments.map((c) =>
      [esc(c.author), c.likes ?? 0, esc(c.text), esc(c.publishedAt || ''), esc(c.postTitle || ''), esc(c.postUrl || '')].join(',')
    );
    const blob = new Blob(['\uFEFF' + [header, ...lines].join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `comments-${activeJob.platform}-${activeJob.id}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    onToast(`已导出 ${visibleComments.length} 条评论到 CSV`);
  };

  return (
    <div>
      {/* 顶部清爽单条采集控制区 */}
      <div className="panel-card">
        <div className="panel-head" style={{ marginBottom: 14 }}>
          <div className="panel-title">
            <MessageSquareText size={17} color="#4f46e5" />
            <span>新建评论采集（单端口 18910 内置，无需开 8089）</span>
          </div>
          <span className="badge badge-blue">
            {isFastDirect ? '极速直连模式 · 3 秒出热评' : 'MediaCrawler 深度采集引擎'}
          </span>
        </div>

        {/* 平台与模式双排紧凑胶囊 */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginRight: 2 }}>平台</span>
            {PLATFORMS.map((p) => {
              const active = platform === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  data-testid={`comments-plat-${p.id}`}
                  className={`btn btn-sm ${active ? 'btn-primary' : ''}`}
                  onClick={() => setPlatform(p.id)}
                >
                  <span
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: 999,
                      background: active ? '#ffffff' : p.color,
                      display: 'inline-block',
                    }}
                  />
                  {p.label}
                </button>
              );
            })}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginRight: 2 }}>方式</span>
            {MODES.map((m) => {
              const Icon = m.icon;
              const active = mode === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  data-testid={`comments-mode-${m.id}`}
                  className={`btn btn-sm ${active ? 'btn-primary' : ''}`}
                  onClick={() => setMode(m.id)}
                  title={m.desc}
                >
                  <Icon size={13} />
                  {m.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* 一行输入框 + 条数 + 开始按钮 */}
        <div className="comments-input-row">
          <input
            className="input"
            data-testid="comments-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleStartCrawl();
            }}
            placeholder={getPlaceholder(platform, mode)}
          />
          <select
            className="select"
            style={{ width: 112 }}
            value={maxComments}
            onChange={(e) => setMaxComments(Number(e.target.value))}
          >
            <option value={20}>最多 20 条</option>
            <option value={30}>最多 30 条</option>
            <option value={50}>最多 50 条</option>
          </select>
          <button
            type="button"
            data-testid="comments-start-btn"
            className="btn btn-primary"
            disabled={submitting || hasRunning}
            onClick={() => void handleStartCrawl()}
          >
            <MessageSquareText size={14} />
            {submitting ? '启动中...' : hasRunning ? '采集中...' : '开始采集评论'}
          </button>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10, gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {isFastDirect
              ? '提示：B站免登录 1 秒出热评；抖音直接贴分享口令或短链即可，自动按高赞排序。'
              : '提示：关键词搜索、博主评论或小红书/快手需要调用深度采集内核；若首次未登录可勾选右侧弹窗扫码。'}
          </span>
          {!isFastDirect && (
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--text)', cursor: 'pointer' }}>
              <input type="checkbox" checked={showBrowser} onChange={(e) => setShowBrowser(e.target.checked)} />
              首次需要扫码时弹出浏览器窗口
            </label>
          )}
        </div>
      </div>

      {/* 下方左右分栏：左历史任务 / 右结果与 AI 痛点提炼 */}
      <div className="split-workbench">
        {/* 左侧：最近采集记录 */}
        <div className="panel-card" style={{ marginBottom: 0 }}>
          <div className="panel-head">
            <div className="panel-title">采集记录 ({jobs.length})</div>
            <button className="btn btn-sm" onClick={() => void loadJobs(false)}>
              <RefreshCw size={12} /> 刷新
            </button>
          </div>

          {jobs.length === 0 ? (
            <div style={{ padding: '28px 12px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
              还没有采集记录。在上方选平台、贴一条视频链接就能立刻抓评论。
            </div>
          ) : (
            <div className="comments-job-list">
              {jobs.map((j) => {
                const selected = j.id === activeJobId;
                return (
                  <div
                    key={j.id}
                    className={`comments-job-row ${selected ? 'active' : ''}`}
                    onClick={() => setActiveJobId(j.id)}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, marginBottom: 4 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span className="plat-badge" style={{ background: platformColor(j.platform) }}>
                          {platformLabel(j.platform)}
                        </span>
                        <span className="badge badge-gray">{modeLabel(j.mode)}</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span
                          className={`badge ${
                            j.status === 'done'
                              ? 'badge-green'
                              : j.status === 'running'
                                ? 'badge-blue'
                                : 'badge-red'
                          }`}
                        >
                          {j.status === 'done' ? `${j.commentCount} 条` : j.status === 'running' ? '采集中...' : '失败'}
                        </span>
                        <button
                          type="button"
                          className="icon-ghost-btn"
                          title="删除记录"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleDeleteJob(j.id);
                          }}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                    <div className="comments-job-input" title={j.input}>
                      {j.input}
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 3 }}>
                      {fmtTime(j.createdAt)} · {j.message}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 右侧：评论列表与 AI 痛点提炼 */}
        <div className="panel-card" style={{ marginBottom: 0 }}>
          {!activeJob ? (
            <div style={{ padding: '48px 16px', textAlign: 'center', color: 'var(--text-muted)' }}>
              <MessageSquareText size={32} style={{ opacity: 0.35, marginBottom: 8 }} />
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>选一条左侧记录，或在上方直接粘贴链接抓评论</div>
              <div style={{ fontSize: 12.5, marginTop: 4 }}>支持一键按高赞排序、搜索关键词、导出 Excel CSV，以及用 AI 提炼观众高频痛点</div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {/* 顶部摘要与操作 */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ minWidth: 0, flex: '1 1 260px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 4 }}>
                    <span className="plat-badge" style={{ background: platformColor(activeJob.platform) }}>
                      {platformLabel(activeJob.platform)}
                    </span>
                    <span className="badge badge-gray">{modeLabel(activeJob.mode)}采集</span>
                    <span className="badge badge-blue">共 {activeJob.comments.length} 条评论</span>
                    {maxLikes > 0 && <span className="badge badge-amber">最高赞 {maxLikes}</span>}
                  </div>
                  <div style={{ fontSize: 13.5, fontWeight: 600, wordBreak: 'break-all' }}>{activeJob.input}</div>
                </div>

                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    data-testid="comments-ai-btn"
                    className="btn btn-primary btn-sm"
                    disabled={analyzing || activeJob.comments.length === 0 || activeJob.status === 'running'}
                    onClick={() => void handleAnalyze()}
                  >
                    <Sparkles size={13} /> {analyzing ? 'AI 提炼中...' : activeJob.aiSummary ? '重新 AI 提炼' : 'AI 提炼评论区痛点'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={visibleComments.length === 0}
                    onClick={() => void handleCopyTop20()}
                  >
                    {copiedTop ? <Check size={13} /> : <Copy size={13} />} {copiedTop ? '已复制' : '复制 Top 20'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={visibleComments.length === 0}
                    onClick={handleExportCsv}
                  >
                    <Download size={13} /> 导出 CSV
                  </button>
                </div>
              </div>

              {/* 运行中实时日志或失败提示 */}
              {activeJob.status === 'running' && (
                <div className="accent-box accent-indigo">
                  <div className="accent-box-label">正在采集中（每 2.5 秒自动更新）</div>
                  <div style={{ fontSize: 12.5, marginTop: 4 }}>
                    {activeJob.logs.slice(-4).map((line, i) => (
                      <div key={i} style={{ opacity: 0.9 }}>{line}</div>
                    ))}
                  </div>
                </div>
              )}

              {activeJob.status === 'failed' && (
                <div className="alert-banner-warn" style={{ marginBottom: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <AlertTriangle size={15} />
                    <span>{activeJob.message || '采集失败，请检查链接格式或登录状态'}</span>
                  </div>
                  {onNavigate && (
                    <button className="btn btn-sm" onClick={() => onNavigate('browsers')}>
                      去检查登录态
                    </button>
                  )}
                </div>
              )}

              {/* AI 评论区痛点提炼结果（浅色块，无嵌套边框、无竖条装饰） */}
              {activeJob.aiSummary && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {activeJob.aiSummary.oneLineTakeaway && (
                    <div className="accent-box accent-indigo">
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <div className="accent-box-label">AI 一句话结论</div>
                        {onNavigate && (
                          <button type="button" className="btn btn-sm" onClick={() => onNavigate('saved')}>
                            去收藏本查看选题库
                          </button>
                        )}
                      </div>
                      <div className="accent-box-text" style={{ fontWeight: 600 }}>{activeJob.aiSummary.oneLineTakeaway}</div>
                    </div>
                  )}
                  <div className="comments-ai-grid">
                    <div className="accent-box accent-indigo">
                      <div className="accent-box-label">观众高频提问</div>
                      <ul className="comments-ai-ul">
                        {activeJob.aiSummary.topQuestions.map((q, idx) => (
                          <li key={idx}>{q}</li>
                        ))}
                      </ul>
                    </div>
                    <div className="accent-box accent-amber">
                      <div className="accent-box-label">核心吐槽与痛点</div>
                      <ul className="comments-ai-ul">
                        {activeJob.aiSummary.painPoints.map((p, idx) => {
                          const clean = p.trim();
                          const isSaved = savedBoardTitles.has(clean);
                          const key = `pain-${activeJob.id}-${idx}`;
                          return (
                            <li key={idx} style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 6 }}>
                              <span>{p}</span>
                              <div>
                                <button
                                  type="button"
                                  data-testid={`save-pain-${idx}`}
                                  className={`btn btn-sm ${isSaved ? 'btn-star-active' : ''}`}
                                  style={{ padding: '2px 8px', fontSize: 11.5 }}
                                  disabled={isSaved || savingAngleKey === key}
                                  onClick={() => void handleSaveAngleToBoard(key, p, '痛点')}
                                >
                                  <Star size={11} fill={isSaved ? 'currentColor' : 'none'} />
                                  {savingAngleKey === key ? '存入中...' : isSaved ? '已存入选题库' : '一键存为创作选题'}
                                </button>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                    <div className="accent-box accent-green">
                      <div className="accent-box-label">可直接拍的切入角度</div>
                      <ul className="comments-ai-ul">
                        {activeJob.aiSummary.topicAngles.map((a, idx) => {
                          const clean = a.trim();
                          const isSaved = savedBoardTitles.has(clean);
                          const key = `angle-${activeJob.id}-${idx}`;
                          return (
                            <li key={idx} style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 6 }}>
                              <span>{a}</span>
                              <div>
                                <button
                                  type="button"
                                  data-testid={`save-angle-${idx}`}
                                  className={`btn btn-sm ${isSaved ? 'btn-star-active' : 'btn-primary'}`}
                                  style={{ padding: '2px 8px', fontSize: 11.5 }}
                                  disabled={isSaved || savingAngleKey === key}
                                  onClick={() => void handleSaveAngleToBoard(key, a, '切入角度')}
                                >
                                  <Star size={11} fill={isSaved ? 'currentColor' : 'none'} />
                                  {savingAngleKey === key ? '存入中...' : isSaved ? '已存入选题库' : '一键存为创作选题'}
                                </button>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  </div>
                </div>
              )}

              {/* 评论筛选与排序 */}
              {activeJob.comments.length > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <input
                    className="input"
                    style={{ maxWidth: 280 }}
                    value={searchText}
                    onChange={(e) => setSearchText(e.target.value)}
                    placeholder="在已抓评论中搜关键词或作者..."
                  />
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      type="button"
                      className={`btn btn-sm ${sortBy === 'likes' ? 'btn-primary' : ''}`}
                      onClick={() => setSortBy('likes')}
                    >
                      按高赞排序
                    </button>
                    <button
                      type="button"
                      className={`btn btn-sm ${sortBy === 'time' ? 'btn-primary' : ''}`}
                      onClick={() => setSortBy('time')}
                    >
                      按最新排序
                    </button>
                  </div>
                </div>
              )}

              {/* 评论正文清单 */}
              {visibleComments.length > 0 ? (
                <div className="feed-list">
                  {visibleComments.map((cm) => (
                    <div key={cm.id} className="comment-row">
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, fontSize: 12, marginBottom: 4 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                          <strong>{cm.author || '匿名观众'}</strong>
                          {cm.postTitle && (
                            <span style={{ color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 260 }}>
                              · {cm.postTitle}
                            </span>
                          )}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                          <span style={{ color: '#ea580c', fontWeight: 700 }}>👍 {cm.likes ?? 0}</span>
                          {cm.publishedAt && <span style={{ color: 'var(--text-muted)' }}>{fmtTime(cm.publishedAt)}</span>}
                          {cm.postUrl && (
                            <a href={cm.postUrl} target="_blank" rel="noreferrer" title="查看原帖" style={{ color: 'var(--primary)' }}>
                              <ExternalLink size={12} />
                            </a>
                          )}
                        </div>
                      </div>
                      <div style={{ fontSize: 13.5, lineHeight: 1.55, color: '#1e293b' }}>{cm.text}</div>
                    </div>
                  ))}
                </div>
              ) : (
                activeJob.status === 'done' && (
                  <div style={{ padding: '24px 12px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                    {searchText ? '没有匹配该关键词的评论' : '本次未采集到公开评论，可尝试换一条有热评的视频链接。'}
                  </div>
                )
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
