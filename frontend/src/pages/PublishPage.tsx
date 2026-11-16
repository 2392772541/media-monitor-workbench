import { useEffect, useRef, useState } from 'react';
import { Play, Square, RefreshCw, Plus, Trash2, Upload, Send, ShieldCheck, Clock, ExternalLink, RotateCcw } from 'lucide-react';
import { apiRequest } from '../api';

interface SauStatus {
  installed: boolean;
  repoPresent?: boolean;
  sauDir: string;
  running: boolean;
  managedByWorkbench: boolean;
  port: number;
  frontendPort: number;
  backendUrl: string;
  frontendUrl: string;
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

const TITLE_TEMPLATES = [
  { label: '干货拆解', title: '【干货必看】3分钟讲清楚核心逻辑，建议先收藏再慢慢看！', tags: '干货分享, 效率提升' },
  { label: '好物测评', title: '真实体验一周后才敢说实话：到底值不值得入手？', tags: '好物推荐, 真实测评' },
  { label: '教程实操', title: '保姆级手把手教学，跟着做一遍就能学会！', tags: '教程, 新手必看' },
];

const PLATFORM_OPTIONS = [
  { type: 3, label: '抖音', badge: 'badge-red' },
  { type: 4, label: '快手', badge: 'badge-amber' },
  { type: 1, label: '小红书', badge: 'badge-blue' },
  { type: 2, label: '微信视频号', badge: 'badge-green' },
] as const;

function getPlatformMeta(type: number) {
  return PLATFORM_OPTIONS.find((p) => p.type === type) || { type, label: `平台(${type})`, badge: 'badge-gray' };
}

export function PublishPage({ onToast }: { onToast: (msg: string) => void }) {
  const [subTab, setSubTab] = useState<'publish' | 'accounts' | 'materials' | 'history'>('publish');
  const [status, setStatus] = useState<SauStatus | null>(null);
  const [accounts, setAccounts] = useState<SauAccount[]>([]);
  const [files, setFiles] = useState<SauFile[]>([]);
  const [history, setHistory] = useState<SauPublishRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [validating, setValidating] = useState(false);
  const [engineBusy, setEngineBusy] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [sauDirInput, setSauDirInput] = useState('');

  // 发布表单状态
  const [platformType, setPlatformType] = useState<number>(3);
  const [selectedAccounts, setSelectedAccounts] = useState<string[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [tagsText, setTagsText] = useState('');
  const [enableTimer, setEnableTimer] = useState(false);
  const [videosPerDay, setVideosPerDay] = useState(1);
  const [dailyTime, setDailyTime] = useState('10:00');
  const [startDays, setStartDays] = useState(0);
  const [isDraft, setIsDraft] = useState(false);
  const [productLink, setProductLink] = useState('');
  const [productTitle, setProductTitle] = useState('');
  const [publishing, setPublishing] = useState(false);

  // 添加账号弹窗与 SSE
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
        const [accRes, fileRes] = await Promise.all([
          apiRequest<{ code: number; data: Array<[number, number, string, string, number]> }>('/api/sau/accounts'),
          apiRequest<{ code: number; data: SauFile[] }>('/api/sau/files'),
        ]);
        const mappedAccounts: SauAccount[] = (accRes.data || []).map((row) => ({
          id: row[0],
          type: row[1],
          filePath: row[2],
          name: row[3],
          status: row[4],
        }));
        setAccounts(mappedAccounts);
        setFiles(fileRes.data || []);
        try {
          const histRes = await apiRequest<{ code: number; data: SauPublishRecord[] }>('/api/sau/publish-history');
          setHistory(histRes.data || []);
        } catch {
          setHistory([]);
        }
      } else {
        setAccounts([]);
        setFiles([]);
        setHistory([]);
      }
    } catch (err) {
      if (!silent) onToast((err as Error).message);
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    void loadAll();
    return () => clearSse();
  }, []);

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
    if (!sauDirInput.trim()) return;
    try {
      const res = await apiRequest<{ ok: boolean; sauDir: string }>('/api/sau/config', {
        method: 'POST',
        body: JSON.stringify({ sauDir: sauDirInput.trim() }),
      });
      setSauDirInput(res.sauDir);
      onToast(`已更新发布引擎目录: ${res.sauDir}`);
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
      setAccounts(
        (res.data || []).map((row) => ({
          id: row[0],
          type: row[1],
          filePath: row[2],
          name: row[3],
          status: row[4],
        }))
      );
      onToast('已完成发布账号 Cookie 状态检测');
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setValidating(false);
    }
  };

  const handleDeleteAccount = async (acc: SauAccount) => {
    try {
      await apiRequest(`/api/sau/accounts/${acc.id}`, { method: 'DELETE' });
      onToast(`已删除账号：${acc.name}`);
      await loadAll(true);
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  const handleUploadMaterial = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setUploading(true);
    try {
      for (const f of Array.from(fileList)) {
        const fd = new FormData();
        fd.append('file', f);
        const res = await fetch('/api/sau/upload', { method: 'POST', body: fd });
        const data = (await res.json().catch(() => ({}))) as { code?: number; msg?: string };
        if (!res.ok || data.code !== 200) {
          throw new Error(data.msg || `上传失败 (${res.status})`);
        }
      }
      onToast('视频素材上传成功');
      await loadAll(true);
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
      setSelectedFiles((prev) => prev.filter((p) => p !== file.file_path));
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
    }, 240000);

    es.onmessage = (evt) => {
      const raw = (evt.data || '').trim();
      if (!raw) return;
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
        setSseMsg('请使用对应平台 App 扫描二维码');
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

  const handleSubmitPublish = async () => {
    if (selectedAccounts.length === 0) {
      onToast('请至少选择一个发布账号');
      return;
    }
    if (selectedFiles.length === 0) {
      onToast('请至少选择一个已上传的视频素材');
      return;
    }
    if (!title.trim()) {
      onToast('请输入视频标题');
      return;
    }

    const tags = tagsText
      .split(/[,，\s#]+/)
      .map((s) => s.trim())
      .filter(Boolean);

    setPublishing(true);
    try {
      const res = await apiRequest<{ code: number; msg: string }>('/api/sau/post-video', {
        method: 'POST',
        body: JSON.stringify({
          type: platformType,
          title: title.trim(),
          tags,
          fileList: selectedFiles,
          accountList: selectedAccounts,
          enableTimer: enableTimer ? 1 : 0,
          videosPerDay,
          dailyTimes: [dailyTime || '10:00'],
          startDays,
          category: 0,
          isDraft,
          productLink: productLink.trim(),
          productTitle: productTitle.trim(),
        }),
      });
      onToast(res.msg || '视频发布任务已完成提交');
      await loadAll(true);
    } catch (err) {
      onToast((err as Error).message);
      await loadAll(true);
    } finally {
      setPublishing(false);
    }
  };

  const handleReuseHistory = (item: SauPublishRecord) => {
    setPlatformType(item.platform_type || 3);
    setSelectedAccounts(item.account_list || []);
    setSelectedFiles(item.file_list || []);
    setTitle(item.title || '');
    setTagsText((item.tags || []).join(', '));
    setEnableTimer(Boolean(item.enable_timer));
    setIsDraft(Boolean(item.is_draft));
    setSubTab('publish');
    onToast('已把历史任务参数回填到发布表单');
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

  const platformAccounts = accounts.filter((a) => a.type === platformType);

  const toggleAccount = (filePath: string) => {
    setSelectedAccounts((prev) =>
      prev.includes(filePath) ? prev.filter((item) => item !== filePath) : [...prev, filePath]
    );
  };

  const toggleFile = (filePath: string) => {
    setSelectedFiles((prev) =>
      prev.includes(filePath) ? prev.filter((item) => item !== filePath) : [...prev, filePath]
    );
  };

  return (
    <div>
      <div className="card" style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <ShieldCheck size={20} color={status?.running ? '#16a34a' : '#d97706'} />
          <div>
            <div style={{ fontWeight: 600 }}>
              视频一键发布引擎（SAU）
              <span className={`badge ${status?.running ? 'badge-green' : 'badge-amber'}`} style={{ marginLeft: 8 }}>
                {status?.running ? '运行中 (5409)' : '未启动'}
              </span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
              项目目录：{status?.sauDir || '自动检测中...'} · 账号 {accounts.length} 个 · 素材 {files.length} 条
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {status && !status.installed ? (
            <button className="btn btn-primary btn-sm" disabled={installing} onClick={() => void handleInstallEngine()}>
              {installing ? '正在拉取并安装...' : '一键安装发布引擎'}
            </button>
          ) : !status?.running ? (
            <button className="btn btn-primary btn-sm" disabled={engineBusy} onClick={() => void handleStartEngine()}>
              <Play size={13} /> {engineBusy ? '启动中...' : '启动发布引擎'}
            </button>
          ) : (
            <button className="btn btn-danger btn-sm" disabled={engineBusy} onClick={() => void handleStopEngine()}>
              <Square size={13} /> {engineBusy ? '停止中...' : '停止发布引擎'}
            </button>
          )}
          <button className="btn btn-sm" disabled={loading} onClick={() => void loadAll()}>
            <RefreshCw size={13} /> 刷新
          </button>
          <button className="btn btn-sm" disabled={validating || !status?.running} onClick={() => void handleValidateAccounts()}>
            {validating ? '检测中...' : '检测账号 Cookie'}
          </button>
          <a
            href={status?.frontendUrl || 'http://127.0.0.1:5173/'}
            target="_blank"
            rel="noreferrer"
            className="btn btn-sm"
          >
            <ExternalLink size={13} /> 打开新版发布台
          </a>
        </div>
      </div>

      {status && !status.installed && (
        <div className="card" style={{ marginBottom: 16, background: '#fffbeb', borderColor: '#fde68a' }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>新电脑首次使用提示：尚未检测到 SAU 发布引擎虚拟环境</div>
          <div style={{ fontSize: 13, color: '#78350f', marginBottom: 10 }}>
            点击下方「一键拉取并安装」会自动把配套的 social-auto-upload 克隆到指定目录并配好 Python 环境；如果你已经在别的目录放好了该项目，也可以直接填写路径后点「保存路径」。
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input
              className="input"
              value={sauDirInput}
              onChange={(e) => setSauDirInput(e.target.value)}
              placeholder="例如 D:\HeyGem\social-auto-upload 或 ..\social-auto-upload"
              style={{ flex: 1, minWidth: 260 }}
            />
            <button className="btn btn-sm" onClick={() => void handleSaveSauDir()}>保存路径</button>
            <button className="btn btn-primary btn-sm" disabled={installing} onClick={() => void handleInstallEngine()}>
              {installing ? '安装中（首次约1~2分钟）...' : '一键拉取并安装'}
            </button>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button
          className={`btn ${subTab === 'publish' ? 'btn-primary' : ''}`}
          onClick={() => setSubTab('publish')}
        >
          <Send size={14} /> 一键发布
        </button>
        <button
          className={`btn ${subTab === 'accounts' ? 'btn-primary' : ''}`}
          onClick={() => setSubTab('accounts')}
        >
          发布账号 ({accounts.length})
        </button>
        <button
          className={`btn ${subTab === 'materials' ? 'btn-primary' : ''}`}
          onClick={() => setSubTab('materials')}
        >
          视频素材 ({files.length})
        </button>
        <button
          className={`btn ${subTab === 'history' ? 'btn-primary' : ''}`}
          onClick={() => setSubTab('history')}
        >
          <Clock size={14} /> 发布历史 ({history.length})
        </button>
      </div>

      {subTab === 'publish' && (
        <div className="card" style={{ display: 'grid', gap: 16 }}>
          <div>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>1. 选择目标平台</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {PLATFORM_OPTIONS.map((p) => (
                <button
                  key={p.type}
                  className={`btn ${platformType === p.type ? 'btn-primary' : ''}`}
                  onClick={() => {
                    setPlatformType(p.type);
                    setSelectedAccounts([]);
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontWeight: 600 }}>2. 选择发布账号</span>
              <button
                className="btn btn-sm"
                onClick={() => {
                  setNewPlatform(platformType);
                  setShowAddModal(true);
                }}
              >
                <Plus size={13} /> 扫码添加账号
              </button>
            </div>
            {platformAccounts.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                当前平台还没有账号，请点击右侧“扫码添加账号”（如果发布引擎还没开，会自动拉起）。
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {platformAccounts.map((acc) => {
                  const checked = selectedAccounts.includes(acc.filePath);
                  return (
                    <button
                      key={acc.id}
                      className={`btn btn-sm ${checked ? 'btn-primary' : ''}`}
                      onClick={() => toggleAccount(acc.filePath)}
                    >
                      {acc.name}
                      <span className={`badge ${acc.status === 1 ? 'badge-green' : 'badge-red'}`} style={{ marginLeft: 4 }}>
                        {acc.status === 1 ? '正常' : '失效'}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontWeight: 600 }}>3. 选择视频素材</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="video/*"
                  multiple
                  style={{ display: 'none' }}
                  onChange={(e) => void handleUploadMaterial(e.target.files)}
                />
                <button className="btn btn-sm" disabled={uploading} onClick={() => fileInputRef.current?.click()}>
                  <Upload size={13} /> {uploading ? '上传中...' : '上传新视频'}
                </button>
              </div>
            </div>
            {files.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>还没有视频素材，请先点击右上角“上传新视频”。</div>
            ) : (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {files.map((f) => {
                  const checked = selectedFiles.includes(f.file_path);
                  return (
                    <button
                      key={f.id}
                      className={`btn btn-sm ${checked ? 'btn-primary' : ''}`}
                      onClick={() => toggleFile(f.file_path)}
                    >
                      {f.filename} ({f.filesize}MB)
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <label style={{ fontSize: 13, fontWeight: 600 }}>视频标题</label>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {TITLE_TEMPLATES.map((tpl) => (
                    <button
                      key={tpl.label}
                      type="button"
                      className="btn btn-sm"
                      style={{ padding: '2px 7px', fontSize: 11 }}
                      onClick={() => {
                        setTitle(tpl.title);
                        setTagsText(tpl.tags);
                      }}
                    >
                      {tpl.label}
                    </button>
                  ))}
                </div>
              </div>
              <input
                className="input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="输入视频标题"
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6 }}>话题标签（逗号或空格分隔）</label>
              <input
                className="input"
                value={tagsText}
                onChange={(e) => setTagsText(e.target.value)}
                placeholder="例如：AI工具, 效率神器"
              />
            </div>
          </div>

          <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
              <input type="checkbox" checked={enableTimer} onChange={(e) => setEnableTimer(e.target.checked)} />
              开启定时发布
            </label>
            {enableTimer && (
              <>
                <label style={{ fontSize: 13 }}>
                  每天条数：
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={5}
                    value={videosPerDay}
                    onChange={(e) => setVideosPerDay(Math.max(1, Number(e.target.value) || 1))}
                    style={{ width: 64, display: 'inline-block', marginLeft: 4 }}
                  />
                </label>
                <label style={{ fontSize: 13 }}>
                  发布时间：
                  <input
                    className="input"
                    value={dailyTime}
                    onChange={(e) => setDailyTime(e.target.value)}
                    placeholder="10:00"
                    style={{ width: 90, display: 'inline-block', marginLeft: 4 }}
                  />
                </label>
                <label style={{ fontSize: 13 }}>
                  延后天数：
                  <input
                    className="input"
                    type="number"
                    min={0}
                    value={startDays}
                    onChange={(e) => setStartDays(Math.max(0, Number(e.target.value) || 0))}
                    style={{ width: 64, display: 'inline-block', marginLeft: 4 }}
                  />
                </label>
              </>
            )}
            {platformType === 2 && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                <input type="checkbox" checked={isDraft} onChange={(e) => setIsDraft(e.target.checked)} />
                仅保存为视频号草稿
              </label>
            )}
          </div>

          {platformType === 3 && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6 }}>抖音商品链接（可选）</label>
                <input
                  className="input"
                  value={productLink}
                  onChange={(e) => setProductLink(e.target.value)}
                  placeholder="不挂车请留空"
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6 }}>商品短标题（可选）</label>
                <input
                  className="input"
                  value={productTitle}
                  onChange={(e) => setProductTitle(e.target.value)}
                  placeholder="不挂车请留空"
                />
              </div>
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button className="btn btn-primary" disabled={publishing} onClick={() => void handleSubmitPublish()}>
              <Send size={14} /> {publishing ? '正在执行发布，请勿关闭...' : '提交发布任务'}
            </button>
          </div>
        </div>
      )}

      {subTab === 'accounts' && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ fontWeight: 600 }}>已绑定的发布账号</div>
            <button className="btn btn-primary btn-sm" onClick={() => setShowAddModal(true)}>
              <Plus size={13} /> 扫码添加账号
            </button>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>账号名称</th>
                  <th>平台</th>
                  <th>状态</th>
                  <th>Cookie 文件</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {accounts.length === 0 ? (
                  <tr>
                    <td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                      暂无发布账号，点击右上角“扫码添加账号”即可绑定。
                    </td>
                  </tr>
                ) : (
                  accounts.map((acc) => {
                    const meta = getPlatformMeta(acc.type);
                    return (
                      <tr key={acc.id}>
                        <td>{acc.name}</td>
                        <td><span className={`badge ${meta.badge}`}>{meta.label}</span></td>
                        <td>
                          <span className={`badge ${acc.status === 1 ? 'badge-green' : 'badge-red'}`}>
                            {acc.status === 1 ? '正常' : '已失效'}
                          </span>
                        </td>
                        <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{acc.filePath}</td>
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
            <div>
              <input
                ref={fileInputRef}
                type="file"
                accept="video/*"
                multiple
                style={{ display: 'none' }}
                onChange={(e) => void handleUploadMaterial(e.target.files)}
              />
              <button className="btn btn-primary btn-sm" disabled={uploading} onClick={() => fileInputRef.current?.click()}>
                <Upload size={13} /> {uploading ? '上传中...' : '上传视频'}
              </button>
            </div>
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
                    <td colSpan={4} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                      暂无视频素材
                    </td>
                  </tr>
                ) : (
                  files.map((f) => (
                    <tr key={f.id}>
                      <td>{f.filename}</td>
                      <td>{f.filesize} MB</td>
                      <td>{f.upload_time}</td>
                      <td>
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
                    <td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                      暂无发布历史记录
                    </td>
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
                <div style={{ textAlign: 'center', padding: 12, background: '#f8fafc', borderRadius: 8 }}>
                  {qrSrc && sseState === 'qr' && (
                    <img src={qrSrc} alt="登录二维码" style={{ width: 180, height: 180, objectFit: 'contain', marginBottom: 8 }} />
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
