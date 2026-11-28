import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Play,
  Square,
  RefreshCw,
  Plus,
  Trash2,
  Upload,
  Send,
  ShieldCheck,
  Clock,
  RotateCcw,
  BookOpen,
  Sparkles,
  CheckCircle2,
  Edit3,
  Copy,
  Layers,
} from 'lucide-react';
import { apiRequest } from '../api';
import type { PublishInspirationDraft, PublishPlatformCopy, PublishScriptSources } from '../types';

interface SauStatus {
  installed: boolean;
  repoPresent?: boolean;
  sauDir: string;
  running: boolean;
  managedByWorkbench: boolean;
  port: number;
  frontendPort: number;
  backendUrl: string;
}

interface SauAccount {
  id: number;
  type: number;
  filePath: string;
  name: string;
  status: number;
}

interface SauFile {
  id: number;
  filename: string;
  filesize: number;
  upload_time: string;
  file_path: string;
}

interface SauPublishRecord {
  id: number;
  platform_type: number;
  platform_name: string;
  title: string;
  file_list: string[];
  account_list: string[];
  tags: string[];
  enable_timer: number;
  schedule_summary: string;
  is_draft: number;
  status: string;
  message: string;
  created_at: string;
}

interface TitleTemplate {
  id: number;
  category: string;
  title: string;
  tags: string[];
  note: string;
  use_count: number;
  created_at: string;
}

interface VideoDraftItem {
  filePath: string;
  filename: string;
  filesize: number;
  title: string;
  tagsText: string;
}

interface BatchRunResult {
  platformLabel: string;
  videoName: string;
  status: 'pending' | 'running' | 'success' | 'error';
  message: string;
}

const PLATFORM_OPTIONS = [
  { type: 3, label: '抖音', badge: 'badge-red' },
  { type: 4, label: '快手', badge: 'badge-amber' },
  { type: 1, label: '小红书', badge: 'badge-blue' },
  { type: 2, label: '微信视频号', badge: 'badge-green' },
] as const;

const TEMPLATE_CATEGORIES = ['全部', '通用', '干货拆解', '好物测评', '教程实操', '日常Vlog', '科技'] as const;

function getPlatformMeta(type: number) {
  return PLATFORM_OPTIONS.find((p) => p.type === type) || { type, label: `平台(${type})`, badge: 'badge-gray' };
}

function stripFileExt(name: string) {
  return name.replace(/\.[^.]+$/, '');
}

type PublishSubTab = 'publish' | 'titles' | 'accounts' | 'materials' | 'history';

export function PublishPage({
  onToast,
  activeSubTab,
  onSubTabChange,
  inspirationDraft,
  onClearInspiration,
}: {
  onToast: (msg: string) => void;
  activeSubTab?: PublishSubTab;
  onSubTabChange?: (sub: PublishSubTab) => void;
  inspirationDraft?: PublishInspirationDraft | null;
  onClearInspiration?: () => void;
}) {
  const [internalSubTab, setInternalSubTab] = useState<PublishSubTab>('publish');
  const subTab = activeSubTab || internalSubTab;
  const setSubTab = (next: PublishSubTab) => {
    setInternalSubTab(next);
    onSubTabChange?.(next);
  };
  const [status, setStatus] = useState<SauStatus | null>(null);
  const [accounts, setAccounts] = useState<SauAccount[]>([]);
  const [files, setFiles] = useState<SauFile[]>([]);
  const [history, setHistory] = useState<SauPublishRecord[]>([]);
  const [templates, setTemplates] = useState<TitleTemplate[]>([]);

  const [loading, setLoading] = useState(false);
  const [validating, setValidating] = useState(false);
  const [engineBusy, setEngineBusy] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [sauDirInput, setSauDirInput] = useState('');

  const [selectedAccountKeys, setSelectedAccountKeys] = useState<string[]>([]);
  const [videoDrafts, setVideoDrafts] = useState<VideoDraftItem[]>([]);
  const [globalTitle, setGlobalTitle] = useState('');
  const [globalTagsText, setGlobalTagsText] = useState('');
  const [enableTimer, setEnableTimer] = useState(false);
  const [videosPerDay, setVideosPerDay] = useState(1);
  const [dailyTimesText, setDailyTimesText] = useState('10:00, 18:00');
  const [startDays, setStartDays] = useState(0);
  const [isOriginal, setIsOriginal] = useState(false);
  const [isDraft, setIsDraft] = useState(false);
  const [productLink, setProductLink] = useState('');
  const [productTitle, setProductTitle] = useState('');

  const [publishing, setPublishing] = useState(false);
  const [batchResults, setBatchResults] = useState<BatchRunResult[]>([]);
  const [dragOver, setDragOver] = useState(false);

  // AI 按平台自动生成标题、正文与标签
  const [aiScriptInput, setAiScriptInput] = useState('');
  const [aiStyleHint, setAiStyleHint] = useState('');
  const [aiGenerating, setAiGenerating] = useState(false);
  const [aiPlatformCopies, setAiPlatformCopies] = useState<Record<number, PublishPlatformCopy> | null>(null);
  const [aiPreviewPlatform, setAiPreviewPlatform] = useState<number>(3);
  const [usePlatformAiCopy, setUsePlatformAiCopy] = useState(true);
  const [scriptSources, setScriptSources] = useState<PublishScriptSources | null>(null);
  const [loadingSources, setLoadingSources] = useState(false);
  const [selectedSourceKey, setSelectedSourceKey] = useState('');

  const [tplCategoryFilter, setTplCategoryFilter] = useState<string>('全部');
  const [tplSearch, setTplSearch] = useState('');
  const [showTplModal, setShowTplModal] = useState(false);
  const [editingTplId, setEditingTplId] = useState<number | null>(null);
  const [tplFormCategory, setTplFormCategory] = useState('干货拆解');
  const [tplFormTitle, setTplFormTitle] = useState('');
  const [tplFormTags, setTplFormTags] = useState('');
  const [tplFormNote, setTplFormNote] = useState('');
  const [savingTpl, setSavingTpl] = useState(false);

  const [showAddModal, setShowAddModal] = useState(false);
  const [newPlatform, setNewPlatform] = useState<number>(3);
  const [newAccountName, setNewAccountName] = useState('');
  const [sseState, setSseState] = useState<'idle' | 'connecting' | 'qr' | 'success' | 'error'>('idle');
  const [qrSrc, setQrSrc] = useState('');
  const [sseMsg, setSseMsg] = useState('');

  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const qrTimerRef = useRef<number | null>(null);
  const totalTimerRef = useRef<number | null>(null);

  const clearSse = () => {
    if (qrTimerRef.current) {
      window.clearTimeout(qrTimerRef.current);
      qrTimerRef.current = null;
    }
    if (totalTimerRef.current) {
      window.clearTimeout(totalTimerRef.current);
      totalTimerRef.current = null;
    }
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  };

  const loadAll = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const st = await apiRequest<SauStatus>('/api/sau/status');
      setStatus(st);
      setSauDirInput((prev) => prev || st.sauDir || '');
      if (st.running) {
        const [accRes, fileRes, histRes, tplRes] = await Promise.allSettled([
          apiRequest<{ code: number; data: Array<[number, number, string, string, number]> }>('/api/sau/accounts'),
          apiRequest<{ code: number; data: SauFile[] }>('/api/sau/files'),
          apiRequest<{ code: number; data: SauPublishRecord[] }>('/api/sau/publish-history'),
          apiRequest<{ code: number; data: TitleTemplate[] }>('/api/sau/title-templates'),
        ]);
        if (accRes.status === 'fulfilled') {
          const mappedAccounts: SauAccount[] = (accRes.value.data || []).map((row) => ({
            id: row[0],
            type: row[1],
            filePath: row[2],
            name: row[3],
            status: row[4],
          }));
          setAccounts(mappedAccounts);
        }
        if (fileRes.status === 'fulfilled') setFiles(fileRes.value.data || []);
        if (histRes.status === 'fulfilled') setHistory(histRes.value.data || []);
        if (tplRes.status === 'fulfilled') setTemplates(tplRes.value.data || []);
      } else {
        setAccounts([]);
        setFiles([]);
        setHistory([]);
        setTemplates([]);
      }
    } catch (err) {
      if (!silent) onToast((err as Error).message);
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    void loadAll();
    void loadScriptSources();
    const retryTimer = window.setTimeout(() => {
      void loadAll(true);
    }, 2200);
    return () => {
      window.clearTimeout(retryTimer);
      clearSse();
    };
  }, []);

  const loadScriptSources = async () => {
    setLoadingSources(true);
    try {
      const res = await apiRequest<PublishScriptSources>('/api/publish/script-sources');
      setScriptSources(res);
    } catch {
      // 忽略静默加载异常
    } finally {
      setLoadingSources(false);
    }
  };

  const handleImportScriptSource = (val: string) => {
    setSelectedSourceKey(val);
    if (!val || !scriptSources) return;
    if (val.startsWith('t:')) {
      const id = Number(val.slice(2));
      const hit = scriptSources.transcripts.find((x) => x.id === id);
      if (hit) {
        setAiScriptInput(`原视频标题：${hit.title}\n\n口播逐字稿：\n${hit.transcript}`);
        onToast(`已导入口播稿：${hit.title.slice(0, 18)}`);
      }
    } else if (val.startsWith('s:')) {
      const id = Number(val.slice(2));
      const hit = scriptSources.saved.find((x) => x.id === id);
      if (hit) {
        const parts = [`选题标题：${hit.title}`, hit.core_angle ? `核心看点：${hit.core_angle}` : '', hit.notes ? `我的备注：${hit.notes}` : ''].filter(Boolean);
        setAiScriptInput(parts.join('\n\n'));
        onToast(`已导入收藏选题：${hit.title.slice(0, 18)}`);
      }
    }
  };

  const handleGenerateAiCopy = async (forceRefresh = false) => {
    const text = aiScriptInput.trim();
    if (text.length < 8) {
      onToast('请先粘贴一段口播稿或文案要点（至少 8 个字），再点 AI 生成');
      return;
    }
    setAiGenerating(true);
    try {
      const res = await apiRequest<{
        ok: boolean;
        cached?: boolean;
        byPlatform: Record<number, PublishPlatformCopy>;
      }>('/api/publish/ai-generate', {
        method: 'POST',
        body: JSON.stringify({
          script: text,
          styleHint: aiStyleHint.trim() || undefined,
          forceRefresh,
        }),
      });
      setAiPlatformCopies(res.byPlatform);
      setUsePlatformAiCopy(true);
      const firstSelectedPlat = groupedSelectedAccounts[0]?.[0] || 3;
      setAiPreviewPlatform(firstSelectedPlat);
      // 同步当前预览平台的标题与标签到统一输入框与已选视频
      const primary = res.byPlatform[firstSelectedPlat] || res.byPlatform[3];
      if (primary) {
        if (primary.title) setGlobalTitle(primary.title);
        if (primary.tags?.length) setGlobalTagsText(primary.tags.join(', '));
        setVideoDrafts((prev) =>
          prev.map((d) => ({
            ...d,
            title: primary.title || d.title,
            tagsText: primary.tags?.length ? primary.tags.join(', ') : d.tagsText,
          }))
        );
      }
      onToast(res.cached ? '已载入四平台定制文案（可直接微调）' : 'AI 已为抖音 / 小红书 / 视频号 / 快手分别生成标题、正文与标签！');
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setAiGenerating(false);
    }
  };

  const updateAiPlatformField = (pType: number, patch: Partial<PublishPlatformCopy>) => {
    setAiPlatformCopies((prev) => {
      if (!prev) return prev;
      const cur = prev[pType] || { title: '', description: '', tags: [], tip: '' };
      return { ...prev, [pType]: { ...cur, ...patch } };
    });
  };

  const applyCurrentAiCopyToDrafts = () => {
    const copy = aiPlatformCopies?.[aiPreviewPlatform];
    if (!copy) return;
    setGlobalTitle(copy.title);
    setGlobalTagsText(copy.tags.join(', '));
    setVideoDrafts((prev) =>
      prev.map((d) => ({
        ...d,
        title: copy.title || d.title,
        tagsText: copy.tags.join(', '),
      }))
    );
    onToast(`已将「${getPlatformMeta(aiPreviewPlatform).label}」文案同步到下方视频列表`);
  };

  // 接收来自「爆款二创工坊」或监控流的爆款口播稿与选题，自动预填到 AI 文案框与标题
  useEffect(() => {
    if (!inspirationDraft) return;
    const nextTitle = inspirationDraft.title.trim();
    const nextTags = (inspirationDraft.tags || []).join(', ');
    if (inspirationDraft.script?.trim()) {
      setAiScriptInput(inspirationDraft.script.trim());
    } else if (nextTitle) {
      setAiScriptInput(nextTitle);
    }
    if (nextTitle) setGlobalTitle(nextTitle);
    if (nextTags) setGlobalTagsText(nextTags);
    setVideoDrafts((prev) =>
      prev.map((d) => ({
        ...d,
        title: nextTitle || d.title,
        tagsText: nextTags || d.tagsText,
      }))
    );
  }, [inspirationDraft]);

  // 打开扫码绑定弹窗前，若发布引擎未运行则自动拉起，保持交互状态一致
  const openBindAccountModal = async (platformType?: number) => {
    if (platformType) setNewPlatform(platformType);
    setShowAddModal(true);
    if (status && !status.running && status.installed) {
      onToast('正在后台自动唤醒视频发布引擎...');
      await apiRequest('/api/sau/start', { method: 'POST' }).catch(() => {});
      await loadAll(true);
    }
  };

  const handleStartEngine = async () => {
    setEngineBusy(true);
    try {
      const res = await apiRequest<{ ok: boolean; message: string }>('/api/sau/start', { method: 'POST' });
      onToast(res.message);
      await loadAll();
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setEngineBusy(false);
    }
  };

  const handleStopEngine = async () => {
    setEngineBusy(true);
    try {
      const res = await apiRequest<{ ok: boolean; message: string }>('/api/sau/stop', { method: 'POST' });
      onToast(res.message);
      await loadAll();
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setEngineBusy(false);
    }
  };

  const handleInstallEngine = async () => {
    setInstalling(true);
    try {
      const res = await apiRequest<{ ok: boolean; sauDir: string; message: string }>('/api/sau/install', {
        method: 'POST',
        body: JSON.stringify({ sauDir: sauDirInput.trim() || undefined }),
      });
      onToast(res.message);
      await loadAll();
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setInstalling(false);
    }
  };

  const handleSaveSauDir = async () => {
    if (!sauDirInput.trim()) {
      onToast('请先填写本地目录路径');
      return;
    }
    try {
      const res = await apiRequest<{ ok: boolean; sauDir: string }>('/api/sau/config', {
        method: 'POST',
        body: JSON.stringify({ sauDir: sauDirInput.trim() }),
      });
      setSauDirInput(res.sauDir);
      onToast('路径已保存');
      await loadAll();
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  const handleValidateAccounts = async () => {
    setValidating(true);
    try {
      const res = await apiRequest<{ code: number; data: Array<[number, number, string, string, number]> }>(
        '/api/sau/accounts/validate',
        { method: 'POST' }
      );
      const mappedAccounts: SauAccount[] = (res.data || []).map((row) => ({
        id: row[0],
        type: row[1],
        filePath: row[2],
        name: row[3],
        status: row[4],
      }));
      setAccounts(mappedAccounts);
      onToast('账号 Cookie 有效性检查完成');
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setValidating(false);
    }
  };

  const handleDeleteAccount = async (acc: SauAccount) => {
    try {
      await apiRequest(`/api/sau/accounts/${acc.id}`, { method: 'DELETE' });
      setSelectedAccountKeys((prev) => prev.filter((k) => k !== `${acc.type}:${acc.filePath}`));
      onToast(`已删除账号：${acc.name}`);
      await loadAll(true);
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  const handleUploadMaterial = async (fileList: FileList | null, autoSelectForPublish = false) => {
    if (!fileList || fileList.length === 0) return;
    setUploading(true);
    const uploadedNames: string[] = [];
    try {
      for (const f of Array.from(fileList)) {
        const fd = new FormData();
        fd.append('file', f);
        const res = await fetch('/api/sau/upload', { method: 'POST', body: fd });
        const data = (await res.json().catch(() => ({}))) as { code?: number; msg?: string; data?: string };
        if (!res.ok || data.code !== 200) {
          throw new Error(data.msg || `上传失败 (${res.status})`);
        }
        uploadedNames.push(f.name);
      }
      onToast(`成功上传 ${uploadedNames.length} 个视频`);
      const fileRes = await apiRequest<{ code: number; data: SauFile[] }>('/api/sau/files');
      const latestFiles = fileRes.data || [];
      setFiles(latestFiles);
      if (autoSelectForPublish && uploadedNames.length > 0) {
        const newlyAdded = latestFiles.slice(-uploadedNames.length);
        setVideoDrafts((prev) => {
          const exists = new Set(prev.map((d) => d.filePath));
          const extra = newlyAdded
            .filter((f) => !exists.has(f.file_path))
            .map((f) => ({
              filePath: f.file_path,
              filename: f.filename,
              filesize: f.filesize,
              title: globalTitle.trim() || stripFileExt(f.filename),
              tagsText: globalTagsText,
            }));
          return [...prev, ...extra];
        });
      }
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleDeleteFile = async (file: SauFile) => {
    try {
      await apiRequest(`/api/sau/files/${file.id}`, { method: 'DELETE' });
      setVideoDrafts((prev) => prev.filter((d) => d.filePath !== file.file_path));
      onToast(`已删除素材：${file.filename}`);
      await loadAll(true);
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  const startQrLogin = () => {
    if (!newAccountName.trim()) {
      onToast('请先输入账号备注名称');
      return;
    }
    clearSse();
    setSseState('connecting');
    setQrSrc('');
    setSseMsg('正在打开平台登录页获取二维码...');

    const qs = new URLSearchParams({
      type: String(newPlatform),
      id: newAccountName.trim(),
    }).toString();
    const es = new EventSource(`/api/sau/login?${qs}`);
    eventSourceRef.current = es;

    qrTimerRef.current = window.setTimeout(() => {
      clearSse();
      setSseState('error');
      setSseMsg('获取二维码超时，请关闭弹窗重试一次');
    }, 45000);

    totalTimerRef.current = window.setTimeout(() => {
      clearSse();
      setSseState('error');
      setSseMsg('扫码登录超时，请重试');
    }, 305000);

    es.onmessage = (evt) => {
      const raw = (evt.data || '').trim();
      if (!raw) return;
      if (raw.startsWith('STATUS:')) {
        if (qrTimerRef.current) {
          window.clearTimeout(qrTimerRef.current);
          qrTimerRef.current = null;
        }
        setSseState('qr');
        setSseMsg(raw.slice(7) || '已弹出登录窗口，请直接在窗口内完成扫码或验证');
        return;
      }
      if (raw.startsWith('ERROR:')) {
        clearSse();
        setSseState('error');
        setSseMsg(raw.slice(6) || '登录失败，请重试');
        return;
      }
      if (raw === '200') {
        clearSse();
        setSseState('success');
        setSseMsg('扫码登录成功，正在刷新账号列表...');
        window.setTimeout(() => {
          setShowAddModal(false);
          setSseState('idle');
          setNewAccountName('');
          void loadAll(true);
        }, 1200);
        return;
      }
      if (raw === '500') {
        clearSse();
        setSseState('error');
        setSseMsg('登录失败或二维码已过期，请重试');
        return;
      }
      if (raw.startsWith('data:image') || raw.startsWith('http://') || raw.startsWith('https://') || raw.length > 100) {
        if (qrTimerRef.current) {
          window.clearTimeout(qrTimerRef.current);
          qrTimerRef.current = null;
        }
        setQrSrc(
          raw.startsWith('data:image') || raw.startsWith('http://') || raw.startsWith('https://')
            ? raw
            : `data:image/png;base64,${raw}`
        );
        setSseState('qr');
        setSseMsg('请用对应平台 App 扫码；已同步弹出浏览器窗口，若弹出滑块或短信验证请直接在窗口内完成');
      }
    };

    es.onerror = () => {
      clearSse();
      setSseState('error');
      setSseMsg('登录通道连接中断，请关闭弹窗后重试');
    };
  };

  const closeAddModal = () => {
    clearSse();
    setShowAddModal(false);
    setSseState('idle');
    setQrSrc('');
    setSseMsg('');
  };

  const toggleAccountKey = (acc: SauAccount) => {
    const key = `${acc.type}:${acc.filePath}`;
    setSelectedAccountKeys((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  };

  const selectAllNormalAccounts = () => {
    const normals = accounts.filter((a) => a.status === 1);
    const list = normals.length > 0 ? normals : accounts;
    setSelectedAccountKeys(list.map((a) => `${a.type}:${a.filePath}`));
    onToast(`已勾选 ${list.length} 个账号`);
  };

  const toggleVideoFile = (f: SauFile) => {
    setVideoDrafts((prev) => {
      if (prev.some((d) => d.filePath === f.file_path)) {
        return prev.filter((d) => d.filePath !== f.file_path);
      }
      return [
        ...prev,
        {
          filePath: f.file_path,
          filename: f.filename,
          filesize: f.filesize,
          title: globalTitle.trim() || stripFileExt(f.filename),
          tagsText: globalTagsText,
        },
      ];
    });
  };

  const selectAllVideos = () => {
    if (videoDrafts.length === files.length) {
      setVideoDrafts([]);
      return;
    }
    setVideoDrafts(
      files.map((f) => ({
        filePath: f.file_path,
        filename: f.filename,
        filesize: f.filesize,
        title: globalTitle.trim() || stripFileExt(f.filename),
        tagsText: globalTagsText,
      }))
    );
  };

  const updateDraftItem = (filePath: string, patch: Partial<VideoDraftItem>) => {
    setVideoDrafts((prev) => prev.map((d) => (d.filePath === filePath ? { ...d, ...patch } : d)));
  };

  const applyUniformTitleToAll = () => {
    if (!globalTitle.trim() && !globalTagsText.trim()) {
      onToast('请先输入统一标题或话题，再点应用');
      return;
    }
    setVideoDrafts((prev) =>
      prev.map((d) => ({
        ...d,
        title: globalTitle.trim() ? globalTitle.trim() : d.title,
        tagsText: globalTagsText.trim() ? globalTagsText.trim() : d.tagsText,
      }))
    );
    onToast('已把统一标题与话题同步到所有选中视频');
  };

  const applyFilenameAsTitle = () => {
    setVideoDrafts((prev) => prev.map((d) => ({ ...d, title: stripFileExt(d.filename) })));
    onToast('已按文件名自动生成每条视频的标题');
  };

  const assignTemplatesToDrafts = (randomMode: boolean) => {
    if (templates.length === 0) {
      onToast('标题文案库还是空的，请先到「标题文案库」添加模板');
      return;
    }
    if (videoDrafts.length === 0) {
      onToast('请先在上方勾选至少 1 个视频');
      return;
    }
    setVideoDrafts((prev) =>
      prev.map((d, idx) => {
        const tpl = randomMode
          ? templates[Math.floor(Math.random() * templates.length)]
          : templates[idx % templates.length];
        return {
          ...d,
          title: tpl.title,
          tagsText: (tpl.tags || []).join(', '),
        };
      })
    );
    onToast(randomMode ? '已从标题库随机分配标题与话题' : '已按标题库顺序轮流分配标题与话题');
  };

  const parsedDailyTimes = useMemo(() => {
    const arr = dailyTimesText
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    return arr.length > 0 ? arr : ['10:00'];
  }, [dailyTimesText]);

  const schedulePreviewSlots = useMemo(() => {
    if (!enableTimer || videoDrafts.length === 0) return [];
    const perDay = Math.max(1, Number(videosPerDay || 1));
    const base = new Date();
    base.setDate(base.getDate() + 1 + Number(startDays || 0));
    return videoDrafts.slice(0, 6).map((v, idx) => {
      const dayOffset = Math.floor(idx / perDay);
      const timeStr = parsedDailyTimes[idx % parsedDailyTimes.length] || parsedDailyTimes[0];
      const d = new Date(base);
      d.setDate(base.getDate() + dayOffset);
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${v.filename} → ${mm}-${dd} ${timeStr}`;
    });
  }, [enableTimer, videoDrafts, videosPerDay, startDays, parsedDailyTimes]);

  const groupedSelectedAccounts = useMemo(() => {
    const map = new Map<number, string[]>();
    for (const key of selectedAccountKeys) {
      const sep = key.indexOf(':');
      if (sep <= 0) continue;
      const pType = Number(key.slice(0, sep));
      const fp = key.slice(sep + 1);
      if (!map.has(pType)) map.set(pType, []);
      map.get(pType)!.push(fp);
    }
    return Array.from(map.entries());
  }, [selectedAccountKeys]);

  const handleSubmitBatchPublish = async () => {
    if (groupedSelectedAccounts.length === 0) {
      onToast('请至少勾选一个平台账号');
      return;
    }
    if (videoDrafts.length === 0) {
      onToast('请至少勾选一个要发布的视频');
      return;
    }
    const hasAiForAllPlatforms =
      usePlatformAiCopy &&
      aiPlatformCopies !== null &&
      groupedSelectedAccounts.every(([pType]) => Boolean(aiPlatformCopies[pType]?.title?.trim()));

    const emptyTitle = !hasAiForAllPlatforms ? videoDrafts.find((d) => !d.title.trim()) : undefined;
    if (emptyTitle) {
      onToast(`视频「${emptyTitle.filename}」还没有填写标题`);
      return;
    }

    let normalizedDailyTimes = parsedDailyTimes;
    if (enableTimer) {
      const rawTimes = dailyTimesText
        .split(/[,，\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (rawTimes.length === 0) {
        onToast('启用定时发布时，请填写至少一个 HH:MM 时间点（例如 10:00, 18:00）');
        return;
      }
      if (!Number.isInteger(videosPerDay) || videosPerDay < 1) {
        onToast('启用定时发布时，每天发布条数必须为大于等于 1 的整数');
        return;
      }
      if (videosPerDay > rawTimes.length) {
        onToast(`每天发布条数（${videosPerDay}）不能大于每天时间点数量（${rawTimes.length}）`);
        return;
      }
      if (!Number.isInteger(startDays) || startDays < 0) {
        onToast('启用定时发布时，起始天数不能为负数');
        return;
      }

      const parsedPairs: Array<[number, number]> = [];
      const formattedTimes: string[] = [];
      for (const entry of rawTimes) {
        const match = /^(\d{1,2}):(\d{2})$/.exec(entry);
        if (!match) {
          onToast(`定时时间点格式错误「${entry}」，请填写 HH:MM（例如 10:00）`);
          return;
        }
        const hour = Number(match[1]);
        const minute = Number(match[2]);
        if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
          onToast(`定时时间点超出有效范围「${entry}」（小时 0~23，分钟 0~59）`);
          return;
        }
        parsedPairs.push([hour, minute]);
        formattedTimes.push(`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
      }

      const now = new Date();
      let earliestMs = Infinity;
      for (let idx = 0; idx < videoDrafts.length; idx++) {
        const day = Math.floor(idx / videosPerDay) + startDays + 1;
        const [hour, minute] = parsedPairs[idx % videosPerDay];
        const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate() + day, hour, minute, 0, 0);
        if (dt.getTime() < earliestMs) earliestMs = dt.getTime();
      }
      if (!Number.isFinite(earliestMs) || earliestMs <= now.getTime() + 2 * 3600 * 1000) {
        onToast('最早定时发布时间必须晚于当前时间至少 2 小时');
        return;
      }
      normalizedDailyTimes = formattedTimes;
    }

    const tasks: Array<{ platformType: number; platformLabel: string; accountList: string[]; video: VideoDraftItem }> = [];
    for (const [pType, accPaths] of groupedSelectedAccounts) {
      const pLabel = getPlatformMeta(pType).label;
      for (const video of videoDrafts) {
        tasks.push({ platformType: pType, platformLabel: pLabel, accountList: accPaths, video });
      }
    }

    setPublishing(true);
    setBatchResults(
      tasks.map((t) => ({
        platformLabel: t.platformLabel,
        videoName: t.video.filename,
        status: 'pending',
        message: '等待执行',
      }))
    );

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];
      setBatchResults((prev) =>
        prev.map((r, idx) => (idx === i ? { ...r, status: 'running', message: '正在提交...' } : r))
      );

      const aiCopy = usePlatformAiCopy ? aiPlatformCopies?.[t.platformType] : undefined;
      const finalTitle = (aiCopy?.title?.trim() || t.video.title.trim());
      const rawDescription = aiCopy?.description?.trim() || '';
      // 快手网页端无独立标题框，有简介时需将标题与简介合并透传，避免标题丢失
      const finalDescription =
        t.platformType === 4 && rawDescription && rawDescription !== finalTitle && !rawDescription.startsWith(finalTitle)
          ? `${finalTitle}\n${rawDescription}`
          : rawDescription;
      const rawTags = aiCopy?.tags && aiCopy.tags.length > 0
        ? aiCopy.tags
        : t.video.tagsText
            .split(/[,，\s#]+/)
            .map((s) => s.trim())
            .filter(Boolean);

      try {
        await apiRequest<{ code: number; msg: string }>('/api/sau/post-video', {
          method: 'POST',
          body: JSON.stringify({
            type: t.platformType,
            title: finalTitle,
            description: finalDescription,
            tags: rawTags,
            fileList: [t.video.filePath],
            accountList: t.accountList,
            enableTimer: enableTimer ? 1 : 0,
            videosPerDay,
            dailyTimes: normalizedDailyTimes,
            startDays,
            category: isOriginal ? 1 : 0,
            isDraft,
            productLink: t.platformType === 3 ? productLink.trim() : '',
            productTitle: t.platformType === 3 ? productTitle.trim() : '',
          }),
        });
        successCount++;
        setBatchResults((prev) =>
          prev.map((r, idx) => (idx === i ? { ...r, status: 'success', message: '已提交发布' } : r))
        );
      } catch (err) {
        failCount++;
        setBatchResults((prev) =>
          prev.map((r, idx) => (idx === i ? { ...r, status: 'error', message: (err as Error).message } : r))
        );
      }
    }

    setPublishing(false);
    onToast(`批量发布结束：成功 ${successCount} 个任务，失败 ${failCount} 个任务`);
    await loadAll(true);
  };

  const filteredTemplates = useMemo(() => {
    return templates.filter((t) => {
      const matchCat = tplCategoryFilter === '全部' || t.category === tplCategoryFilter;
      const kw = tplSearch.trim().toLowerCase();
      const matchKw =
        !kw ||
        t.title.toLowerCase().includes(kw) ||
        (t.note || '').toLowerCase().includes(kw) ||
        (t.tags || []).some((tg) => tg.toLowerCase().includes(kw));
      return matchCat && matchKw;
    });
  }, [templates, tplCategoryFilter, tplSearch]);

  const openCreateTplModal = () => {
    setEditingTplId(null);
    setTplFormCategory('干货拆解');
    setTplFormTitle('');
    setTplFormTags('');
    setTplFormNote('');
    setShowTplModal(true);
  };

  const openEditTplModal = (tpl: TitleTemplate) => {
    setEditingTplId(tpl.id);
    setTplFormCategory(tpl.category || '通用');
    setTplFormTitle(tpl.title || '');
    setTplFormTags((tpl.tags || []).join(', '));
    setTplFormNote(tpl.note || '');
    setShowTplModal(true);
  };

  const handleSaveTemplate = async () => {
    if (!tplFormTitle.trim()) {
      onToast('请输入标题文案内容');
      return;
    }
    setSavingTpl(true);
    try {
      await apiRequest('/api/sau/title-templates', {
        method: 'POST',
        body: JSON.stringify({
          id: editingTplId || undefined,
          category: tplFormCategory,
          title: tplFormTitle.trim(),
          tags: tplFormTags,
          note: tplFormNote.trim(),
        }),
      });
      setShowTplModal(false);
      onToast(editingTplId ? '标题模板已更新' : '已添加到标题文案库');
      await loadAll(true);
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setSavingTpl(false);
    }
  };

  const handleDeleteTemplate = async (id: number) => {
    try {
      await apiRequest(`/api/sau/title-templates/${id}`, { method: 'DELETE' });
      setTemplates((prev) => prev.filter((t) => t.id !== id));
      onToast('标题模板已删除');
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  const handleApplyTemplateToGlobal = (tpl: TitleTemplate) => {
    setGlobalTitle(tpl.title);
    setGlobalTagsText((tpl.tags || []).join(', '));
    setVideoDrafts((prev) =>
      prev.map((d) => ({
        ...d,
        title: tpl.title,
        tagsText: (tpl.tags || []).join(', '),
      }))
    );
    setSubTab('publish');
    onToast(`已将模板「${tpl.title.slice(0, 14)}...」应用到发布任务`);
  };

  const handleReuseHistory = (item: SauPublishRecord) => {
    const pType = item.platform_type || 3;
    setSelectedAccountKeys((item.account_list || []).map((fp) => `${pType}:${fp}`));
    setGlobalTitle(item.title || '');
    setGlobalTagsText((item.tags || []).join(', '));
    setEnableTimer(Boolean(item.enable_timer));
    setIsDraft(Boolean(item.is_draft));
    const reusedDrafts: VideoDraftItem[] = (item.file_list || []).map((fp) => {
      const matched = files.find((f) => f.file_path === fp);
      const name = matched?.filename || String(fp).split(/[/\\]/).pop() || fp;
      return {
        filePath: fp,
        filename: name,
        filesize: matched?.filesize || 0,
        title: item.title || stripFileExt(name),
        tagsText: (item.tags || []).join(', '),
      };
    });
    setVideoDrafts(reusedDrafts);
    setSubTab('publish');
    onToast('已把历史任务参数回填到批量发布台');
  };

  const handleDeleteHistory = async (id: number) => {
    try {
      await apiRequest(`/api/sau/publish-history/${id}`, { method: 'DELETE' });
      setHistory((prev) => prev.filter((item) => item.id !== id));
      onToast('历史记录已删除');
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  const hasDouyinSelected = groupedSelectedAccounts.some(([pType]) => pType === 3);
  const hasChannelsSelected = groupedSelectedAccounts.some(([pType]) => pType === 2);

  return (
    <div>
      <div className="publish-hero">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div
            style={{
              width: 42,
              height: 42,
              borderRadius: 12,
              background: status?.running ? 'var(--success-soft)' : 'var(--warn-soft)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <ShieldCheck size={22} color={status?.running ? '#16a34a' : '#d97706'} />
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15.5, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              一体化视频发布引擎（已融合至本机工作台）
              <span className={`badge ${status?.running ? 'badge-green' : 'badge-amber'}`}>
                {status?.running ? '随工作台运行中' : '未启动'}
              </span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span>内置引擎：</span>
              <span
                className="path-ellipsis"
                title={`点击复制路径：${status?.sauDir || ''}`}
                onClick={() => {
                  if (status?.sauDir) {
                    void navigator.clipboard?.writeText(status.sauDir);
                    onToast('已复制发布引擎目录路径');
                  }
                }}
              >
                {status?.sauDir || '自动检测中...'}
              </span>
              <span>· 账号 {accounts.length} 个 · 视频 {files.length} 条 · 标题模板 {templates.length} 套</span>
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {status && !status.installed ? (
            <button className="btn btn-primary btn-sm" disabled={installing} onClick={() => void handleInstallEngine()}>
              {installing ? '正在配置环境...' : '一键配置发布环境'}
            </button>
          ) : !status?.running ? (
            <button className="btn btn-primary btn-sm" disabled={engineBusy} onClick={() => void handleStartEngine()}>
              <Play size={13} /> {engineBusy ? '启动中...' : '启动发布引擎'}
            </button>
          ) : (
            <button className="btn btn-danger btn-sm" disabled={engineBusy} onClick={() => void handleStopEngine()}>
              <Square size={13} /> {engineBusy ? '停止中...' : '停止引擎'}
            </button>
          )}
          <button className="btn btn-sm" disabled={loading} onClick={() => void loadAll()}>
            <RefreshCw size={13} /> 刷新数据
          </button>
          <button className="btn btn-sm" disabled={validating || !status?.running} onClick={() => void handleValidateAccounts()}>
            {validating ? '检测中...' : '检测账号 Cookie'}
          </button>
        </div>
      </div>

      {status && !status.installed && (
        <div className="card" style={{ marginBottom: 16, background: '#fffbeb', borderColor: '#fde68a' }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>首次使用提示：尚未检测到内置发布引擎 Python 虚拟环境</div>
          <div style={{ fontSize: 13, color: '#78350f', marginBottom: 10 }}>
            点击「一键配置发布环境」即可自动初始化 Python 依赖与浏览器内核，之后每次打开工作台都会随主服务自动启停，无需再手动开第二个窗口。
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input
              className="input"
              value={sauDirInput}
              onChange={(e) => setSauDirInput(e.target.value)}
              placeholder="默认使用内置 sau-engine 目录"
              style={{ flex: 1, minWidth: 260 }}
            />
            <button className="btn btn-sm" onClick={() => void handleSaveSauDir()}>保存路径</button>
            <button className="btn btn-primary btn-sm" disabled={installing} onClick={() => void handleInstallEngine()}>
              {installing ? '配置中（约1~2分钟）...' : '一键配置发布环境'}
            </button>
          </div>
        </div>
      )}

      <div className="tab-pill-bar">
        <button className={`tab-pill ${subTab === 'publish' ? 'active' : ''}`} onClick={() => setSubTab('publish')}>
          <Layers size={14} /> 批量视频发布
        </button>
        <button className={`tab-pill ${subTab === 'titles' ? 'active' : ''}`} onClick={() => setSubTab('titles')}>
          <BookOpen size={14} /> 标题文案库 ({templates.length})
        </button>
        <button className={`tab-pill ${subTab === 'accounts' ? 'active' : ''}`} onClick={() => setSubTab('accounts')}>
          发布账号 ({accounts.length})
        </button>
        <button className={`tab-pill ${subTab === 'materials' ? 'active' : ''}`} onClick={() => setSubTab('materials')}>
          视频素材 ({files.length})
        </button>
        <button className={`tab-pill ${subTab === 'history' ? 'active' : ''}`} onClick={() => setSubTab('history')}>
          <Clock size={14} /> 发布历史 ({history.length})
        </button>
      </div>

      {subTab === 'publish' && (
        <div style={{ display: 'grid', gap: 16 }}>
          {inspirationDraft && (
            <div className="card" style={{ background: '#eef2ff', borderColor: '#c7d2fe', padding: '12px 18px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ fontSize: 13 }}>
                  <span className="badge badge-blue" style={{ marginRight: 8 }}>对标选题联动</span>
                  已带入来自「<strong>{inspirationDraft.sourceName || '监控内容'}</strong>」的选题：
                  <strong style={{ marginLeft: 4 }}>{inspirationDraft.title}</strong>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  {inspirationDraft.sourceUrl && (
                    <a className="btn btn-sm" href={inspirationDraft.sourceUrl} target="_blank" rel="noreferrer">
                      查看原帖
                    </a>
                  )}
                  <button className="btn btn-sm" onClick={() => onClearInspiration?.()}>
                    清除提示
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 15 }}>1. 选择要发布的平台与账号（支持多平台同时勾选）</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  已选 {selectedAccountKeys.length} 个账号，覆盖 {groupedSelectedAccounts.length} 个平台
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                {accounts.length > 0 && (
                  <button className="btn btn-sm" onClick={selectAllNormalAccounts}>
                    <CheckCircle2 size={13} /> 全选正常账号
                  </button>
                )}
                {selectedAccountKeys.length > 0 && (
                  <button className="btn btn-sm" onClick={() => setSelectedAccountKeys([])}>清空账号</button>
                )}
                <button className="btn btn-primary btn-sm" onClick={() => void openBindAccountModal()}>
                  <Plus size={13} /> 扫码添加账号
                </button>
              </div>
            </div>

              <div className="platform-grid">
                {PLATFORM_OPTIONS.map((plat) => {
                  const pAccounts = accounts.filter((a) => a.type === plat.type);
                  return (
                    <div key={plat.type} className="platform-box">
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                        <span className={`badge ${plat.badge}`}>{plat.label}</span>
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{pAccounts.length} 个号</span>
                      </div>
                      {pAccounts.length === 0 ? (
                        <button
                          className="btn btn-sm"
                          style={{ width: '100%' }}
                          onClick={() => void openBindAccountModal(plat.type)}
                        >
                          + 绑定{plat.label}
                        </button>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          {pAccounts.map((acc) => {
                            const key = `${acc.type}:${acc.filePath}`;
                            const checked = selectedAccountKeys.includes(key);
                            return (
                              <button
                                key={acc.id}
                                type="button"
                                className={`btn btn-sm ${checked ? 'btn-primary' : ''}`}
                                style={{ justifyContent: 'space-between', width: '100%' }}
                                onClick={() => toggleAccountKey(acc)}
                              >
                                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{acc.name}</span>
                                <span className={`badge ${acc.status === 1 ? 'badge-green' : 'badge-red'}`}>
                                  {acc.status === 1 ? '正常' : '失效'}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
          </div>

          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 15 }}>2. 批量上传或勾选待发布视频（已选 {videoDrafts.length} 条）</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>支持直接把多条视频拖进虚线框内，上传后自动勾选进入发布列表</div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                {files.length > 0 && (
                  <button className="btn btn-sm" onClick={selectAllVideos}>
                    {videoDrafts.length === files.length ? '取消全选视频' : `全选已有视频 (${files.length})`}
                  </button>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="video/*"
                  multiple
                  style={{ display: 'none' }}
                  onChange={(e) => void handleUploadMaterial(e.target.files, true)}
                />
                <button className="btn btn-primary btn-sm" disabled={uploading} onClick={() => fileInputRef.current?.click()}>
                  <Upload size={13} /> {uploading ? '批量上传中...' : '批量选择本地视频'}
                </button>
              </div>
            </div>

            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                void handleUploadMaterial(e.dataTransfer.files, true);
              }}
              onClick={() => fileInputRef.current?.click()}
              style={{
                border: `1.5px dashed ${dragOver ? 'var(--primary)' : 'var(--border)'}`,
                background: dragOver ? 'var(--primary-soft)' : 'var(--surface-muted)',
                borderRadius: 10,
                padding: '18px 16px',
                textAlign: 'center',
                cursor: 'pointer',
                marginBottom: files.length > 0 ? 12 : 0,
              }}
            >
              <div style={{ fontWeight: 600, color: 'var(--primary)' }}>
                {uploading ? '正在批量上传视频，请稍候...' : '把多个视频直接拖拽到这里，或点击批量添加视频'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>支持 MP4 / MOV / AVI 等格式（单文件上限 160MB）</div>
            </div>

            {files.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {files.map((f) => {
                  const checked = videoDrafts.some((d) => d.filePath === f.file_path);
                  return (
                    <button
                      key={f.id}
                      type="button"
                      className={`btn btn-sm ${checked ? 'btn-primary' : ''}`}
                      onClick={() => toggleVideoFile(f)}
                    >
                      {checked ? '✓ ' : ''}{f.filename} ({f.filesize}MB)
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 15 }}>3. AI 自动按平台写标题、正文与标签（也可手动微调）</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>把视频口播稿或大纲丢进来，AI 自动按抖音 / 小红书 / 视频号 / 快手 4 个平台风格分别填好</div>
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button className="btn btn-sm" onClick={() => setSubTab('titles')}>
                  <BookOpen size={13} /> 管理标题库
                </button>
                <button className="btn btn-sm" onClick={applyFilenameAsTitle} disabled={videoDrafts.length === 0}>
                  用文件名当标题
                </button>
                <button className="btn btn-sm" onClick={() => assignTemplatesToDrafts(false)} disabled={videoDrafts.length === 0}>
                  <Sparkles size={13} /> 标题库顺序分配
                </button>
                <button className="btn btn-sm" onClick={() => assignTemplatesToDrafts(true)} disabled={videoDrafts.length === 0}>
                  <Sparkles size={13} /> 标题库随机分配
                </button>
              </div>
            </div>

            {/* AI 按平台自动生成标题、正文与标签工作区 */}
            <div className="publish-ai-box">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, fontSize: 14, color: '#3730a3' }}>
                  <Sparkles size={15} /> AI 丢文案自动写四平台标题 + 正文 + 标签
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <select
                    className="select"
                    style={{ width: 240, padding: '6px 10px', fontSize: 12 }}
                    value={selectedSourceKey}
                    disabled={loadingSources}
                    onChange={(e) => handleImportScriptSource(e.target.value)}
                  >
                    <option value="">从已有口播稿 / 收藏本一键导入...</option>
                    {scriptSources && scriptSources.transcripts.length > 0 && (
                      <optgroup label="已转写的视频口播稿">
                        {scriptSources.transcripts.map((t) => (
                          <option key={`t:${t.id}`} value={`t:${t.id}`}>
                            [口播] {t.title.slice(0, 26)}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {scriptSources && scriptSources.saved.length > 0 && (
                      <optgroup label="简易收藏本里的选题">
                        {scriptSources.saved.map((s) => (
                          <option key={`s:${s.id}`} value={`s:${s.id}`}>
                            [收藏] {s.title.slice(0, 26)}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                  <button className="btn btn-sm" type="button" onClick={() => void loadScriptSources()}>
                    <RefreshCw size={12} />
                  </button>
                </div>
              </div>

              <textarea
                className="textarea"
                data-testid="publish-ai-script"
                rows={4}
                value={aiScriptInput}
                onChange={(e) => setAiScriptInput(e.target.value)}
                placeholder="把你的视频口播稿、脚本文案或核心要点粘贴到这里（例如：今天给大家实测3个免费AI剪辑工具，不用买会员就能自动加字幕...）"
              />

              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 }}>
                <input
                  className="input"
                  style={{ flex: '1 1 240px' }}
                  value={aiStyleHint}
                  onChange={(e) => setAiStyleHint(e.target.value)}
                  placeholder="可选风格补充（例如：偏硬核干货 / 口语接地气 / 少用感叹号）"
                />
                <button
                  type="button"
                  data-testid="publish-ai-gen-btn"
                  className="btn btn-primary btn-sm"
                  disabled={aiGenerating}
                  onClick={() => void handleGenerateAiCopy(false)}
                >
                  <Sparkles size={13} /> {aiGenerating ? 'AI 正在按四平台定制...' : 'AI 一键生成各平台标题和标签'}
                </button>
                {aiPlatformCopies && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={aiGenerating}
                    onClick={() => void handleGenerateAiCopy(true)}
                  >
                    <RotateCcw size={12} /> 换一版
                  </button>
                )}
              </div>

              {aiPlatformCopies && (
                <div className="publish-ai-result">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {PLATFORM_OPTIONS.map((p) => {
                        const active = aiPreviewPlatform === p.type;
                        const isChosen = groupedSelectedAccounts.some(([pt]) => pt === p.type);
                        return (
                          <button
                            key={p.type}
                            type="button"
                            data-testid={`publish-ai-plat-${p.type}`}
                            className={`btn btn-sm ${active ? 'btn-primary' : ''}`}
                            onClick={() => setAiPreviewPlatform(p.type)}
                          >
                            {p.label}
                            {isChosen && <span style={{ fontSize: 10, opacity: 0.9 }}> · 已选</span>}
                          </button>
                        );
                      })}
                    </div>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600, color: '#3730a3', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={usePlatformAiCopy}
                        onChange={(e) => setUsePlatformAiCopy(e.target.checked)}
                      />
                      发布时按各平台自动套用下方专属文案
                    </label>
                  </div>

                  {(() => {
                    const cur = aiPlatformCopies[aiPreviewPlatform] || { title: '', description: '', tags: [], tip: '' };
                    return (
                      <div style={{ display: 'grid', gap: 10 }}>
                        <div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                            <span>{getPlatformMeta(aiPreviewPlatform).label}专属标题</span>
                            <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>{cur.title.length} 字</span>
                          </div>
                          <input
                            className="input"
                            data-testid="publish-ai-title-input"
                            value={cur.title}
                            onChange={(e) => updateAiPlatformField(aiPreviewPlatform, { title: e.target.value })}
                          />
                        </div>

                        <div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                            <span>{getPlatformMeta(aiPreviewPlatform).label}正文简介（抖音 / 小红书发布时会自动填入）</span>
                            <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>{cur.description.length} 字</span>
                          </div>
                          <textarea
                            className="textarea"
                            rows={4}
                            value={cur.description}
                            onChange={(e) => updateAiPlatformField(aiPreviewPlatform, { description: e.target.value })}
                          />
                        </div>

                        <div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                            <span>{getPlatformMeta(aiPreviewPlatform).label}话题标签（逗号分隔，自动加 #）</span>
                            <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>{cur.tags.length} 个标签</span>
                          </div>
                          <input
                            className="input"
                            data-testid="publish-ai-tags-input"
                            value={cur.tags.join(', ')}
                            onChange={(e) =>
                              updateAiPlatformField(aiPreviewPlatform, {
                                tags: e.target.value
                                  .split(/[,，\s#]+/)
                                  .map((s) => s.trim())
                                  .filter(Boolean),
                              })
                            }
                          />
                        </div>

                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 12, color: '#4338ca' }}>
                            {cur.tip ? `起量建议：${cur.tip}` : '已自动按该平台调性优化，点击上方标签可随时修改'}
                          </span>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={async () => {
                                const txt = `${cur.title}\n\n${cur.description}\n\n${cur.tags.map((t) => `#${t}`).join(' ')}`;
                                await navigator.clipboard?.writeText(txt);
                                onToast(`已复制${getPlatformMeta(aiPreviewPlatform).label}完整文案`);
                              }}
                            >
                              <Copy size={12} /> 复制本平台文案
                            </button>
                            <button
                              type="button"
                              className="btn btn-primary btn-sm"
                              disabled={videoDrafts.length === 0}
                              onClick={applyCurrentAiCopyToDrafts}
                            >
                              同步到下方视频列表
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr auto',
                gap: 10,
                padding: 12,
                borderRadius: 10,
                background: 'var(--surface-muted)',
                border: '1px solid var(--border)',
                marginBottom: 14,
                alignItems: 'end',
              }}
            >
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>统一标题（可一键同步给所有已选视频）</label>
                <input
                  className="input"
                  value={globalTitle}
                  onChange={(e) => setGlobalTitle(e.target.value)}
                  placeholder="例如：效率工具实测分享，建议收藏！"
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>统一话题标签（逗号或空格分隔）</label>
                <input
                  className="input"
                  value={globalTagsText}
                  onChange={(e) => setGlobalTagsText(e.target.value)}
                  placeholder="例如：效率神器, 干货分享"
                />
              </div>
              <button className="btn btn-primary btn-sm" onClick={applyUniformTitleToAll} disabled={videoDrafts.length === 0}>
                一键应用到全部视频
              </button>
            </div>

            {templates.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>快捷点击标题库模板填入：</span>
                {templates.slice(0, 6).map((tpl) => (
                  <button
                    key={tpl.id}
                    type="button"
                    className="btn btn-sm"
                    style={{ fontSize: 11, padding: '3px 9px' }}
                    onClick={() => handleApplyTemplateToGlobal(tpl)}
                    title={tpl.title}
                  >
                    [{tpl.category}] {tpl.title.slice(0, 14)}{tpl.title.length > 14 ? '...' : ''}
                  </button>
                ))}
              </div>
            )}

            {videoDrafts.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '8px 0' }}>
                请先在「第 2 步」勾选或上传要发布的视频，这里会列出每条视频的独立标题和话题方便你微调。
              </div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: '24%' }}>视频文件名</th>
                      <th style={{ width: '42%' }}>独立标题（可逐条修改）</th>
                      <th style={{ width: '26%' }}>独立话题标签</th>
                      <th style={{ width: '8%' }}>移除</th>
                    </tr>
                  </thead>
                  <tbody>
                    {videoDrafts.map((item) => (
                      <tr key={item.filePath}>
                        <td>
                          <div style={{ fontWeight: 600 }}>{item.filename}</div>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{item.filesize} MB</div>
                        </td>
                        <td>
                          <input
                            className="input"
                            value={item.title}
                            onChange={(e) => updateDraftItem(item.filePath, { title: e.target.value })}
                            placeholder="请输入这条视频的标题"
                          />
                        </td>
                        <td>
                          <input
                            className="input"
                            value={item.tagsText}
                            onChange={(e) => updateDraftItem(item.filePath, { tagsText: e.target.value })}
                            placeholder="逗号分隔，如：干货, 测评"
                          />
                        </td>
                        <td>
                          <button
                            className="btn btn-danger btn-sm"
                            onClick={() => setVideoDrafts((prev) => prev.filter((d) => d.filePath !== item.filePath))}
                          >
                            移除
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="card" style={{ display: 'grid', gap: 14 }}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>4. 定时排期与高级选项</div>

            <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600 }}>
                <input type="checkbox" checked={enableTimer} onChange={(e) => setEnableTimer(e.target.checked)} />
                开启定时排期发布
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                <input type="checkbox" checked={isOriginal} onChange={(e) => setIsOriginal(e.target.checked)} />
                声明原创
              </label>
              {hasChannelsSelected && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                  <input type="checkbox" checked={isDraft} onChange={(e) => setIsDraft(e.target.checked)} />
                  视频号仅保存为草稿（用手机确认发布）
                </label>
              )}
            </div>

            {enableTimer && (
              <div style={{ padding: 12, borderRadius: 10, background: 'var(--surface-muted)', border: '1px solid var(--border)', display: 'grid', gap: 10 }}>
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
                  <label style={{ fontSize: 13 }}>
                    每天发布条数：
                    <input
                      className="input"
                      type="number"
                      min={1}
                      max={10}
                      value={videosPerDay}
                      onChange={(e) => setVideosPerDay(Number(e.target.value) || 1)}
                      style={{ width: 72, display: 'inline-block', marginLeft: 6 }}
                    />
                  </label>
                  <label style={{ fontSize: 13 }}>
                    每天时间点（逗号分隔）：
                    <input
                      className="input"
                      value={dailyTimesText}
                      onChange={(e) => setDailyTimesText(e.target.value)}
                      placeholder="10:00, 18:00"
                      style={{ width: 170, display: 'inline-block', marginLeft: 6 }}
                    />
                  </label>
                  <label style={{ fontSize: 13 }}>
                    起始天数：
                    <select
                      className="select"
                      value={startDays}
                      onChange={(e) => setStartDays(Number(e.target.value))}
                      style={{ width: 120, display: 'inline-block', marginLeft: 6 }}
                    >
                      <option value={0}>明天起</option>
                      <option value={1}>后天起</option>
                      <option value={2}>3天后起</option>
                    </select>
                  </label>
                </div>
                {schedulePreviewSlots.length > 0 && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)' }}>排期预览：</span>
                    {schedulePreviewSlots.map((slot, i) => (
                      <span key={i} className="badge badge-blue">{slot}</span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {hasDouyinSelected && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>抖音商品链接（可选）</label>
                  <input className="input" value={productLink} onChange={(e) => setProductLink(e.target.value)} placeholder="不挂车请留空" />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>抖音商品短标题（可选）</label>
                  <input className="input" value={productTitle} onChange={(e) => setProductTitle(e.target.value)} placeholder="不挂车请留空" />
                </div>
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, paddingTop: 6, borderTop: '1px solid var(--border)' }}>
              <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                预计分发总任务数：<strong>{selectedAccountKeys.length * videoDrafts.length}</strong> 个
                （已选 {selectedAccountKeys.length} 个账号 / 覆盖 {groupedSelectedAccounts.length} 个平台 × {videoDrafts.length} 条视频）
              </div>
              <button
                className="btn btn-primary"
                disabled={publishing || !status?.running}
                onClick={() => void handleSubmitBatchPublish()}
              >
                <Send size={14} /> {publishing ? '正在批量提交发布...' : '一键开始全部批量发布'}
              </button>
            </div>

            {batchResults.length > 0 && (
              <div style={{ padding: 12, borderRadius: 10, background: 'var(--surface-muted)', border: '1px solid var(--border)' }}>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>本次批量提交实时进度：</div>
                <div style={{ display: 'grid', gap: 6 }}>
                  {batchResults.map((res, idx) => (
                    <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, alignItems: 'center' }}>
                      <span>[{res.platformLabel}] {res.videoName}</span>
                      <span
                        className={`badge ${
                          res.status === 'success'
                            ? 'badge-green'
                            : res.status === 'error'
                              ? 'badge-red'
                              : res.status === 'running'
                                ? 'badge-blue'
                                : 'badge-gray'
                        }`}
                      >
                        {res.message}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {subTab === 'titles' && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, flexWrap: 'wrap', gap: 10 }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 15 }}>标题与文案模板库（可随时增删改、按分类管理、批量发布时一键分配）</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>把平时爆款标题、常用话题组合存下来，发视频时不用每次现想</div>
            </div>
            <button className="btn btn-primary btn-sm" onClick={openCreateTplModal}>
              <Plus size={13} /> 新增标题模板
            </button>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {TEMPLATE_CATEGORIES.map((cat) => (
                <button
                  key={cat}
                  className={`btn btn-sm ${tplCategoryFilter === cat ? 'btn-primary' : ''}`}
                  onClick={() => setTplCategoryFilter(cat)}
                >
                  {cat}
                </button>
              ))}
            </div>
            <input
              className="input"
              value={tplSearch}
              onChange={(e) => setTplSearch(e.target.value)}
              placeholder="搜索标题、话题或备注..."
              style={{ width: 240 }}
            />
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: '11%' }}>分类</th>
                  <th style={{ width: '35%' }}>标题内容</th>
                  <th style={{ width: '20%' }}>配套话题</th>
                  <th style={{ width: '14%' }}>适用备注</th>
                  <th style={{ width: '20%' }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredTemplates.length === 0 ? (
                  <tr>
                    <td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                      没有匹配的标题模板，点击右上角「新增标题模板」添加一条吧
                    </td>
                  </tr>
                ) : (
                  filteredTemplates.map((tpl) => (
                    <tr key={tpl.id}>
                      <td><span className="badge badge-blue">{tpl.category}</span></td>
                      <td style={{ fontWeight: 600 }}>{tpl.title}</td>
                      <td>
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          {(tpl.tags || []).map((tg, i) => (
                            <span key={i} className="badge badge-gray">#{tg}</span>
                          ))}
                        </div>
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{tpl.note || '-'}</td>
                      <td>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'nowrap', whiteSpace: 'nowrap' }}>
                          <button className="btn btn-primary btn-sm" onClick={() => handleApplyTemplateToGlobal(tpl)}>
                            去发布套用
                          </button>
                          <button
                            className="btn btn-sm"
                            onClick={() => {
                              void navigator.clipboard?.writeText(tpl.title);
                              onToast('已复制标题');
                            }}
                          >
                            <Copy size={12} />
                          </button>
                          <button className="btn btn-sm" onClick={() => openEditTplModal(tpl)}>
                            <Edit3 size={12} />
                          </button>
                          <button className="btn btn-danger btn-sm" onClick={() => void handleDeleteTemplate(tpl.id)}>
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {subTab === 'accounts' && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ fontWeight: 600 }}>已绑定发布账号</div>
            <button className="btn btn-primary btn-sm" onClick={() => void openBindAccountModal()}>
              <Plus size={13} /> 扫码添加账号
            </button>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>平台</th>
                  <th>账号名称</th>
                  <th>Cookie 状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {accounts.length === 0 ? (
                  <tr>
                    <td colSpan={4} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                      暂无发布账号，点击右上角扫码绑定
                    </td>
                  </tr>
                ) : (
                  accounts.map((acc) => {
                    const meta = getPlatformMeta(acc.type);
                    return (
                      <tr key={acc.id}>
                        <td><span className={`badge ${meta.badge}`}>{meta.label}</span></td>
                        <td style={{ fontWeight: 600 }}>{acc.name}</td>
                        <td>
                          <span className={`badge ${acc.status === 1 ? 'badge-green' : 'badge-red'}`}>
                            {acc.status === 1 ? '正常' : '失效/待重登'}
                          </span>
                        </td>
                        <td>
                          <button className="btn btn-danger btn-sm" onClick={() => void handleDeleteAccount(acc)}>
                            <Trash2 size={13} /> 删除
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {subTab === 'materials' && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ fontWeight: 600 }}>已上传视频素材</div>
            <button className="btn btn-primary btn-sm" disabled={uploading} onClick={() => fileInputRef.current?.click()}>
              <Upload size={13} /> {uploading ? '上传中...' : '上传视频'}
            </button>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>文件名</th>
                  <th>大小</th>
                  <th>上传时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {files.length === 0 ? (
                  <tr>
                    <td colSpan={4} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>暂无视频素材</td>
                  </tr>
                ) : (
                  files.map((f) => (
                    <tr key={f.id}>
                      <td>{f.filename}</td>
                      <td>{f.filesize} MB</td>
                      <td>{f.upload_time}</td>
                      <td style={{ display: 'flex', gap: 6 }}>
                        <button
                          className="btn btn-sm"
                          onClick={() => {
                            if (!videoDrafts.some((d) => d.filePath === f.file_path)) {
                              toggleVideoFile(f);
                            }
                            setSubTab('publish');
                          }}
                        >
                          加入批量发布
                        </button>
                        <button className="btn btn-danger btn-sm" onClick={() => void handleDeleteFile(f)}>
                          <Trash2 size={13} /> 删除
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {subTab === 'history' && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ fontWeight: 600 }}>最近发布记录（支持一键复用重发）</div>
            <button className="btn btn-sm" onClick={() => void loadAll(true)}>
              <RefreshCw size={13} /> 刷新记录
            </button>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>平台</th>
                  <th>标题</th>
                  <th>策略</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {history.length === 0 ? (
                  <tr>
                    <td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>暂无发布历史记录</td>
                  </tr>
                ) : (
                  history.map((item) => (
                    <tr key={item.id}>
                      <td style={{ fontSize: 12 }}>{item.created_at}</td>
                      <td>{item.platform_name}</td>
                      <td>{item.title}</td>
                      <td style={{ fontSize: 12 }}>{item.schedule_summary}</td>
                      <td>
                        <span className={`badge ${item.status === 'success' ? 'badge-green' : 'badge-red'}`}>
                          {item.status === 'success' ? '已提交' : '失败'}
                        </span>
                      </td>
                      <td style={{ display: 'flex', gap: 6 }}>
                        <button className="btn btn-sm" onClick={() => handleReuseHistory(item)}>
                          <RotateCcw size={13} /> 复用参数
                        </button>
                        <button className="btn btn-danger btn-sm" onClick={() => void handleDeleteHistory(item.id)}>
                          <Trash2 size={13} /> 删除
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showTplModal && (
        <div className="modal-backdrop">
          <div className="modal-card" style={{ maxWidth: 500 }}>
            <div className="modal-header">
              <div style={{ fontWeight: 600 }}>{editingTplId ? '编辑标题模板' : '新增标题模板'}</div>
              <button className="btn btn-sm" onClick={() => setShowTplModal(false)}>关闭</button>
            </div>
            <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
              <div>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6 }}>模板分类</label>
                <select className="select" value={tplFormCategory} onChange={(e) => setTplFormCategory(e.target.value)}>
                  {TEMPLATE_CATEGORIES.filter((c) => c !== '全部').map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6 }}>标题/文案内容</label>
                <textarea
                  className="textarea"
                  rows={3}
                  value={tplFormTitle}
                  onChange={(e) => setTplFormTitle(e.target.value)}
                  placeholder="请输入常用爆款标题内容"
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6 }}>配套话题（逗号分隔）</label>
                <input
                  className="input"
                  value={tplFormTags}
                  onChange={(e) => setTplFormTags(e.target.value)}
                  placeholder="例如：干货分享, 效率工具"
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6 }}>适用场景备注（选填）</label>
                <input
                  className="input"
                  value={tplFormNote}
                  onChange={(e) => setTplFormNote(e.target.value)}
                  placeholder="例如：适合软件测评开箱"
                />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => setShowTplModal(false)}>取消</button>
              <button className="btn btn-primary" disabled={savingTpl} onClick={() => void handleSaveTemplate()}>
                {savingTpl ? '保存中...' : '保存模板'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showAddModal && (
        <div className="modal-backdrop">
          <div className="modal-card" style={{ maxWidth: 460 }}>
            <div className="modal-header">
              <div style={{ fontWeight: 600 }}>扫码添加发布账号</div>
              <button className="btn btn-sm" onClick={closeAddModal}>关闭</button>
            </div>
            <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
              <div>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6 }}>选择平台</label>
                <select
                  className="select"
                  value={newPlatform}
                  disabled={sseState === 'connecting' || sseState === 'qr'}
                  onChange={(e) => setNewPlatform(Number(e.target.value))}
                >
                  {PLATFORM_OPTIONS.map((p) => (
                    <option key={p.type} value={p.type}>{p.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6 }}>账号备注名称</label>
                <input
                  className="input"
                  value={newAccountName}
                  disabled={sseState === 'connecting' || sseState === 'qr'}
                  onChange={(e) => setNewAccountName(e.target.value)}
                  placeholder="例如：公司抖音主号"
                />
              </div>

              {sseState !== 'idle' && (
                <div style={{ textAlign: 'center', padding: 14, background: '#f8fafc', borderRadius: 10 }}>
                  {qrSrc && sseState === 'qr' && (
                    <img src={qrSrc} alt="登录二维码" style={{ width: 185, height: 185, objectFit: 'contain', margin: '0 auto 8px', background: '#fff', padding: 8, borderRadius: 10, border: '1px solid #e2e8f0' }} />
                  )}
                  <div style={{ fontSize: 13, color: sseState === 'error' ? '#dc2626' : sseState === 'success' ? '#16a34a' : '#334155' }}>
                    {sseMsg}
                  </div>
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={closeAddModal}>取消</button>
              <button
                className="btn btn-primary"
                disabled={sseState === 'connecting' || sseState === 'qr' || sseState === 'success'}
                onClick={startQrLogin}
              >
                {sseState === 'connecting' ? '获取二维码中...' : sseState === 'qr' ? '等待扫码...' : '获取二维码'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
