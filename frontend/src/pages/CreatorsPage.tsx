import { useEffect, useRef, useState } from 'react';
import {
  Plus,
  RefreshCw,
  Trash2,
  ExternalLink,
  Bell,
  BellOff,
  Mic,
  Copy,
  Check,
  FileText,
  ChevronDown,
  ChevronUp,
  CheckCheck,
  Wand2,
  Star,
  Clock,
  Sparkles,
} from 'lucide-react';
import { apiRequest, fmtNum, fmtTime, PLATFORM_LABELS } from '../api';
import type { DrawerTab } from '../components/ContentDrawer';

interface CreatorsPageProps {
  refreshTick: number;
  onToast: (msg: string) => void;
  onNavigate: (tab: string) => void;
  onOpenContent: (contentId: number, tab?: DrawerTab, savedBoardId?: number | null) => void;
  onOpenRemix: (contentId: number) => void;
  onRefreshBadge: () => void;
}

interface TrackerCreator {
  id: number;
  name: string;
  platform: string;
  url: string;
  status: string;
  interval_minutes: number;
  last_checked_at: string | null;
  last_error: string | null;
  follower_count: number | null;
  content_count: number;
  unread_count: number;
  latest_published_at: string | null;
  is_running: boolean;
}

interface TrackerVideoItem {
  id: number;
  source_id: number;
  source_name: string;
  platform: string;
  canonical_url: string;
  title: string;
  author: string;
  cover_url?: string;
  summary: string;
  body: string;
  transcript: string;
  transcript_status: string;
  transcript_chars: number;
  published_at: string | null;
  discovered_at: string;
  is_read: number;
  latest_views: number | null;
  latest_likes: number | null;
  latest_comments: number | null;
  saved_board_id: number | null;
  asr_job_status: string | null;
  asr_error: string | null;
}

interface CreatorsFeedResp {
  creators: TrackerCreator[];
  items: TrackerVideoItem[];
  fallbackShown: boolean;
  totalUnread: number;
  checkIntervalMinutes: number;
  anyRunning: boolean;
}

const PLATFORM_COLORS: Record<string, string> = {
  bilibili: '#4f46e5',
  douyin: '#e11d48',
  youtube: '#dc2626',
  rss: '#0284c7',
  website: '#0d9488',
  x: '#0f172a',
};

function fmtRelativeTime(iso: string | null): string {
  if (!iso) return '尚未检查';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '刚刚';
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days <= 7) return `${days} 天前`;
  return fmtTime(iso);
}

export function CreatorsPage({
  refreshTick,
  onToast,
  onNavigate,
  onOpenRemix,
  onRefreshBadge,
}: CreatorsPageProps) {
  // 选中博主：null 表示「全部最新更新」，具体 id 表示只看该博主
  const [selectedCreatorId, setSelectedCreatorId] = useState<number | null>(null);
  // 默认只看近 7 天新更（绝不把很久之前的老视频堆出来）
  const [days, setDays] = useState<number>(7);
  const [feed, setFeed] = useState<CreatorsFeedResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [checkingAll, setCheckingAll] = useState(false);

  // 折叠式添加博主
  const [showAddForm, setShowAddForm] = useState(false);
  const [newUrl, setNewUrl] = useState('');
  const [newName, setNewName] = useState('');
  const [adding, setAdding] = useState(false);

  // 桌面弹窗新更提醒开关
  const [notifyEnabled, setNotifyEnabled] = useState<boolean>(() => {
    try {
      return localStorage.getItem('mmw_creator_notify') === '1' && typeof Notification !== 'undefined' && Notification.permission === 'granted';
    } catch {
      return false;
    }
  });

  // 文案展开与复制状态（直接在视频下方看/复制完整口播文案）
  const [expandedCopyIds, setExpandedCopyIds] = useState<Record<number, 'transcript' | 'caption'>>({});
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [busyTranscribeId, setBusyTranscribeId] = useState<number | null>(null);
  const prevTopItemIdsRef = useRef<Set<number> | null>(null);

  const loadFeed = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (selectedCreatorId) qs.set('creatorId', String(selectedCreatorId));
      qs.set('days', String(days));
      qs.set('limit', '30');
      const res = await apiRequest<CreatorsFeedResp>(`/api/radar/creators/feed?${qs.toString()}`);

      // 检测到后台静默追更拉回的新视频，立即给桌面通知与轻提示
      const curIds = new Set(res.items.map((x) => x.id));
      if (silent && prevTopItemIdsRef.current) {
        const brandNew = res.items.filter((x) => !prevTopItemIdsRef.current!.has(x.id) && x.is_read === 0);
        if (brandNew.length > 0) {
          const first = brandNew[0];
          onToast(`🆕 ${first.source_name} 刚更新了：${first.title.slice(0, 26)}`);
          if (notifyEnabled && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            new Notification(`${first.source_name} 更新了新视频`, { body: first.title });
          }
          onRefreshBadge();
        }
      }
      prevTopItemIdsRef.current = curIds;
      setFeed(res);
    } catch (err) {
      if (!silent) onToast((err as Error).message);
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    prevTopItemIdsRef.current = null;
    void loadFeed(false);
  }, [selectedCreatorId, days, refreshTick]);

  // 实时追更轮询：有显卡转写中或正在抓博主时每 3 秒刷新，平时每 30 秒静默检查有没有新更
  const hasActiveJob = Boolean(
    feed?.anyRunning ||
      feed?.items.some((it) => it.transcript_status === 'transcribing' || it.asr_job_status === 'downloading' || it.asr_job_status === 'uploading')
  );

  useEffect(() => {
    const intervalMs = hasActiveJob ? 3000 : 30000;
    const timer = window.setInterval(() => {
      void loadFeed(true);
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [hasActiveJob, selectedCreatorId, days, notifyEnabled]);

  const handleToggleNotify = async () => {
    if (typeof Notification === 'undefined') {
      onToast('当前浏览器不支持桌面提醒');
      return;
    }
    if (notifyEnabled) {
      setNotifyEnabled(false);
      localStorage.setItem('mmw_creator_notify', '0');
      onToast('已关闭桌面新更弹窗提醒');
      return;
    }
    const perm = await Notification.requestPermission();
    if (perm === 'granted') {
      setNotifyEnabled(true);
      localStorage.setItem('mmw_creator_notify', '1');
      onToast('已开启桌面提醒：博主发新视频会第一时间弹窗通知你');
    } else {
      onToast('浏览器拒绝了通知权限，可在地址栏左侧手动允许');
    }
  };

  const handleCheckAll = async () => {
    setCheckingAll(true);
    try {
      const res = await apiRequest<{ message: string }>('/api/radar/creators/check-all', { method: 'POST', body: JSON.stringify({}) });
      onToast(res.message);
      await loadFeed(true);
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setCheckingAll(false);
    }
  };

  const handleCheckOne = async (c: TrackerCreator, ev?: React.MouseEvent) => {
    ev?.stopPropagation();
    try {
      const res = await apiRequest<{ queued?: boolean; reason?: string }>(`/api/sources/${c.id}/check`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      onToast(res.queued ? `正在检查「${c.name}」的最新更新...` : res.reason || '正在追更中');
      await loadFeed(true);
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  const handleChangeInterval = async (mins: number) => {
    try {
      await apiRequest('/api/radar/creators/interval', {
        method: 'PUT',
        body: JSON.stringify({ intervalMinutes: mins }),
      });
      onToast(`已调整为每 ${mins} 分钟自动追更一次`);
      await loadFeed(true);
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  const handleAddCreator = async () => {
    if (!newUrl.trim()) {
      onToast('请先粘贴博主主页链接或抖音分享口令');
      return;
    }
    setAdding(true);
    try {
      const res = await apiRequest<{ source: { id: number; name: string }; deduplicated?: boolean }>('/api/sources', {
        method: 'POST',
        body: JSON.stringify({
          url: newUrl.trim(),
          name: newName.trim() || undefined,
          interval_minutes: feed?.checkIntervalMinutes || 30,
        }),
      });
      onToast(
        res.deduplicated
          ? `「${res.source.name}」已在名单中，正在检查最新更新...`
          : `已添加「${res.source.name}」，正在抓取最新作品（历史老视频自动静默归档，只提醒新更）...`
      );
      setNewUrl('');
      setNewName('');
      setShowAddForm(false);
      setSelectedCreatorId(res.source.id);
      await loadFeed(true);
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setAdding(false);
    }
  };

  const handleDeleteCreator = async (c: TrackerCreator, ev: React.MouseEvent) => {
    ev.stopPropagation();
    if (!window.confirm(`确定移除对标博主「${c.name}」吗？`)) return;
    await apiRequest(`/api/sources/${c.id}`, { method: 'DELETE' });
    onToast(`已移除「${c.name}」`);
    if (selectedCreatorId === c.id) setSelectedCreatorId(null);
    await loadFeed(true);
    onRefreshBadge();
  };

  const handleMarkRead = async (creatorId?: number | null) => {
    await apiRequest('/api/radar/creators/mark-read', {
      method: 'POST',
      body: JSON.stringify(creatorId ? { creatorId } : {}),
    });
    onToast('已全部标为已看');
    await loadFeed(true);
    onRefreshBadge();
  };

  // 一键用本机 RTX 显卡免费提取完整口播文案，并自动展开等待出稿
  const handleExtractTranscript = async (item: TrackerVideoItem) => {
    setBusyTranscribeId(item.id);
    try {
      const res = await apiRequest<{ message?: string }>(`/api/radar/intel/${item.id}/transcribe`, { method: 'POST' });
      onToast(res.message || '已启动本机显卡离线提取口播文案，出稿后会自动显示在下方');
      setExpandedCopyIds((prev) => ({ ...prev, [item.id]: 'transcript' }));
      if (item.is_read === 0) {
        void apiRequest('/api/radar/creators/mark-read', { method: 'POST', body: JSON.stringify({ contentId: item.id }) });
      }
      await loadFeed(true);
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setBusyTranscribeId(null);
    }
  };

  const toggleExpand = (item: TrackerVideoItem, mode: 'transcript' | 'caption') => {
    setExpandedCopyIds((prev) => {
      if (prev[item.id] === mode) {
        const next = { ...prev };
        delete next[item.id];
        return next;
      }
      return { ...prev, [item.id]: mode };
    });
    if (item.is_read === 0) {
      void apiRequest('/api/radar/creators/mark-read', {
        method: 'POST',
        body: JSON.stringify({ contentId: item.id }),
      }).then(() => {
        void loadFeed(true);
        onRefreshBadge();
      });
    }
  };

  const handleCopyText = async (id: number, text: string) => {
    if (!text.trim()) return;
    try {
      await navigator.clipboard.writeText(text.trim());
      setCopiedId(id);
      onToast('已复制完整文案');
      window.setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1800);
    } catch {
      onToast('复制失败，请手动选中复制');
    }
  };

  const handleToggleStar = async (item: TrackerVideoItem) => {
    try {
      if (item.saved_board_id) {
        await apiRequest(`/api/radar/board/${item.saved_board_id}`, { method: 'DELETE' });
        onToast('已取消收藏');
      } else {
        await apiRequest('/api/radar/board', {
          method: 'POST',
          body: JSON.stringify({
            title: item.title,
            source_content_id: item.id,
            core_angle: (item.transcript || item.summary || '').slice(0, 200),
            notes: item.transcript || '',
            tags: [PLATFORM_LABELS[item.platform] || item.platform, item.source_name].filter(Boolean),
            source_url: item.canonical_url,
          }),
        });
        onToast('已收藏到「简易收藏本」');
      }
      await loadFeed(true);
      onRefreshBadge();
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  const creators = feed?.creators || [];
  const items = feed?.items || [];
  const activeCreator = selectedCreatorId ? creators.find((c) => c.id === selectedCreatorId) || null : null;

  return (
    <div>
      {/* 顶部极简追更控制条（只放追更频率、立即追更、提醒与添加博主） */}
      <div className="panel-card" style={{ padding: '12px 16px', marginBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <button
              type="button"
              data-testid="creators-check-all-btn"
              className="btn btn-primary btn-sm"
              disabled={checkingAll || feed?.anyRunning}
              onClick={() => void handleCheckAll()}
            >
              <RefreshCw size={13} /> {checkingAll || feed?.anyRunning ? '正在追更中...' : '立即追更全部博主'}
            </button>

            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--text-muted)' }}>
              <Clock size={13} />
              <span>自动追更：</span>
              <select
                className="select"
                data-testid="creators-interval-select"
                style={{ width: 112, padding: '4px 8px', fontSize: 12.5 }}
                value={feed?.checkIntervalMinutes || 30}
                onChange={(e) => void handleChangeInterval(Number(e.target.value))}
              >
                <option value={15}>每 15 分钟</option>
                <option value={30}>每 30 分钟</option>
                <option value={60}>每 1 小时</option>
                <option value={120}>每 2 小时</option>
              </select>
            </label>

            <button
              type="button"
              className={`btn btn-sm ${notifyEnabled ? 'btn-primary' : ''}`}
              onClick={() => void handleToggleNotify()}
            >
              {notifyEnabled ? <Bell size={13} /> : <BellOff size={13} />}
              {notifyEnabled ? '桌面新更提醒已开' : '开启桌面新更提醒'}
            </button>
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button type="button" className="btn btn-sm" onClick={() => onNavigate('browsers')}>
              登录态
            </button>
            <button
              type="button"
              data-testid="creators-toggle-add-btn"
              className="btn btn-primary btn-sm"
              onClick={() => setShowAddForm((v) => !v)}
            >
              <Plus size={14} /> 添加对标博主
            </button>
          </div>
        </div>

        {/* 折叠式添加博主条：平时不占地方，点按钮才展开 */}
        {showAddForm && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
            <input
              className="input"
              style={{ flex: '2 1 300px' }}
              placeholder="粘贴抖音分享口令 / 抖音主页 / B站UP主空间 / YouTube 链接..."
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void handleAddCreator()}
            />
            <input
              className="input"
              style={{ flex: '1 1 130px', maxWidth: 170 }}
              placeholder="备注名（可选）"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <button type="button" className="btn btn-primary btn-sm" disabled={adding} onClick={() => void handleAddCreator()}>
              {adding ? '添加中...' : '确认添加并开始追更'}
            </button>
          </div>
        )}
      </div>

      {/* 主体极简双栏：左 = 按博主分类 | 右 = 选中博主的最新更新 & 直接拿文案 */}
      <div className="tracker-shell">
        {/* 左栏：博主分类清单 */}
        <aside className="tracker-sidebar">
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', padding: '2px 8px 8px' }}>
            按博主分类（共 {creators.length} 位）
          </div>

          <div
            data-testid="creator-cat-all"
            className={`tracker-creator-row ${selectedCreatorId === null ? 'active' : ''}`}
            onClick={() => setSelectedCreatorId(null)}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
              <span style={{ fontWeight: 700, fontSize: 13.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Sparkles size={14} color="#4f46e5" /> 全部最新更新
              </span>
              {(feed?.totalUnread || 0) > 0 && (
                <span className="badge badge-red" style={{ fontSize: 11 }}>
                  +{feed!.totalUnread} 新
                </span>
              )}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 3 }}>
              按发布时间倒序，第一时间看谁发新了
            </div>
          </div>

          <div style={{ height: 1, background: 'var(--border)', margin: '8px 4px' }} />

          {creators.length === 0 ? (
            <div style={{ padding: '20px 10px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12.5 }}>
              还没有添加博主，点右上角「添加对标博主」即可开始实时追更。
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {creators.map((c) => {
                const selected = selectedCreatorId === c.id;
                const pColor = PLATFORM_COLORS[c.platform] || '#4f46e5';
                return (
                  <div
                    key={c.id}
                    data-testid={`creator-cat-${c.id}`}
                    className={`tracker-creator-row ${selected ? 'active' : ''}`}
                    onClick={() => setSelectedCreatorId(c.id)}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                        <span
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: 999,
                            background: pColor,
                            flexShrink: 0,
                          }}
                        />
                        <span style={{ fontWeight: 700, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {c.name}
                        </span>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                        {c.is_running && <span className="badge badge-blue" style={{ fontSize: 10.5 }}>追更中</span>}
                        {c.unread_count > 0 && (
                          <span className="badge badge-red" style={{ fontSize: 11 }}>
                            +{c.unread_count} 新
                          </span>
                        )}
                      </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 4, fontSize: 11.5, color: 'var(--text-muted)' }}>
                      <span>
                        {PLATFORM_LABELS[c.platform] || c.platform} · {fmtRelativeTime(c.last_checked_at)}查过
                      </span>
                      <div style={{ display: 'flex', gap: 2 }}>
                        <button
                          type="button"
                          className="icon-ghost-btn"
                          title="立刻检查这位博主更新"
                          onClick={(e) => void handleCheckOne(c, e)}
                        >
                          <RefreshCw size={12} />
                        </button>
                        <button
                          type="button"
                          className="icon-ghost-btn"
                          title="移除这位博主"
                          onClick={(e) => void handleDeleteCreator(c, e)}
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </aside>

        {/* 右栏：只看当前博主最新更新 + 一键拿文案 */}
        <section className="panel-card" style={{ marginBottom: 0 }}>
          {/* 右栏极简头部 */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', paddingBottom: 12, borderBottom: '1px solid var(--border)', marginBottom: 14 }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 16.5, fontWeight: 800, color: 'var(--text)' }}>
                  {activeCreator ? activeCreator.name : '全部对标博主 · 最新更新'}
                </span>
                {activeCreator && (
                  <span
                    className="plat-badge"
                    style={{ background: PLATFORM_COLORS[activeCreator.platform] || '#4f46e5' }}
                  >
                    {PLATFORM_LABELS[activeCreator.platform] || activeCreator.platform}
                  </span>
                )}
                {activeCreator?.follower_count != null && (
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>粉丝 {fmtNum(activeCreator.follower_count)}</span>
                )}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                {activeCreator
                  ? `上次追更：${fmtRelativeTime(activeCreator.last_checked_at)} · 有新更自动排最前面`
                  : '默认只看近 7 天新更，不翻很久以前的老视频；点击任意视频直接拿完整口播文案'}
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <div className="pill-group">
                {[
                  { d: 7, l: '近 7 天新更' },
                  { d: 30, l: '近 30 天' },
                  { d: 0, l: '全部历史' },
                ].map((opt) => (
                  <button
                    key={opt.d}
                    type="button"
                    data-testid={`creators-days-${opt.d}`}
                    className={`pill-btn ${days === opt.d ? 'active' : ''}`}
                    onClick={() => setDays(opt.d)}
                  >
                    {opt.l}
                  </button>
                ))}
              </div>

              {activeCreator && (
                <button type="button" className="btn btn-sm" onClick={() => void handleCheckOne(activeCreator)}>
                  <RefreshCw size={12} /> 查更新
                </button>
              )}

              {((activeCreator ? activeCreator.unread_count : feed?.totalUnread) || 0) > 0 && (
                <button type="button" className="btn btn-sm" onClick={() => void handleMarkRead(selectedCreatorId)}>
                  <CheckCheck size={13} /> 标为已看
                </button>
              )}
            </div>
          </div>

          {/* 若近 7 天暂无新更新，明确提示当前仅展示最近几条，绝不堆老视频 */}
          {feed?.fallbackShown && (
            <div
              style={{
                padding: '9px 12px',
                borderRadius: 9,
                background: '#f8fafc',
                color: '#475569',
                fontSize: 12.5,
                marginBottom: 12,
              }}
            >
              近 {days} 天暂无新发布，已为你保留最新 {items.length} 条方便随时提取文案；一旦博主发新视频会第一时间推到最顶部。
            </div>
          )}

          {loading && !feed ? (
            <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-muted)' }}>加载最新更新中...</div>
          ) : items.length === 0 ? (
            <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-muted)' }}>
              还没有抓到作品，点上方「立即追更全部博主」拉取最新内容。
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {items.map((item) => {
                const hasTranscript = Boolean(item.transcript && item.transcript.trim().length >= 30);
                const isTranscribing =
                  busyTranscribeId === item.id ||
                  item.transcript_status === 'transcribing' ||
                  item.asr_job_status === 'downloading' ||
                  item.asr_job_status === 'uploading';
                const expandedMode = expandedCopyIds[item.id];
                const captionText = (item.body || item.summary || '').trim();
                const showUnreadBadge = item.is_read === 0 && !feed?.fallbackShown;

                return (
                  <div key={item.id} className={`tracker-video-card ${showUnreadBadge ? 'is-new' : ''}`} data-testid={`tracker-item-${item.id}`}>
                    <div className="tracker-video-main">
                      {/* 16:9 缩略图 */}
                      <a
                        href={item.canonical_url}
                        target="_blank"
                        rel="noreferrer"
                        className="tracker-thumb"
                        title="打开原视频"
                      >
                        {item.cover_url ? (
                          <img src={item.cover_url} alt={item.title} referrerPolicy="no-referrer" loading="lazy" />
                        ) : (
                          <div className="vcard-fallback-text">{PLATFORM_LABELS[item.platform] || item.platform}</div>
                        )}
                      </a>

                      {/* 中右：更新信息 + 标题 + 直接拿文案按钮 */}
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', marginBottom: 5 }}>
                          {showUnreadBadge && (
                            <span className="badge badge-red" style={{ fontSize: 11 }}>
                              新更新
                            </span>
                          )}
                          {!activeCreator && (
                            <span
                              className="badge badge-gray"
                              style={{ fontSize: 11, cursor: 'pointer' }}
                              onClick={() => setSelectedCreatorId(item.source_id)}
                            >
                              {item.source_name}
                            </span>
                          )}
                          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                            {(() => {
                              const ts = item.published_at || item.discovered_at;
                              const abs = fmtTime(ts);
                              const rel = fmtRelativeTime(ts);
                              return rel && rel !== abs ? `${abs}（${rel}）` : abs;
                            })()}
                          </span>
                          {item.latest_views != null && (
                            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>· ▶ {fmtNum(item.latest_views)}</span>
                          )}
                          {item.latest_likes != null && (
                            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>· 👍 {fmtNum(item.latest_likes)}</span>
                          )}
                        </div>

                        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', lineHeight: 1.45, marginBottom: 10 }}>
                          {item.title}
                        </div>

                        {/* 核心操作：只保留「拿文案 / 复制 / 去二创 / 收藏 / 原链」 */}
                        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', alignItems: 'center' }}>
                          {hasTranscript ? (
                            <>
                              <button
                                type="button"
                                data-testid={`btn-toggle-script-${item.id}`}
                                className={`btn btn-sm ${expandedMode === 'transcript' ? 'btn-primary' : ''}`}
                                style={expandedMode === 'transcript' ? undefined : { background: '#f0fdf4', borderColor: '#bbf7d0', color: '#15803d' }}
                                onClick={() => toggleExpand(item, 'transcript')}
                              >
                                <FileText size={13} />
                                {expandedMode === 'transcript' ? '收起口播文案' : `查看完整口播文案 (${item.transcript_chars}字)`}
                                {expandedMode === 'transcript' ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                              </button>
                              <button
                                type="button"
                                data-testid={`btn-copy-script-${item.id}`}
                                className="btn btn-sm"
                                onClick={() => void handleCopyText(item.id, item.transcript)}
                              >
                                {copiedId === item.id ? <Check size={13} /> : <Copy size={13} />}
                                {copiedId === item.id ? '已复制' : '复制文案'}
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              data-testid={`btn-extract-script-${item.id}`}
                              className="btn btn-primary btn-sm"
                              disabled={isTranscribing}
                              onClick={() => void handleExtractTranscript(item)}
                            >
                              <Mic size={13} />
                              {isTranscribing
                                ? item.asr_job_status === 'downloading'
                                  ? '第 1/2 步：提取音频中...'
                                  : '第 2/2 步：显卡转写文案中...'
                                : '一键获取口播文案 (免费免登录)'}
                            </button>
                          )}

                          {!hasTranscript && captionText && captionText !== item.title && (
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={() => toggleExpand(item, 'caption')}
                            >
                              {expandedMode === 'caption' ? '收起原帖文字' : '看原帖文字'}
                            </button>
                          )}

                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => onOpenRemix(item.id)}
                          >
                            <Wand2 size={13} /> AI 二创改写
                          </button>

                          <button
                            type="button"
                            className={`btn btn-sm ${item.saved_board_id ? 'btn-star-active' : ''}`}
                            onClick={() => void handleToggleStar(item)}
                            title={item.saved_board_id ? '取消收藏' : '收藏到本子'}
                          >
                            <Star size={12} fill={item.saved_board_id ? 'currentColor' : 'none'} />
                          </button>

                          <a
                            href={item.canonical_url}
                            target="_blank"
                            rel="noreferrer"
                            className="btn btn-sm"
                            style={{ textDecoration: 'none' }}
                          >
                            <ExternalLink size={12} /> 原视频
                          </a>
                        </div>
                      </div>
                    </div>

                    {/* 内联展开的博主完整文案区（无需跳页，直接读、直接复制） */}
                    {expandedMode && (
                      <div className="tracker-script-drawer" data-testid={`script-drawer-${item.id}`}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                          <span style={{ fontSize: 12.5, fontWeight: 700, color: '#3730a3' }}>
                            {expandedMode === 'transcript'
                              ? hasTranscript
                                ? `完整口播文案（共 ${item.transcript.length} 字 · 本机显卡免登录提取）`
                                : isTranscribing
                                  ? '正在提取纯音频并用 RTX 显卡转写中，完成后会自动出现在下方...'
                                  : item.asr_error || '暂未完成转写，可点击上方按钮重试'
                              : '原帖文案 / 简介'}
                          </span>
                          <div style={{ display: 'flex', gap: 6 }}>
                            {(expandedMode === 'transcript' ? item.transcript : captionText) && (
                              <button
                                type="button"
                                className="btn btn-primary btn-sm"
                                onClick={() =>
                                  void handleCopyText(
                                    item.id,
                                    expandedMode === 'transcript' ? item.transcript : captionText
                                  )
                                }
                              >
                                {copiedId === item.id ? <Check size={12} /> : <Copy size={12} />} 复制全文
                              </button>
                            )}
                            <button type="button" className="btn btn-sm" onClick={() => onOpenRemix(item.id)}>
                              <Wand2 size={12} /> 基于这篇写二创稿
                            </button>
                          </div>
                        </div>

                        <div className="tracker-script-text">
                          {expandedMode === 'transcript'
                            ? item.transcript || (isTranscribing ? '正在处理中，通常十几秒到一分钟自动出稿，期间可切去看其他博主...' : '暂无内容')
                            : captionText}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
