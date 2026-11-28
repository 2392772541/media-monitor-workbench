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
  ListChecks,
  RotateCcw,
  Flame,
  MessageSquareText,
  Search,
  History,
  Trophy,
  Scale,
  PanelRightOpen,
} from 'lucide-react';
import {
  analyzeContentR2,
  apiRequest,
  compareCreatorsRemix,
  extractCommentTopics,
  fetchCreatorHistory,
  fetchCreatorsFeed,
  fmtNum,
  fmtTime,
  PLATFORM_LABELS,
  saveCommentTopicToBoard,
} from '../api';
import type { DrawerTab } from '../components/ContentDrawer';
import type {
  CommentTopicIdeaItem,
  CreatorCopyDigest,
  CreatorsFeedResp,
  R2AnalysisPayload,
  RemixCompareResponse,
  TrackerCreator,
  TrackerVideoItem,
} from '../types';

interface CreatorsPageProps {
  refreshTick: number;
  onToast: (msg: string) => void;
  onNavigate: (tab: string) => void;
  onOpenContent: (contentId: number, tab?: DrawerTab, savedBoardId?: number | null) => void;
  onOpenRemix: (contentId: number) => void;
  onRefreshBadge: () => void;
}

const PLATFORM_COLORS: Record<string, string> = {
  bilibili: '#4f46e5',
  douyin: '#e11d48',
  youtube: '#dc2626',
  kuaishou: '#f97316',
  xiaohongshu: '#ef4444',
  'wechat-channels': '#10b981',
  rss: '#0284c7',
  website: '#0d9488',
  x: '#0f172a',
};

const HEAT_LEVEL_LABELS: Record<R2AnalysisPayload['heatLevel'], string> = {
  viral: '大爆款',
  hot: '较火',
  normal: '表现平稳',
  low: '热度偏弱',
  unknown: '数据不足',
};

const VERTICAL_PLATFORMS = new Set(['douyin', 'kuaishou', 'xiaohongshu', 'wechat-channels']);
const VIDEO_PLATFORMS = new Set(['douyin', 'bilibili', 'youtube', 'kuaishou', 'xiaohongshu', 'wechat-channels']);
const COMMENT_SUPPORTED_PLATFORMS = new Set(['douyin', 'bilibili', 'kuaishou', 'xiaohongshu']);

function isVideoPlatform(platform: string): boolean {
  return VIDEO_PLATFORMS.has(String(platform || '').trim().toLowerCase());
}

function getPipelineStageLabel(stage: string, queuePos?: number | null): string {
  if (stage === 'queued') {
    return `排队中（第 ${queuePos && queuePos > 0 ? queuePos : 1} 位）· 等前一条转完后自动提取音频 → 显卡转口播 → 深度归纳 1234`;
  }
  if (stage === 'downloading') {
    return '第 1/3 步：正在提取视频纯音频...';
  }
  if (stage === 'transcribing') {
    return '第 2/3 步：本机 RTX 显卡离线转写完整口播文案中（免登录，通常 10～30 秒）...';
  }
  if (stage === 'digesting') {
    return '第 3/3 步：完整口播已转完，正基于逐字稿深度提炼 1234 要点与行动...';
  }
  return '正在处理口播转写与深度归纳...';
}

// 按平台原生画幅决定封面展示方式：抖音/快手/小红书用 9:16 竖屏，B站/YouTube用 16:9 横屏，无封面的图文源不占空黑框
function getMediaOrientation(item: TrackerVideoItem): 'vertical' | 'horizontal' | 'none' {
  if (VERTICAL_PLATFORMS.has(item.platform)) return 'vertical';
  if (item.platform === 'bilibili' || item.platform === 'youtube') return 'horizontal';
  if (item.cover_url && item.cover_url.trim()) return 'horizontal';
  return 'none';
}

function formatDigestForCopy(item: TrackerVideoItem, digest: CreatorCopyDigest): string {
  const lines = [
    `【${item.source_name}】${item.title.slice(0, 60)}`,
    `大概讲什么：${digest.overview}`,
    '',
    '核心要点：',
    ...digest.keyPoints.map((pt, idx) => `${idx + 1}. ${pt}`),
    '',
    '对我有啥用 / 可以做什么：',
    ...digest.actionItems.map((act, idx) => `${idx + 1}. ${act}`),
  ];
  return lines.join('\n');
}

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
  onOpenContent,
  onOpenRemix,
  onRefreshBadge,
}: CreatorsPageProps) {
  // 选中博主：null 表示「全部最新更新」，具体 id 表示只看该博主（自动切全部历史）
  const [selectedCreatorId, setSelectedCreatorId] = useState<number | null>(null);
  const [days, setDays] = useState<number>(7);
  const [includeRss, setIncludeRss] = useState<boolean>(false);
  const [searchInput, setSearchInput] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState<string>('');

  const [feed, setFeed] = useState<CreatorsFeedResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [checkingAll, setCheckingAll] = useState(false);

  // 折叠式添加博主
  const [showAddForm, setShowAddForm] = useState(false);
  const [newUrl, setNewUrl] = useState('');
  const [newName, setNewName] = useState('');
  const [adding, setAdding] = useState(false);

  // 桌面弹窗新更提醒开关
  const [notifyEnabled, setNotifyEnabled] = useState<boolean>(() => {
    try {
      return (
        localStorage.getItem('mmw_creator_notify') === '1' &&
        typeof Notification !== 'undefined' &&
        Notification.permission === 'granted'
      );
    } catch {
      return false;
    }
  });

  // 文案展开、复制、1234 归纳、R2 三维分析与二创对比、历史拉取状态
  const [expandedCopyIds, setExpandedCopyIds] = useState<Record<number, 'transcript' | 'caption'>>({});
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [busyTranscribeId, setBusyTranscribeId] = useState<number | null>(null);
  const [busyDigestId, setBusyDigestId] = useState<number | null>(null);
  const [busyR2Id, setBusyR2Id] = useState<number | null>(null);
  const [busyCommentTopicsId, setBusyCommentTopicsId] = useState<number | null>(null);
  const [savingTopicId, setSavingTopicId] = useState<number | null>(null);
  const [collapsedCommentTopicIds, setCollapsedCommentTopicIds] = useState<Record<number, boolean>>({});
  const [batchCommentProgress, setBatchCommentProgress] = useState<{
    done: number;
    total: number;
    currentTitle?: string;
  } | null>(null);
  const [busyFetchHistoryId, setBusyFetchHistoryId] = useState<number | null>(null);
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null);

  const [selectedCompareIds, setSelectedCompareIds] = useState<number[]>([]);
  const [comparing, setComparing] = useState(false);
  const [compareResult, setCompareResult] = useState<RemixCompareResponse | null>(null);

  const prevTopItemIdsRef = useRef<Set<number> | null>(null);
  const itemsLenRef = useRef<number>(0);
  const loadingMoreRef = useRef<boolean>(false);
  const filterKeyRef = useRef<string>('');
  const requestSeqRef = useRef<number>(0);
  const feedAbortRef = useRef<AbortController | null>(null);
  const loadMoreAbortRef = useRef<AbortController | null>(null);
  const nonSilentInFlightRef = useRef<boolean>(false);
  const activeFilterRef = useRef({
    creatorId: selectedCreatorId,
    days,
    includeRss,
    searchQuery,
  });
  activeFilterRef.current = {
    creatorId: selectedCreatorId,
    days,
    includeRss,
    searchQuery,
  };

  useEffect(() => {
    itemsLenRef.current = feed?.items.length || 0;
  }, [feed?.items.length]);

  useEffect(() => {
    return () => {
      feedAbortRef.current?.abort();
      loadMoreAbortRef.current?.abort();
    };
  }, []);

  // 搜索框防抖同步
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearchQuery(searchInput.trim());
    }, 320);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const loadFeed = async (silent = false, preserveLoadedCount = false) => {
    if (silent && (loadingMoreRef.current || nonSilentInFlightRef.current)) return;
    const seq = ++requestSeqRef.current;
    feedAbortRef.current?.abort();
    const controller = new AbortController();
    feedAbortRef.current = controller;
    if (!silent) {
      loadMoreAbortRef.current?.abort();
      loadMoreAbortRef.current = null;
      loadingMoreRef.current = false;
      setLoadingMore(false);
      nonSilentInFlightRef.current = true;
      setLoading(true);
    }
    try {
      const targetLimit =
        silent || preserveLoadedCount ? Math.min(200, Math.max(30, itemsLenRef.current)) : 30;
      const {
        creatorId: activeCreatorId,
        days: activeDays,
        includeRss: activeIncludeRss,
        searchQuery: activeSearchQuery,
      } = activeFilterRef.current;
      const res = await fetchCreatorsFeed(
        {
          creatorId: activeCreatorId,
          days: activeDays,
          offset: 0,
          limit: targetLimit,
          includeRss: activeIncludeRss,
          search: activeSearchQuery,
        },
        { signal: controller.signal }
      );
      if (seq !== requestSeqRef.current || controller.signal.aborted) return;

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
      if (controller.signal.aborted || (err as Error)?.name === 'AbortError' || seq !== requestSeqRef.current) {
        return;
      }
      if (!silent) onToast((err as Error).message);
    } finally {
      if (feedAbortRef.current === controller) {
        feedAbortRef.current = null;
      }
      if (!silent && seq === requestSeqRef.current) {
        nonSilentInFlightRef.current = false;
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    const nextFilterKey = `${selectedCreatorId ?? 'all'}|${days}|${includeRss ? 1 : 0}|${searchQuery}`;
    const filterChanged = filterKeyRef.current !== '' && filterKeyRef.current !== nextFilterKey;
    filterKeyRef.current = nextFilterKey;
    if (filterChanged) {
      itemsLenRef.current = 0;
      prevTopItemIdsRef.current = null;
      setCompareResult(null);
      setSelectedCompareIds([]);
    }
    void loadFeed(false, !filterChanged && itemsLenRef.current > 30);
  }, [selectedCreatorId, days, includeRss, searchQuery, refreshTick]);

  // 实时追更与显卡流水线轮询：有显卡转写/深度归纳或正在抓博主时每 2.5 秒刷新，平时每 30 秒静默检查
  const hasActiveJob = Boolean(
    feed?.anyRunning ||
      feed?.asrRunning ||
      feed?.items.some(
        (it) =>
          Boolean(it.pipeline_stage) ||
          it.transcript_status === 'transcribing' ||
          it.asr_job_status === 'queued' ||
          it.asr_job_status === 'downloading' ||
          it.asr_job_status === 'uploading' ||
          it.asr_job_status === 'digesting'
      )
  );

  useEffect(() => {
    const intervalMs = hasActiveJob ? 2500 : 30000;
    const timer = window.setInterval(() => {
      void loadFeed(true, true);
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [hasActiveJob, selectedCreatorId, days, includeRss, searchQuery, notifyEnabled]);

  // R3：切换博主时默认看全部历史，切回「全部最新更新」恢复近 7 天
  const handleSelectCreator = (creatorId: number | null) => {
    setSelectedCreatorId(creatorId);
    setDays(creatorId === null ? 7 : 0);
  };

  // R3：加载更多历史作品（offset/limit 分页去重追加）
  const handleLoadMore = async () => {
    if (!feed?.hasMore || loadingMoreRef.current) return;
    const seq = requestSeqRef.current;
    loadMoreAbortRef.current?.abort();
    const controller = new AbortController();
    loadMoreAbortRef.current = controller;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const {
        creatorId: activeCreatorId,
        days: activeDays,
        includeRss: activeIncludeRss,
        searchQuery: activeSearchQuery,
      } = activeFilterRef.current;
      const res = await fetchCreatorsFeed(
        {
          creatorId: activeCreatorId,
          days: activeDays,
          offset: feed.items.length,
          limit: 30,
          includeRss: activeIncludeRss,
          search: activeSearchQuery,
        },
        { signal: controller.signal }
      );
      if (seq !== requestSeqRef.current || controller.signal.aborted) return;
      setFeed((prev) => {
        if (!prev) return res;
        const existing = new Set(prev.items.map((x) => x.id));
        const appended = res.items.filter((x) => !existing.has(x.id));
        return {
          ...res,
          items: [...prev.items, ...appended],
        };
      });
    } catch (err) {
      if (controller.signal.aborted || (err as Error)?.name === 'AbortError' || seq !== requestSeqRef.current) {
        return;
      }
      onToast((err as Error).message);
    } finally {
      if (loadMoreAbortRef.current === controller) {
        loadMoreAbortRef.current = null;
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  };

  // R3：按需从平台拉取更早历史作品
  const handleFetchHistory = async (creator: TrackerCreator) => {
    setBusyFetchHistoryId(creator.id);
    try {
      const res = await fetchCreatorHistory(creator.id, 3);
      onToast(
        `已拉取「${creator.name}」历史作品：获取 ${res.fetchedCount} 条（新增 ${res.insertedCount} 条，库内共 ${res.totalStored} 条）`
      );
      if (activeFilterRef.current.days !== 0) {
        setDays(0);
      } else {
        await loadFeed(true, true);
      }
      onRefreshBadge();
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setBusyFetchHistoryId(null);
    }
  };

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
      const res = await apiRequest<{ message: string }>('/api/radar/creators/check-all', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      onToast(res.message);
      await loadFeed(true, true);
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
      await loadFeed(true, true);
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
      await loadFeed(true, true);
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
          : `已添加「${res.source.name}」，正在抓取最新作品...`
      );
      setNewUrl('');
      setNewName('');
      setShowAddForm(false);
      handleSelectCreator(res.source.id);
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
    if (selectedCreatorId === c.id) handleSelectCreator(null);
    await loadFeed(true, true);
    onRefreshBadge();
  };

  const handleMarkRead = async (creatorId?: number | null) => {
    await apiRequest('/api/radar/creators/mark-read', {
      method: 'POST',
      body: JSON.stringify(creatorId ? { creatorId } : {}),
    });
    onToast('已全部标为已看');
    await loadFeed(true, true);
    onRefreshBadge();
  };

  // 一键用本机 RTX 显卡免费提取完整口播文案
  const handleExtractTranscript = async (item: TrackerVideoItem) => {
    setBusyTranscribeId(item.id);
    try {
      const res = await apiRequest<{ message?: string }>(`/api/radar/intel/${item.id}/transcribe`, {
        method: 'POST',
      });
      onToast(res.message || '已启动本机显卡离线提取口播文案，出稿后会自动显示在下方');
      setExpandedCopyIds((prev) => ({ ...prev, [item.id]: 'transcript' }));
      if (item.is_read === 0) {
        void apiRequest('/api/radar/creators/mark-read', {
          method: 'POST',
          body: JSON.stringify({ contentId: item.id }),
        });
      }
      await loadFeed(true, true);
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
        void loadFeed(true, true);
        onRefreshBadge();
      });
    }
  };

  const handleCopyText = async (key: string, text: string, label = '已复制完整文案') => {
    if (!text.trim()) return;
    try {
      await navigator.clipboard.writeText(text.trim());
      setCopiedKey(key);
      onToast(label);
      window.setTimeout(() => setCopiedKey((cur) => (cur === key ? null : cur)), 1800);
    } catch {
      onToast('复制失败，请手动选中复制');
    }
  };

  const patchItemInFeed = (contentId: number, patch: Partial<TrackerVideoItem>) => {
    setFeed((prev) => {
      if (!prev) return prev;
      const updateList = (list: TrackerVideoItem[]) =>
        list.map((x) => (x.id === contentId ? { ...x, ...patch } : x));
      return {
        ...prev,
        items: updateList(prev.items),
        todayUpdates: {
          ...prev.todayUpdates,
          items: updateList(prev.todayUpdates.items),
        },
        todayLeaderboard: {
          ...prev.todayLeaderboard,
          items: prev.todayLeaderboard.items.map((x) => (x.id === contentId ? { ...x, ...patch } : x)),
        },
      };
    });
  };

  // R2：单条视频三维 AI 分析（讲了什么 / 火不火 / 是否适合二次创作）
  const handleR2Analyze = async (item: TrackerVideoItem, force = false) => {
    setBusyR2Id(item.id);
    try {
      const res = await analyzeContentR2(item.id, force);
      patchItemInFeed(item.id, { r2_analysis: res.analysis });
      if (item.is_read === 0) {
        void apiRequest('/api/radar/creators/mark-read', {
          method: 'POST',
          body: JSON.stringify({ contentId: item.id }),
        }).then(() => onRefreshBadge());
      }
      onToast(
        res.analysis.basisSource === '口播全文+真实数据'
          ? '已完成「口播+数据」AI 三维分析'
          : '已完成 AI 三维分析（提取口播后可一键升级）'
      );
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setBusyR2Id(null);
    }
  };

  // R2：多视频对比哪条最适合二次创作
  const toggleCompareSelect = (contentId: number) => {
    setSelectedCompareIds((prev) =>
      prev.includes(contentId) ? prev.filter((id) => id !== contentId) : [...prev, contentId].slice(0, 12)
    );
  };

  const handleCompareRemix = async () => {
    setComparing(true);
    try {
      const visibleIds = items.slice(0, 8).map((x) => x.id);
      const idsToSend = selectedCompareIds.length > 0 ? selectedCompareIds : visibleIds;
      const res = await compareCreatorsRemix({
        contentIds: idsToSend.length > 0 ? idsToSend : undefined,
        creatorId: selectedCreatorId,
      });
      setCompareResult(res);
      if (res.rankings.length === 0) {
        onToast('当前暂无可供对比的视频');
      } else {
        onToast(`已对比 ${res.rankings.length} 条视频，并标出最推荐二创作品`);
      }
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setComparing(false);
    }
  };

  // 单条视频深度 1234 归纳：若尚无完整口播，后端自动启动「提音频 → RTX显卡转写 → 按完整口播归纳 1234」（绝不靠标题硬猜）
  const handleGenerateDigest = async (item: TrackerVideoItem, forceRefresh = false) => {
    setBusyDigestId(item.id);
    try {
      const res = await apiRequest<{
        ok: boolean;
        status?: 'done' | 'transcribing';
        queued?: boolean;
        position?: number;
        message?: string;
        digest?: CreatorCopyDigest;
        cached?: boolean;
      }>(`/api/radar/intel/${item.id}/copy-digest`, {
        method: 'POST',
        body: JSON.stringify({ forceRefresh }),
      });

      if (res.status === 'transcribing' || res.queued) {
        patchItemInFeed(item.id, {
          transcript_status: 'transcribing',
          pipeline_stage: res.position && res.position > 0 ? 'queued' : 'downloading',
          queue_position: res.position ?? 0,
        });
        onToast(res.message || '已启动本机显卡转写完整口播，转完后会自动生成 1234 深度归纳');
        void loadFeed(true, true);
      } else if (res.digest) {
        patchItemInFeed(item.id, { copy_digest: res.digest, pipeline_stage: null, queue_position: null });
        onToast(forceRefresh ? '已按完整口播重新提炼 1234 深度要点' : '已按完整口播生成 1234 深度要点与行动建议');
      }

      if (item.is_read === 0) {
        void apiRequest('/api/radar/creators/mark-read', {
          method: 'POST',
          body: JSON.stringify({ contentId: item.id }),
        }).then(() => onRefreshBadge());
      }
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setBusyDigestId(null);
    }
  };

  // 批量转写并归纳本页前 3 条未归纳视频（未转口播的自动串行进入 RTX 显卡队列，转完逐条出 1234 深度归纳）
  const handleBatchDigest = async () => {
    const targets = items.filter((it) => !it.copy_digest && !it.pipeline_stage).slice(0, 3);
    if (targets.length === 0) {
      onToast('当前这页视频都已经归纳好了或正在转写队列中');
      return;
    }
    setBatchProgress({ done: 0, total: targets.length });
    let doneCount = 0;
    let queuedCount = 0;
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      setBusyDigestId(target.id);
      try {
        const res = await apiRequest<{
          ok: boolean;
          status?: 'done' | 'transcribing';
          queued?: boolean;
          position?: number;
          digest?: CreatorCopyDigest;
        }>(`/api/radar/intel/${target.id}/copy-digest`, {
          method: 'POST',
          body: JSON.stringify({ forceRefresh: false }),
        });
        if (res.status === 'transcribing' || res.queued) {
          queuedCount++;
          patchItemInFeed(target.id, {
            transcript_status: 'transcribing',
            pipeline_stage: res.position && res.position > 0 ? 'queued' : 'downloading',
            queue_position: res.position ?? 0,
          });
        } else if (res.digest) {
          doneCount++;
          patchItemInFeed(target.id, { copy_digest: res.digest });
        }
      } catch (err) {
        onToast(`《${target.title.slice(0, 14)}》处理失败：${(err as Error).message}`);
        break;
      } finally {
        setBatchProgress({ done: i + 1, total: targets.length });
      }
    }
    setBusyDigestId(null);
    setBatchProgress(null);
    if (doneCount > 0 || queuedCount > 0) {
      const parts: string[] = [];
      if (doneCount > 0) parts.push(`已完成 ${doneCount} 条深度归纳`);
      if (queuedCount > 0) parts.push(`${queuedCount} 条已自动排入显卡转写→归纳流水线`);
      onToast(parts.join('，'));
      void loadFeed(true, true);
    }
  };

  // 单条视频一键扒评论区并总结选题（自动拉取真实热评 → 提炼选题 → 直接展示在卡片内）
  const handleCrawlCommentTopics = async (item: TrackerVideoItem, force = false) => {
    setBusyCommentTopicsId(item.id);
    try {
      const res = await extractCommentTopics(item.id, { autoCrawl: true, force });
      patchItemInFeed(item.id, {
        comment_count: res.commentsCount,
        comment_topics_count: res.topics.length,
        comment_topics: res.topics,
      });
      setCollapsedCommentTopicIds((prev) => ({ ...prev, [item.id]: false }));
      if (res.commentsCount === 0 || res.topics.length === 0) {
        onToast(res.message || '暂未抓到公开评论，可打开右侧详情检查或稍后重试');
      } else {
        onToast(`已从 ${res.commentsCount} 条真实评论里扒出 ${res.topics.length} 个选题！`);
      }
      if (item.is_read === 0) {
        void apiRequest('/api/radar/creators/mark-read', {
          method: 'POST',
          body: JSON.stringify({ contentId: item.id }),
        }).then(() => onRefreshBadge());
      }
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setBusyCommentTopicsId(null);
    }
  };

  // 批量串行扒取本页前 5 条未提取视频的评论区并逐条总结选题
  const handleBatchCrawlCommentTopics = async () => {
    const targets = items
      .filter(
        (it) =>
          COMMENT_SUPPORTED_PLATFORMS.has(it.platform) &&
          ((it.comment_topics?.length || 0) === 0 || it.comment_topics_count === 0)
      )
      .slice(0, 5);
    if (targets.length === 0) {
      onToast('当前页面支持抓评论的视频都已经提炼过评论选题了');
      return;
    }
    setBatchCommentProgress({ done: 0, total: targets.length, currentTitle: targets[0].title });
    let successCount = 0;
    let totalTopics = 0;
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      setBusyCommentTopicsId(target.id);
      setBatchCommentProgress({ done: i, total: targets.length, currentTitle: target.title });
      try {
        const res = await extractCommentTopics(target.id, { autoCrawl: true, force: false });
        patchItemInFeed(target.id, {
          comment_count: res.commentsCount,
          comment_topics_count: res.topics.length,
          comment_topics: res.topics,
        });
        setCollapsedCommentTopicIds((prev) => ({ ...prev, [target.id]: false }));
        if (res.topics.length > 0) {
          successCount++;
          totalTopics += res.topics.length;
        }
      } catch (err) {
        onToast(`《${target.title.slice(0, 14)}》扒评论出错：${(err as Error).message}`);
      } finally {
        setBatchCommentProgress({ done: i + 1, total: targets.length, currentTitle: target.title });
      }
    }
    setBusyCommentTopicsId(null);
    setBatchCommentProgress(null);
    if (successCount > 0) {
      onToast(`批量扒评论完成：成功为 ${successCount} 条视频总结出 ${totalTopics} 个评论区选题！`);
    } else {
      onToast('本批视频暂未抓到足够评论，可点单条卡片重试或先登录对应平台');
    }
  };

  // 直接在视频卡片里把评论区总结出的选题一键存入「简易收藏本」
  const handleSaveInlineTopic = async (contentId: number, topicId: number) => {
    setSavingTopicId(topicId);
    try {
      const res = await saveCommentTopicToBoard(topicId);
      setFeed((prev) => {
        if (!prev) return prev;
        const patchTopics = (list: TrackerVideoItem[]) =>
          list.map((x) => {
            if (x.id !== contentId) return x;
            return {
              ...x,
              comment_topics: (x.comment_topics || []).map((t: CommentTopicIdeaItem) =>
                t.id === topicId ? { ...t, savedBoardId: res.boardItem.id } : t
              ),
            };
          });
        return {
          ...prev,
          items: patchTopics(prev.items),
          todayUpdates: { ...prev.todayUpdates, items: patchTopics(prev.todayUpdates.items) },
          todayLeaderboard: {
            ...prev.todayLeaderboard,
            items: prev.todayLeaderboard.items.map((x) =>
              x.id === contentId
                ? {
                    ...x,
                    comment_topics: (x.comment_topics || []).map((t: CommentTopicIdeaItem) =>
                      t.id === topicId ? { ...t, savedBoardId: res.boardItem.id } : t
                    ),
                  }
                : x
            ),
          },
        };
      });
      onToast('已存入选题库，可在左侧「简易收藏本」查看');
      onRefreshBadge();
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setSavingTopicId(null);
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
            core_angle: (item.r2_analysis?.whatItSays || item.transcript || item.summary || '').slice(0, 200),
            notes: item.transcript || '',
            tags: [PLATFORM_LABELS[item.platform] || item.platform, item.source_name].filter(Boolean),
            source_url: item.canonical_url,
          }),
        });
        onToast('已收藏到「简易收藏本」');
      }
      await loadFeed(true, true);
      onRefreshBadge();
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  const creators = feed?.creators || [];
  const items = feed?.items || [];
  const activeCreator = selectedCreatorId ? creators.find((c) => c.id === selectedCreatorId) || null : null;
  const unsummarizedCount = items.filter((it) => !it.copy_digest).length;
  const uncrawledCommentCount = items.filter(
    (it) =>
      COMMENT_SUPPORTED_PLATFORMS.has(it.platform) &&
      ((it.comment_topics?.length || 0) === 0 || it.comment_topics_count === 0)
  ).length;
  const totalTodayNew = creators.reduce((sum, c) => sum + (c.today_new_count || 0), 0);

  return (
    <div>
      {/* 顶部追更控制条 */}
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
                <option value={5}>每 5 分钟</option>
                <option value={10}>每 10 分钟</option>
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

            <label className="r1-rss-toggle" data-testid="creators-include-rss-toggle">
              <input
                type="checkbox"
                checked={includeRss}
                onChange={(e) => setIncludeRss(e.target.checked)}
              />
              <span>包含 RSS 资讯源</span>
            </label>
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

        {/* 折叠式添加博主条 */}
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

      {/* 主体双栏：左 = 按博主分类 | 右 = 今日概览/热度榜 + 博主视频流 */}
      <div className="tracker-shell">
        {/* 左栏：博主分类清单 */}
        <aside className="tracker-sidebar">
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', padding: '2px 8px 8px' }}>
            按博主分类（共 {creators.length} 位）
          </div>

          <div
            data-testid="creator-cat-all"
            className={`tracker-creator-row ${selectedCreatorId === null ? 'active' : ''}`}
            onClick={() => handleSelectCreator(null)}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
              <span style={{ fontWeight: 700, fontSize: 13.5, display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap', flexShrink: 0 }}>
                <Sparkles size={14} color="#4f46e5" /> 全部博主
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                {totalTodayNew > 0 && (
                  <span className="badge badge-blue" style={{ fontSize: 11 }}>
                    今日 +{totalTodayNew}
                  </span>
                )}
                {(feed?.totalUnread || 0) > 0 && (
                  <span className="badge badge-red" style={{ fontSize: 11 }}>
                    +{feed!.totalUnread} 新
                  </span>
                )}
              </div>
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 3 }}>
              今日最新更新 · 新发热度榜 · 全流追更
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
                    onClick={() => handleSelectCreator(c.id)}
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
                        {c.today_new_count > 0 && (
                          <span className="badge badge-blue" style={{ fontSize: 10.5 }}>
                            今日 +{c.today_new_count}
                          </span>
                        )}
                        {c.unread_count > 0 && (
                          <span className="badge badge-red" style={{ fontSize: 11 }}>
                            +{c.unread_count} 新
                          </span>
                        )}
                      </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 4, fontSize: 11.5, color: 'var(--text-muted)' }}>
                      <span>
                        {PLATFORM_LABELS[c.platform] || c.platform} · 已存 {c.content_count} 条 · {fmtRelativeTime(c.last_checked_at)}查过
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

        {/* 右栏 */}
        <div>
          {/* R1 默认全局视图：今日最新更新 + 当日新发热度排行榜 */}
          {selectedCreatorId === null && feed && (
            <div className="r1-dual-grid" data-testid="r1-overview-grid">
              {/* R1 左卡：今日最新更新 */}
              <section className="panel-card" style={{ marginBottom: 0 }} data-testid="r1-today-updates-panel">
                <div className="panel-head" style={{ marginBottom: 10 }}>
                  <div className="panel-title">
                    <Sparkles size={16} color="#4f46e5" />
                    <span>今日最新更新</span>
                    <span className="badge badge-gray" style={{ fontSize: 11 }}>
                      {feed.todayUpdates.dateLocal}
                    </span>
                  </div>
                  {feed.todayUpdates.hasTodayNew ? (
                    <span className="badge badge-red">今日新发 {feed.todayUpdates.todayCount} 条</span>
                  ) : (
                    <span className="badge badge-gray">今日暂无新发 · 展示各博主最近动态</span>
                  )}
                </div>

                {feed.todayUpdates.items.length === 0 ? (
                  <div style={{ padding: '24px 12px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12.5 }}>
                    暂无博主动态，点上方「立即追更全部博主」开始拉取。
                  </div>
                ) : (
                  <div className="r1-today-list">
                    {feed.todayUpdates.items.map((it) => (
                      <div
                        key={it.id}
                        className="r1-today-row"
                        data-testid={`r1-today-item-${it.id}`}
                        onClick={() => onOpenContent(it.id, 'point', it.saved_board_id)}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                            <span
                              className="plat-badge"
                              style={{ background: PLATFORM_COLORS[it.platform] || '#4f46e5', fontSize: 10.5 }}
                            >
                              {PLATFORM_LABELS[it.platform] || it.platform}
                            </span>
                            <span style={{ fontWeight: 700, fontSize: 12.5, color: 'var(--text)' }}>{it.source_name}</span>
                          </div>
                          <span style={{ fontSize: 11.5, color: 'var(--text-muted)', flexShrink: 0 }}>
                            {fmtRelativeTime(it.published_at || it.discovered_at)}
                          </span>
                        </div>
                        <div className="r1-today-title" title={it.title}>
                          {it.title}
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 11.5, color: 'var(--text-muted)' }}>
                          <span>
                            播放 {it.latest_views == null ? '未公开' : fmtNum(it.latest_views)}
                            {it.latest_likes != null ? ` · 👍 ${fmtNum(it.latest_likes)}` : ''}
                            {it.latest_comments != null ? ` · 💬 ${fmtNum(it.latest_comments)}` : ''}
                          </span>
                          <div style={{ display: 'flex', gap: 4 }}>
                            {it.r2_analysis && <span className="badge badge-blue" style={{ fontSize: 10.5 }}>已三维分析</span>}
                            {it.transcript_status === 'done' && (
                              <span className="badge badge-green" style={{ fontSize: 10.5 }}>有口播</span>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* R1 右卡：当日新发热度排行榜 */}
              <section className="panel-card" style={{ marginBottom: 0 }} data-testid="r1-leaderboard-panel">
                <div className="panel-head" style={{ marginBottom: 10 }}>
                  <div className="panel-title">
                    <Trophy size={16} color="#d97706" />
                    <span>当日新发热度排行榜</span>
                  </div>
                  <span className="badge badge-amber">Top {feed.todayLeaderboard.items.length}</span>
                </div>

                {feed.todayLeaderboard.isFallback && feed.todayLeaderboard.fallbackLabel && (
                  <div className="r1-fallback-banner" data-testid="r1-lb-fallback-banner">
                    {feed.todayLeaderboard.fallbackLabel}
                  </div>
                )}

                {feed.todayLeaderboard.items.length === 0 ? (
                  <div style={{ padding: '24px 12px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12.5 }}>
                    暂无上榜视频。
                  </div>
                ) : (
                  <div className="r1-lb-list">
                    {feed.todayLeaderboard.items.map((it) => (
                      <div
                        key={it.id}
                        className={`r1-lb-row ${it.rank === 1 ? 'top1' : ''}`}
                        data-testid={`r1-lb-item-${it.id}`}
                        onClick={() => onOpenContent(it.id, 'point', it.saved_board_id)}
                      >
                        <div className={`rank-medal ${it.rank <= 3 ? `top${it.rank}` : ''}`}>{it.rank}</div>

                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {it.title}
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 3, fontSize: 11.5, color: 'var(--text-muted)' }}>
                            <span>{it.source_name}</span>
                            <span>·</span>
                            <span>{it.heatBasis}</span>
                            {it.breakout_ratio != null && it.breakout_ratio >= 1.6 && (
                              <span className="badge badge-red" style={{ fontSize: 10.5 }}>
                                <Flame size={10} /> {it.breakout_ratio}x
                              </span>
                            )}
                          </div>
                        </div>

                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                          <span className="badge badge-amber" style={{ fontSize: 11 }}>
                            热度 {Math.round(it.heatScore)}
                          </span>
                          <div style={{ display: 'flex', gap: 4 }}>
                            <button
                              type="button"
                              className="btn btn-sm"
                              style={{ padding: '2px 7px', fontSize: 11 }}
                              onClick={(e) => {
                                e.stopPropagation();
                                onOpenContent(it.id, 'point', it.saved_board_id);
                              }}
                            >
                              看分析
                            </button>
                            <button
                              type="button"
                              className="btn btn-sm"
                              style={{ padding: '2px 7px', fontSize: 11 }}
                              onClick={(e) => {
                                e.stopPropagation();
                                onOpenRemix(it.id);
                              }}
                            >
                              二创
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}

          {/* 主内容面板：时间筛选 / 搜索 / 历史抓取 / 二创对比 / 视频卡片列表 */}
          <section className="panel-card" style={{ marginBottom: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', paddingBottom: 12, borderBottom: '1px solid var(--border)', marginBottom: 14 }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 16.5, fontWeight: 800, color: 'var(--text)' }}>
                    {activeCreator ? activeCreator.name : '全部对标博主 · 最新与历史作品'}
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
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      粉丝 {fmtNum(activeCreator.follower_count)}
                    </span>
                  )}
                  {feed && (
                    <span className="badge badge-gray" style={{ fontSize: 11.5 }}>
                      共 {feed.total} 条（新→旧）
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                  {activeCreator
                    ? `上次追更：${fmtRelativeTime(activeCreator.last_checked_at)} · 严格按发布时间从新到旧排序，可随时抓取更早历史与提取口播`
                    : '默认仅看视频博主；支持一键提取口播、AI 三维判断（讲了什么/火不火/值不值得二创）及多条二创对比'}
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  data-testid="btn-compare-remix"
                  className="btn btn-primary btn-sm"
                  disabled={comparing || items.length === 0}
                  onClick={() => void handleCompareRemix()}
                >
                  <Scale size={13} />
                  {comparing
                    ? 'AI 对比评估中...'
                    : selectedCompareIds.length > 0
                      ? `AI 对比已选 (${selectedCompareIds.length} 条) 最适合二创`
                      : 'AI 对比哪条最适合二创'}
                </button>

                {(uncrawledCommentCount > 0 || batchCommentProgress) && (
                  <button
                    type="button"
                    data-testid="btn-batch-comment-topics"
                    className="btn btn-sm"
                    style={{ background: '#fffbeb', color: '#b45309', borderColor: '#fde68a' }}
                    disabled={Boolean(batchCommentProgress) || busyCommentTopicsId !== null}
                    onClick={() => void handleBatchCrawlCommentTopics()}
                  >
                    <MessageSquareText size={13} />
                    {batchCommentProgress
                      ? `扒评论找选题 ${batchCommentProgress.done}/${batchCommentProgress.total}...`
                      : `批量扒评论找选题 (${Math.min(5, uncrawledCommentCount)}条)`}
                  </button>
                )}

                {(unsummarizedCount > 0 || batchProgress) && (
                  <button
                    type="button"
                    data-testid="btn-batch-digest"
                    className="btn btn-sm"
                    disabled={Boolean(batchProgress) || busyDigestId !== null}
                    onClick={() => void handleBatchDigest()}
                  >
                    <ListChecks size={13} />
                    {batchProgress
                      ? `派发中 ${batchProgress.done}/${batchProgress.total}...`
                      : `转写并归纳本页 (${Math.min(3, unsummarizedCount)})`}
                  </button>
                )}

                {activeCreator && (
                  <button
                    type="button"
                    data-testid="btn-fetch-history"
                    className="btn btn-sm"
                    disabled={busyFetchHistoryId === activeCreator.id}
                    onClick={() => void handleFetchHistory(activeCreator)}
                  >
                    <History size={13} />
                    {busyFetchHistoryId === activeCreator.id ? '拉取历史中...' : '拉取更早历史作品'}
                  </button>
                )}

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

            {/* 第二排过滤条：时间跨度 + 关键词搜索 */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
              <div className="pill-group">
                {[
                  { d: 1, l: '今日新发' },
                  { d: 7, l: '近 7 天' },
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

              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: '1 1 240px', maxWidth: 360 }}>
                <div style={{ position: 'relative', flex: 1 }}>
                  <Search
                    size={14}
                    style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }}
                  />
                  <input
                    className="input"
                    data-testid="creators-search-input"
                    style={{ paddingLeft: 30 }}
                    placeholder="搜标题 / 口播关键词 / 博主名..."
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') setSearchQuery(searchInput.trim());
                    }}
                  />
                </div>
                {searchInput && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      setSearchInput('');
                      setSearchQuery('');
                    }}
                  >
                    清空
                  </button>
                )}
              </div>
            </div>

            {/* R2 跨视频对比结果面板 */}
            {compareResult && (
              <div className="r2-compare-panel" data-testid="r2-compare-panel">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14.5, fontWeight: 800, color: 'var(--text)' }}>
                      <Scale size={16} color="#4f46e5" />
                      <span>AI 二创推荐对比结果</span>
                    </div>
                    <div style={{ fontSize: 13, color: '#334155', marginTop: 4 }}>{compareResult.summary}</div>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {selectedCompareIds.length > 0 && (
                      <button type="button" className="btn btn-sm" onClick={() => setSelectedCompareIds([])}>
                        清空勾选 ({selectedCompareIds.length})
                      </button>
                    )}
                    <button type="button" className="btn btn-sm" onClick={() => setCompareResult(null)}>
                      收起对比
                    </button>
                  </div>
                </div>

                <div className="r2-compare-list">
                  {compareResult.rankings.map((r) => {
                    const isBest = r.contentId === compareResult.bestContentId;
                    return (
                      <div
                        key={r.contentId}
                        className={`r2-compare-row ${isBest ? 'is-best' : ''}`}
                        data-testid={`compare-rank-${r.contentId}`}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                            <span className={`rank-medal ${r.rank <= 3 ? `top${r.rank}` : ''}`} style={{ width: 26, height: 26, fontSize: 12 }}>
                              {r.rank}
                            </span>
                            <span style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--text)' }}>{r.title}</span>
                            {isBest && <span className="badge badge-blue">最适合二创</span>}
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span className="r2-heat-pill normal">二创指数 {r.remixScore}/100</span>
                            <span className="badge badge-gray">{r.verdict}</span>
                          </div>
                        </div>

                        <div style={{ fontSize: 12.5, color: '#334155', marginTop: 6, lineHeight: 1.55 }}>{r.reason}</div>
                        {r.suggestedHook && (
                          <div style={{ fontSize: 12.5, color: '#3730a3', marginTop: 4, fontWeight: 600 }}>
                            建议开头钩子：{r.suggestedHook}
                          </div>
                        )}

                        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => onOpenContent(r.contentId, 'point')}
                          >
                            <PanelRightOpen size={12} /> 看三维分析
                          </button>
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            onClick={() => onOpenRemix(r.contentId)}
                          >
                            <Wand2 size={12} /> 立即去二创
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* 温柔回退提示 */}
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
                近 {days} 天暂无新发布，已为你保留最新 {items.length} 条方便随时提取文案；切到「全部历史」可查看所有入库作品。
              </div>
            )}

            {loading && !feed ? (
              <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-muted)' }}>加载最新更新中...</div>
            ) : items.length === 0 ? (
              <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-muted)' }}>
                {searchQuery
                  ? `没有找到包含「${searchQuery}」的作品，换个词试试或清空筛选。`
                  : activeCreator
                    ? '该博主在此时间范围内暂无作品，可切到「全部历史」或点击右上角「拉取更早历史作品」。'
                    : '还没有抓到作品，点上方「立即追更全部博主」拉取最新内容。'}
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {items.map((item) => {
                    const isVideo = isVideoPlatform(item.platform);
                    const hasTranscript = Boolean(item.transcript && item.transcript.trim().length >= 40);
                    const pipelineStage =
                      item.pipeline_stage ||
                      (item.asr_job_status === 'queued'
                        ? 'queued'
                        : item.asr_job_status === 'downloading'
                          ? 'downloading'
                          : item.asr_job_status === 'uploading'
                            ? 'transcribing'
                            : item.asr_job_status === 'digesting'
                              ? 'digesting'
                              : busyTranscribeId === item.id || item.transcript_status === 'transcribing'
                                ? 'downloading'
                                : null);
                    const isTranscribing = Boolean(pipelineStage);
                    const expandedMode = expandedCopyIds[item.id];
                    const captionText = (item.body || item.summary || '').trim();
                    const showUnreadBadge = item.is_read === 0 && !feed?.fallbackShown;
                    const orientation = getMediaOrientation(item);
                    const digest = item.copy_digest || null;
                    const r2 = item.r2_analysis || null;
                    const isDigesting = busyDigestId === item.id;
                    const isAnalyzingR2 = busyR2Id === item.id;
                    const isCrawlingComments = busyCommentTopicsId === item.id;
                    const canCrawlComments = COMMENT_SUPPORTED_PLATFORMS.has(item.platform);
                    const inlineTopics = item.comment_topics || [];
                    const isTopicsCollapsed = Boolean(collapsedCommentTopicIds[item.id]);
                    const isCompareChecked = selectedCompareIds.includes(item.id);
                    const canUpgradeR2 = Boolean(hasTranscript && r2 && r2.basisSource !== '口播全文+真实数据');

                    const r2Block = r2 ? (
                      <div className="r2-card" data-testid={`r2-card-${item.id}`}>
                        <div className="r2-card-head">
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                            <span style={{ fontSize: 12.5, fontWeight: 800, color: '#3730a3' }}>AI 三维分析</span>
                            <span className="badge badge-gray" style={{ fontSize: 11 }}>
                              {r2.basisSource}
                            </span>
                            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                              {fmtTime(r2.updatedAt)}
                            </span>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            {canUpgradeR2 && (
                              <button
                                type="button"
                                className="btn btn-primary btn-sm"
                                style={{ padding: '2px 8px', fontSize: 11.5 }}
                                disabled={isAnalyzingR2}
                                onClick={() => void handleR2Analyze(item, false)}
                              >
                                {isAnalyzingR2 ? '升级中...' : '口播已就绪 · 升级三维分析'}
                              </button>
                            )}
                            <button
                              type="button"
                              className="icon-ghost-btn"
                              title="刷新 AI 三维分析"
                              disabled={isAnalyzingR2}
                              onClick={() => void handleR2Analyze(item, true)}
                            >
                              <RotateCcw size={13} />
                            </button>
                          </div>
                        </div>

                        <div className="r2-grid-3">
                          <div className="r2-col r2-col-what">
                            <div className="r2-col-label">
                              <span>视频讲了什么</span>
                            </div>
                            <div className="r2-col-text">{r2.whatItSays}</div>
                          </div>

                          <div className={`r2-col r2-col-heat ${r2.heatLevel === 'viral' ? 'is-viral' : ''}`}>
                            <div className="r2-col-label">
                              <span>火不火</span>
                              <span className={`r2-heat-pill ${r2.heatLevel}`}>
                                {HEAT_LEVEL_LABELS[r2.heatLevel] || r2.heatLevel}
                              </span>
                            </div>
                            <div className="r2-col-text">{r2.heatVerdict}</div>
                          </div>

                          <div className="r2-col r2-col-remix">
                            <div className="r2-col-label">
                              <span>是否适合二次创作</span>
                              <span className="r2-heat-pill normal">{r2.remixScore}/100</span>
                            </div>
                            <div className="r2-col-text">{r2.remixSuitability}</div>
                            {r2.remixAngle && (
                              <div style={{ marginTop: 5, fontSize: 12, color: '#166534', fontWeight: 600 }}>
                                切入：{r2.remixAngle}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    ) : null;

                    const digestBlock = digest ? (
                      <div className="digest-card-inline" data-testid={`digest-card-${item.id}`}>
                        <div className="digest-overview-head">
                          <div className="digest-overview-badges">
                            <span className="digest-overview-pill">大概讲什么</span>
                            <span className={digest.usedTranscript ? 'digest-source-verified' : 'digest-source-hint'}>
                              {digest.usedTranscript
                                ? `基于完整口播 · ${digest.transcriptChars || digest.sourceChars}字`
                                : `基于文章全文 · ${digest.sourceChars}字`}
                            </span>
                          </div>
                          <div className="digest-overview-actions">
                            <button
                              type="button"
                              data-testid={`btn-copy-digest-${item.id}`}
                              className="icon-ghost-btn"
                              title="复制 1234 归纳"
                              onClick={() =>
                                void handleCopyText(
                                  `digest-${item.id}`,
                                  formatDigestForCopy(item, digest),
                                  '已复制 1234 要点与行动建议'
                                )
                              }
                            >
                              {copiedKey === `digest-${item.id}` ? <Check size={13} color="#059669" /> : <Copy size={13} />}
                            </button>
                            <button
                              type="button"
                              data-testid={`btn-refresh-digest-${item.id}`}
                              className="icon-ghost-btn"
                              title="按完整口播重新深度归纳"
                              disabled={isDigesting || isTranscribing}
                              onClick={() => void handleGenerateDigest(item, true)}
                            >
                              <RotateCcw size={13} />
                            </button>
                          </div>
                        </div>

                        <div className="digest-overview-text">{digest.overview}</div>

                        <div className="digest-grid-2">
                          <div className="digest-col digest-col-points">
                            <div className="digest-col-title">核心要点</div>
                            <ol className="digest-num-list">
                              {digest.keyPoints.map((pt, idx) => (
                                <li key={idx}>
                                  <span className="digest-num-badge">{idx + 1}</span>
                                  <span>{pt}</span>
                                </li>
                              ))}
                            </ol>
                          </div>

                          <div className="digest-col digest-col-actions">
                            <div className="digest-col-title">对我有啥用 · 可以做什么</div>
                            <ol className="digest-num-list">
                              {digest.actionItems.map((act, idx) => (
                                <li key={idx}>
                                  <span className="digest-num-badge">{idx + 1}</span>
                                  <span>{act}</span>
                                </li>
                              ))}
                            </ol>
                          </div>
                        </div>
                      </div>
                    ) : null;

                    const commentTopicsBlock =
                      inlineTopics.length > 0 && !isTopicsCollapsed ? (
                        <div className="comment-topics-inline" data-testid={`comment-topics-inline-${item.id}`}>
                          <div className="comment-topics-inline-head">
                            <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                              <span className="comment-topics-pill">
                                <MessageSquareText size={12} /> 评论区扒出的选题（{inlineTopics.length} 个）
                              </span>
                              <span style={{ fontSize: 11.5, color: '#92400e' }}>
                                基于 {item.comment_count} 条真实热评总结
                              </span>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                              <button
                                type="button"
                                className="btn btn-sm"
                                style={{ padding: '2px 8px', fontSize: 11.5 }}
                                onClick={() => onOpenContent(item.id, 'comments', item.saved_board_id)}
                              >
                                看全部 {item.comment_count} 条原评
                              </button>
                              <button
                                type="button"
                                className="icon-ghost-btn"
                                title="重新扒评论并更新选题"
                                disabled={isCrawlingComments}
                                onClick={() => void handleCrawlCommentTopics(item, true)}
                              >
                                <RotateCcw size={13} />
                              </button>
                            </div>
                          </div>

                          <div className="comment-topics-grid">
                            {inlineTopics.map((tp, idx) => {
                              const isSaved = Boolean(tp.savedBoardId);
                              const isSaving = savingTopicId === tp.id;
                              return (
                                <div key={tp.id} className="comment-topic-mini-card" data-testid={`inline-topic-${tp.id}`}>
                                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 6 }}>
                                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, minWidth: 0 }}>
                                      <span className="comment-topic-idx">{idx + 1}</span>
                                      <div style={{ fontWeight: 700, fontSize: 13, color: '#0f172a', lineHeight: 1.4 }}>
                                        {tp.creationIdeaTitle || tp.topic}
                                      </div>
                                    </div>
                                    <button
                                      type="button"
                                      data-testid={`inline-save-topic-${tp.id}`}
                                      className={`btn btn-sm ${isSaved ? 'btn-star-active' : 'btn-primary'}`}
                                      style={{ padding: '2px 8px', fontSize: 11, flexShrink: 0 }}
                                      disabled={isSaved || isSaving}
                                      onClick={() => void handleSaveInlineTopic(item.id, tp.id)}
                                    >
                                      <Star size={11} fill={isSaved ? 'currentColor' : 'none'} />
                                      {isSaving ? '存入中' : isSaved ? '已存选题' : '存选题'}
                                    </button>
                                  </div>

                                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 5 }}>
                                    <span className="badge badge-amber" style={{ fontSize: 11 }}>
                                      焦点：{tp.topic}
                                    </span>
                                    {tp.heatNote && (
                                      <span className="badge badge-gray" style={{ fontSize: 11 }}>
                                        {tp.heatNote}
                                      </span>
                                    )}
                                  </div>

                                  {tp.creationAngle && (
                                    <div style={{ fontSize: 12, color: '#334155', marginTop: 5, lineHeight: 1.5 }}>
                                      <strong>怎么拍：</strong>{tp.creationAngle}
                                    </div>
                                  )}

                                  {tp.evidenceComments && tp.evidenceComments.length > 0 && (
                                    <div className="comment-topic-quote">
                                      观众原评：“{tp.evidenceComments[0]}”
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ) : null;

                    return (
                      <div
                        key={item.id}
                        className={`tracker-video-card ${showUnreadBadge ? 'is-new' : ''}`}
                        data-testid={`tracker-item-${item.id}`}
                        data-orientation={orientation}
                      >
                        <div className="tracker-video-main">
                          {orientation !== 'none' && (
                            <a
                              href={item.canonical_url}
                              target="_blank"
                              rel="noreferrer"
                              className={orientation === 'vertical' ? 'tracker-thumb-vertical' : 'tracker-thumb-horizontal'}
                              data-testid={`tracker-thumb-${item.id}`}
                              title="打开原视频"
                            >
                              {item.cover_url ? (
                                <img src={item.cover_url} alt={item.title} referrerPolicy="no-referrer" loading="lazy" />
                              ) : (
                                <div className="vcard-fallback-text">{PLATFORM_LABELS[item.platform] || item.platform}</div>
                              )}
                              <span className="tracker-ratio-tag">{orientation === 'vertical' ? '竖屏' : '横屏'}</span>
                            </a>
                          )}

                          <div className="tracker-video-body">
                            <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', marginBottom: 6 }}>
                              <label
                                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, color: 'var(--text-muted)', cursor: 'pointer' }}
                                title="勾选用于 AI 对比哪条最适合二次创作"
                              >
                                <input
                                  type="checkbox"
                                  data-testid={`compare-check-${item.id}`}
                                  checked={isCompareChecked}
                                  onChange={() => toggleCompareSelect(item.id)}
                                />
                                <span>对比</span>
                              </label>

                              {showUnreadBadge && (
                                <span className="badge badge-red" style={{ fontSize: 11 }}>
                                  新更新
                                </span>
                              )}

                              {!activeCreator && (
                                <span
                                  className="badge badge-gray"
                                  style={{ fontSize: 11, cursor: 'pointer' }}
                                  onClick={() => handleSelectCreator(item.source_id)}
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

                              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                                · 播放 {item.latest_views == null ? '未公开' : fmtNum(item.latest_views)}
                              </span>
                              {item.latest_likes != null && (
                                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                                  · 👍 {fmtNum(item.latest_likes)}
                                </span>
                              )}
                              {item.latest_comments != null && (
                                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                                  · 💬 {fmtNum(item.latest_comments)}
                                </span>
                              )}
                              {item.latest_favorites != null && (
                                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                                  · ⭐ {fmtNum(item.latest_favorites)}
                                </span>
                              )}
                              {item.latest_shares != null && (
                                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                                  · ↗ {fmtNum(item.latest_shares)}
                                </span>
                              )}
                              {item.breakout_ratio != null && item.breakout_ratio >= 1.6 && (
                                <span className="badge badge-red" style={{ fontSize: 11 }}>
                                  <Flame size={11} /> {item.breakout_ratio}x 爆款
                                </span>
                              )}
                            </div>

                            <div
                              className="tracker-video-title"
                              title={item.title}
                              style={{ cursor: 'pointer' }}
                              onClick={() => onOpenContent(item.id, 'point', item.saved_board_id)}
                            >
                              {item.title}
                            </div>

                            {/* 核心操作栏 */}
                            <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', alignItems: 'center' }}>
                              {/* 核心口播 + 深度 1234 归纳按钮（视频必须先转口播，绝不靠标题硬猜） */}
                              {isVideo && !hasTranscript ? (
                                <button
                                  type="button"
                                  data-testid={`btn-digest-${item.id}`}
                                  className="btn btn-primary btn-sm"
                                  disabled={isDigesting || isTranscribing}
                                  onClick={() => void handleGenerateDigest(item, false)}
                                >
                                  <Mic size={13} />
                                  {isTranscribing
                                    ? pipelineStage === 'queued'
                                      ? `排队中 (第${item.queue_position || 1}位)...`
                                      : pipelineStage === 'downloading'
                                        ? '1/3 提音频中...'
                                        : pipelineStage === 'transcribing'
                                          ? '2/3 显卡转口播中...'
                                          : '3/3 按口播归纳中...'
                                    : isDigesting
                                      ? '正在派发转写...'
                                      : '转写口播并归纳 (1234)'}
                                </button>
                              ) : (
                                <>
                                  {!digest && (
                                    <button
                                      type="button"
                                      data-testid={`btn-digest-${item.id}`}
                                      className="btn btn-primary btn-sm"
                                      disabled={isDigesting || isTranscribing}
                                      onClick={() => void handleGenerateDigest(item, false)}
                                    >
                                      <ListChecks size={13} />
                                      {isDigesting
                                        ? '正按口播深度归纳...'
                                        : isVideo
                                          ? '按口播归纳 (1234)'
                                          : '按全文归纳 (1234)'}
                                    </button>
                                  )}

                                  {hasTranscript && (
                                    <>
                                      <button
                                        type="button"
                                        data-testid={`btn-toggle-script-${item.id}`}
                                        className={`btn btn-sm ${expandedMode === 'transcript' ? 'btn-primary' : ''}`}
                                        style={
                                          expandedMode === 'transcript'
                                            ? undefined
                                            : { background: '#f0fdf4', color: '#15803d' }
                                        }
                                        onClick={() => toggleExpand(item, 'transcript')}
                                      >
                                        <FileText size={13} />
                                        {expandedMode === 'transcript' ? '收起口播文案' : `查看口播 (${item.transcript_chars}字)`}
                                        {expandedMode === 'transcript' ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                                      </button>
                                      <button
                                        type="button"
                                        data-testid={`btn-copy-script-${item.id}`}
                                        className="btn btn-sm"
                                        onClick={() => void handleCopyText(`script-${item.id}`, item.transcript, '已复制完整口播文案')}
                                      >
                                        {copiedKey === `script-${item.id}` ? <Check size={13} /> : <Copy size={13} />}
                                        {copiedKey === `script-${item.id}` ? '已复制' : '复制文案'}
                                      </button>
                                    </>
                                  )}
                                </>
                              )}

                              {!r2 && (
                                <button
                                  type="button"
                                  data-testid={`btn-r2-analyze-${item.id}`}
                                  className="btn btn-sm"
                                  disabled={isAnalyzingR2}
                                  onClick={() => void handleR2Analyze(item, false)}
                                >
                                  <Sparkles size={13} />
                                  {isAnalyzingR2 ? 'AI 三维分析中...' : 'AI 三维分析'}
                                </button>
                              )}

                              {!hasTranscript && captionText && captionText !== item.title && (
                                <button
                                  type="button"
                                  className="btn btn-sm"
                                  onClick={() => toggleExpand(item, 'caption')}
                                >
                                  {expandedMode === 'caption' ? '收起原帖文字' : '原帖文字'}
                                </button>
                              )}

                              {canCrawlComments &&
                                (inlineTopics.length > 0 ? (
                                  <button
                                    type="button"
                                    data-testid={`btn-open-comments-${item.id}`}
                                    className="btn btn-sm"
                                    style={{ background: '#fffbeb', color: '#b45309', borderColor: '#fde68a' }}
                                    onClick={() =>
                                      setCollapsedCommentTopicIds((prev) => ({ ...prev, [item.id]: !prev[item.id] }))
                                    }
                                  >
                                    <MessageSquareText size={13} />
                                    {isTopicsCollapsed
                                      ? `展开评论选题 (${inlineTopics.length}个 · ${item.comment_count}评)`
                                      : `评论选题 (${inlineTopics.length}个 · ${item.comment_count}评)`}
                                    {isTopicsCollapsed ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    data-testid={`btn-open-comments-${item.id}`}
                                    className="btn btn-sm"
                                    style={{ background: '#fffbeb', color: '#b45309', borderColor: '#fde68a' }}
                                    disabled={isCrawlingComments || Boolean(batchCommentProgress)}
                                    onClick={() => void handleCrawlCommentTopics(item, false)}
                                  >
                                    <MessageSquareText size={13} />
                                    {isCrawlingComments ? '正在扒评论提选题...' : '扒评论找选题'}
                                  </button>
                                ))}

                              <button
                                type="button"
                                data-testid={`btn-open-detail-${item.id}`}
                                className="btn btn-sm"
                                onClick={() => onOpenContent(item.id, 'point', item.saved_board_id)}
                              >
                                <PanelRightOpen size={13} /> 详情
                              </button>

                              <button
                                type="button"
                                className="btn btn-sm"
                                onClick={() => onOpenRemix(item.id)}
                              >
                                <Wand2 size={13} /> AI 二创
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

                            {/* 实时三步流水线进度条（提取音频 → RTX 显卡转写 → 按完整口播深度归纳 1234） */}
                            {pipelineStage && (
                              <div className="digest-progress-strip" data-testid={`digest-progress-${item.id}`}>
                                <span className="digest-progress-dot" />
                                <span>{getPipelineStageLabel(pipelineStage, item.queue_position)}</span>
                              </div>
                            )}

                            {/* 若上次转写出错，清晰展示原因方便重跑 */}
                            {!pipelineStage && !hasTranscript && item.transcript_status === 'failed' && item.asr_error && (
                              <div
                                style={{
                                  marginTop: 8,
                                  padding: '7px 11px',
                                  borderRadius: 9,
                                  background: '#fef2f2',
                                  color: '#b91c1c',
                                  fontSize: 12,
                                }}
                              >
                                上次转写未完成：{item.asr_error}（可点上方按钮重试）
                              </div>
                            )}

                            {/* 竖屏封面旁直接放完整口播深度 1234 归纳或清晰引导 */}
                            {orientation === 'vertical' &&
                              (digestBlock ||
                                (!pipelineStage && !r2 && (
                                  <div className="digest-empty-hint">
                                    {isDigesting
                                      ? '正在按完整口播提炼 1234 深度要点...'
                                      : hasTranscript
                                        ? '完整口播已就绪，点上方「按口播归纳 (1234)」立即提炼深度要点与可执行动作。'
                                        : '点上方「转写口播并归纳 (1234)」，本机 RTX 显卡免费转出完整口播后，严格基于视频原话提炼 1234 要点与行动（绝不靠标题硬猜）。'}
                                  </div>
                                )))}
                          </div>
                        </div>

                        {/* 横屏与无封面源：1234 归纳铺满卡片下方 */}
                        {orientation !== 'vertical' && digestBlock}

                        {/* 每个视频对应的评论区选题总结卡片（直接内联展示） */}
                        {commentTopicsBlock}

                        {/* R2 三维 AI 分析结果卡片 */}
                        {r2Block}

                        {/* 内联展开的完整口播文案区 */}
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
                                        `drawer-${item.id}`,
                                        expandedMode === 'transcript' ? item.transcript : captionText,
                                        '已复制全文'
                                      )
                                    }
                                  >
                                    {copiedKey === `drawer-${item.id}` ? <Check size={12} /> : <Copy size={12} />} 复制全文
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

                {/* R3 历史分页底部栏 */}
                {feed && (
                  <div className="r3-pagination-bar" data-testid="r3-pagination-bar">
                    <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
                      已加载 {items.length} / 共 {feed.total} 条（严格按发布时间从新到旧排序）
                    </span>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      {feed.hasMore ? (
                        <button
                          type="button"
                          data-testid="btn-load-more"
                          className="btn btn-primary btn-sm"
                          disabled={loadingMore}
                          onClick={() => void handleLoadMore()}
                        >
                          {loadingMore ? '加载中...' : '加载更多历史作品'}
                        </button>
                      ) : (
                        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>已显示全部符合条件的作品</span>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
