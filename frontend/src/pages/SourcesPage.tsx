import { useEffect, useState } from 'react';
import { Play, Pause, Trash2, Plus, RefreshCw, Search, Pencil, Sparkles } from 'lucide-react';
import { apiRequest, fmtTime, PLATFORM_LABELS } from '../api';
import type { Category, SourceItem } from '../types';

export function SourcesPage({
  onToast,
}: {
  onToast: (msg: string) => void;
  onNavigate?: (tab: string) => void;
}) {
  const [sources, setSources] = useState<SourceItem[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [defaultIntervals, setDefaultIntervals] = useState<{ website: number; creator: number }>({ website: 60, creator: 120 });
  const [filterKind, setFilterKind] = useState<'all' | 'website' | 'creator'>('all');
  const [showAdd, setShowAdd] = useState(false);
  const [newCatName, setNewCatName] = useState('');
  const [seeding, setSeeding] = useState(false);
  const [editing, setEditing] = useState<SourceItem | null>(null);
  const [editName, setEditName] = useState('');
  const [editUrl, setEditUrl] = useState('');
  const [editCatId, setEditCatId] = useState('');
  const [editPriority, setEditPriority] = useState(2);
  const [editNotes, setEditNotes] = useState('');

  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [platform, setPlatform] = useState('website');
  const [categoryId, setCategoryId] = useState<string>('');
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const [notes, setNotes] = useState('');
  const [probeMsg, setProbeMsg] = useState('');
  const [probing, setProbing] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const load = async () => {
    const [s, c, st] = await Promise.all([
      apiRequest<SourceItem[]>('/api/sources'),
      apiRequest<Category[]>('/api/categories'),
      apiRequest<{ settings: Record<string, string> }>('/api/settings').catch(() => ({ settings: {} as Record<string, string> })),
    ]);
    setSources(s);
    setCategories(c);
    const webMins = Number(st.settings?.default_website_interval) > 0 ? Number(st.settings.default_website_interval) : 60;
    const creatorMins = Number(st.settings?.default_creator_interval) > 0 ? Number(st.settings.default_creator_interval) : 120;
    setDefaultIntervals({ website: webMins, creator: creatorMins });
  };

  useEffect(() => {
    void load();
  }, []);

  const handleOpenAddModal = () => {
    setIntervalMinutes(defaultIntervals.website);
    setProbeMsg('');
    setShowAdd(true);
  };

  const handleProbe = async () => {
    if (!url.trim()) {
      onToast('请先填写主页或网站链接');
      setProbeMsg('请先粘贴需要检测的主页或订阅链接');
      return;
    }
    setProbing(true);
    setProbeMsg('');
    try {
      const res = await apiRequest<{
        recognized: { platform: string; normalizedUrl: string };
        availability: { available: boolean; detectedTitle?: string; message: string; capabilityStatus: string };
      }>('/api/sources/probe', {
        method: 'POST',
        body: JSON.stringify({ url }),
      });
      setPlatform(res.recognized.platform);
      setUrl(res.recognized.normalizedUrl);
      if (!name.trim() && res.availability.detectedTitle) {
        setName(res.availability.detectedTitle);
      }
      const isWeb = res.recognized.platform === 'website' || res.recognized.platform === 'rss';
      setIntervalMinutes(isWeb ? defaultIntervals.website : defaultIntervals.creator);
      const xhsNote =
        url.includes('xiaohongshu.com') || url.includes('xhslink.com')
          ? '（提示：小红书监控走公开动态网页提取；小红书账号发布已在「视频发布」完整支持）'
          : '';
      setProbeMsg(`识别平台: ${PLATFORM_LABELS[res.recognized.platform] || res.recognized.platform} ｜ ${res.availability.message}${xhsNote}`);
    } catch (err) {
      setProbeMsg(`检测失败: ${(err as Error).message}`);
    } finally {
      setProbing(false);
    }
  };

  const handleAddSource = async () => {
    if (!url.trim()) {
      onToast('请填写主页或网站链接');
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiRequest<{
        source: SourceItem;
        probe: { message: string };
      }>('/api/sources', {
        method: 'POST',
        body: JSON.stringify({
          url,
          name: name.trim() || undefined,
          platform,
          category_id: categoryId ? Number(categoryId) : null,
          interval_minutes: intervalMinutes,
          notes,
          check_immediately: true,
        }),
      });
      onToast(`已添加「${res.source.name}」，并已加入立即检查队列`);
      setShowAdd(false);
      setUrl('');
      setName('');
      setPlatform('website');
      setCategoryId('');
      setIntervalMinutes(60);
      setNotes('');
      setProbeMsg('');
      await load();
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleAddCategory = async () => {
    if (!newCatName.trim()) {
      onToast('请输入新分类名称');
      return;
    }
    const res = await apiRequest<{ created: boolean }>('/api/categories', {
      method: 'POST',
      body: JSON.stringify({ name: newCatName.trim() }),
    });
    setNewCatName('');
    onToast(res.created ? '分类已添加' : '该分类已存在');
    await load();
  };

  const handleSeedExamples = async () => {
    setSeeding(true);
    try {
      const res = await apiRequest<{ message: string }>('/api/sources/seed-examples', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      onToast(res.message);
      await load();
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setSeeding(false);
    }
  };

  const handleToggleStatus = async (s: SourceItem) => {
    const next = s.status === 'active' ? 'paused' : 'active';
    await apiRequest(`/api/sources/${s.id}`, { method: 'PATCH', body: JSON.stringify({ status: next }) });
    onToast(next === 'active' ? `已恢复监控「${s.name}」` : `已暂停监控「${s.name}」`);
    await load();
  };

  const handleChangeInterval = async (s: SourceItem, mins: number) => {
    await apiRequest(`/api/sources/${s.id}`, { method: 'PATCH', body: JSON.stringify({ interval_minutes: mins }) });
    onToast(`已更新「${s.name}」采集频率为每 ${mins} 分钟`);
    await load();
  };

  const handleCheckNow = async (s: SourceItem) => {
    const res = await apiRequest<{ queued: boolean; reason?: string }>(`/api/sources/${s.id}/check`, { method: 'POST' });
    onToast(res.queued ? `已启动「${s.name}」立即采集` : res.reason || '已在队列中');
  };

  const handleDelete = async (s: SourceItem) => {
    if (!window.confirm(`确定删除监控对象「${s.name}」及其全部历史内容吗？`)) return;
    await apiRequest(`/api/sources/${s.id}`, { method: 'DELETE' });
    onToast(`已删除「${s.name}」`);
    await load();
  };

  const openEdit = (s: SourceItem) => {
    setEditing(s);
    setEditName(s.name);
    setEditUrl(s.url);
    setEditCatId(s.category_id ? String(s.category_id) : '');
    setEditPriority(s.priority || 2);
    setEditNotes(s.notes || '');
  };

  const handleSaveEdit = async () => {
    if (!editing) return;
    await apiRequest(`/api/sources/${editing.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        name: editName.trim() || editing.name,
        url: editUrl.trim() || editing.url,
        category_id: editCatId ? Number(editCatId) : null,
        priority: editPriority,
        notes: editNotes,
      }),
    });
    onToast(`已更新「${editName.trim() || editing.name}」`);
    setEditing(null);
    await load();
  };

  // 过滤与空值占位重复的「默认分类」，避免下拉框出现两次默认分类
  const selectableCategories = categories.filter((c) => c.name !== '默认分类');

  const filtered = sources.filter((s) => {
    if (filterKind === 'website') return s.platform === 'website' || s.platform === 'rss';
    if (filterKind === 'creator') return s.platform !== 'website' && s.platform !== 'rss';
    return true;
  });

  return (
    <div>
      <div className="toolbar" style={{ justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className={`btn ${filterKind === 'all' ? 'btn-primary' : ''}`} onClick={() => setFilterKind('all')}>
            全部 ({sources.length})
          </button>
          <button className={`btn ${filterKind === 'website' ? 'btn-primary' : ''}`} onClick={() => setFilterKind('website')}>
            网站与订阅 ({sources.filter((s) => s.platform === 'website' || s.platform === 'rss').length})
          </button>
          <button className={`btn ${filterKind === 'creator' ? 'btn-primary' : ''}`} onClick={() => setFilterKind('creator')}>
            自媒体博主 ({sources.filter((s) => s.platform !== 'website' && s.platform !== 'rss').length})
          </button>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            className="input"
            style={{ width: 140 }}
            placeholder="新分类名称"
            value={newCatName}
            onChange={(e) => setNewCatName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void handleAddCategory()}
          />
          <button className="btn" onClick={() => void handleAddCategory()}>新建分类</button>
          <button className="btn btn-primary" data-testid="btn-open-add-source" onClick={handleOpenAddModal}>
            <Plus size={15} /> 添加监控对象
          </button>
        </div>
      </div>

      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>名称 / 链接</th>
              <th>平台</th>
              <th>分类</th>
              <th>频率</th>
              <th>能力 / 状态</th>
              <th>已采内容</th>
              <th>最近检查</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={8} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 32 }}>
                  <div>暂无监控对象，请点击右上角「添加监控对象」开始，或一键导入公开示例源快速体验。</div>
                  {sources.length === 0 && (
                    <button
                      className="btn btn-sm"
                      style={{ marginTop: 12 }}
                      disabled={seeding}
                      onClick={() => void handleSeedExamples()}
                    >
                      <Sparkles size={13} /> {seeding ? '正在导入...' : '一键导入精选示例订阅源'}
                    </button>
                  )}
                </td>
              </tr>
            ) : (
              filtered.map((s) => (
                <tr key={s.id}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{s.name}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <a href={s.url} target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>{s.url}</a>
                    </div>
                    {s.last_error && <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 2 }}>{s.last_error}</div>}
                  </td>
                  <td><span className="badge badge-blue">{PLATFORM_LABELS[s.platform] || s.platform}</span></td>
                  <td>{s.category_name || '默认分类'}</td>
                  <td>
                    <select
                      className="select"
                      style={{ width: 100, padding: '4px 6px' }}
                      value={s.interval_minutes}
                      onChange={(e) => void handleChangeInterval(s, Number(e.target.value))}
                    >
                      <option value={30}>30 分钟</option>
                      <option value={60}>60 分钟</option>
                      <option value={120}>2 小时</option>
                      <option value={180}>3 小时</option>
                      <option value={360}>6 小时</option>
                      <option value={1440}>24 小时</option>
                    </select>
                  </td>
                  <td>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <span className={s.status === 'active' ? 'badge badge-green' : 'badge badge-gray'}>
                        {s.status === 'active' ? '监控中' : '已暂停'}
                      </span>
                      <span className="badge badge-gray" style={{ fontSize: 11 }}>{s.capability_status}</span>
                    </div>
                  </td>
                  <td>{s.content_count ?? 0} 条</td>
                  <td style={{ fontSize: 12 }}>{fmtTime(s.last_checked_at)}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="btn btn-sm btn-primary" title="立即检查" onClick={() => void handleCheckNow(s)}>
                        <RefreshCw size={13} /> 立即检查
                      </button>
                      <button className="btn btn-sm" title="编辑" data-testid={`btn-edit-source-${s.id}`} onClick={() => openEdit(s)}>
                        <Pencil size={13} />
                      </button>
                      <button className="btn btn-sm" title={s.status === 'active' ? '暂停' : '恢复'} onClick={() => void handleToggleStatus(s)}>
                        {s.status === 'active' ? <Pause size={13} /> : <Play size={13} />}
                      </button>
                      <button className="btn btn-sm btn-danger" title="删除" onClick={() => void handleDelete(s)}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {showAdd && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <div className="modal-header">
              <strong>添加监控对象</strong>
              <button className="btn btn-sm" onClick={() => setShowAdd(false)}>关闭</button>
            </div>
            <div className="modal-body">
              <div className="form-row">
                <label className="form-label">主页或网站链接 *</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    className="input"
                    data-testid="input-source-url"
                    placeholder="粘贴网站地址、RSS 地址或抖音/快手/X/YouTube 博主主页"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                  />
                  <button className="btn" type="button" onClick={() => void handleProbe()} disabled={probing}>
                    <Search size={14} /> {probing ? '检测中...' : '自动识别与检测'}
                  </button>
                </div>
                {probeMsg && <div style={{ marginTop: 6, fontSize: 12, color: 'var(--primary)' }}>{probeMsg}</div>}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div className="form-row">
                  <label className="form-label">名称（留空则自动识别）</label>
                  <input
                    className="input"
                    data-testid="input-source-name"
                    placeholder="例如：阮一峰博客 / 某科技博主"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>
                <div className="form-row">
                  <label className="form-label">所属平台</label>
                  <select className="select" value={platform} onChange={(e) => setPlatform(e.target.value)}>
                    <option value="website">普通网站 / 博客</option>
                    <option value="rss">RSS / Atom 订阅</option>
                    <option value="douyin">抖音博主</option>
                    <option value="kuaishou">快手博主</option>
                    <option value="wechat-channels">微信视频号</option>
                    <option value="x">X (Twitter)</option>
                    <option value="youtube">YouTube 创作者</option>
                  </select>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div className="form-row">
                  <label className="form-label">分类</label>
                  <select className="select" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                    <option value="">默认分类</option>
                    {selectableCategories.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </div>
                <div className="form-row">
                  <label className="form-label">监控频率</label>
                  <select className="select" value={intervalMinutes} onChange={(e) => setIntervalMinutes(Number(e.target.value))}>
                    {![30, 60, 120, 180, 360, 1440].includes(intervalMinutes) && (
                      <option value={intervalMinutes}>每 {intervalMinutes} 分钟（系统默认）</option>
                    )}
                    <option value={30}>每 30 分钟</option>
                    <option value={60}>每 60 分钟</option>
                    <option value={120}>每 2 小时</option>
                    <option value={180}>每 3 小时</option>
                    <option value={360}>每 6 小时</option>
                    <option value={1440}>每 24 小时</option>
                  </select>
                </div>
              </div>

              <div className="form-row">
                <label className="form-label">备注</label>
                <input className="input" placeholder="可选备注说明" value={notes} onChange={(e) => setNotes(e.target.value)} />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => setShowAdd(false)}>取消</button>
              <button className="btn btn-primary" data-testid="btn-save-source" onClick={() => void handleAddSource()} disabled={submitting}>
                {submitting ? '正在检测并保存...' : '保存并立即检查'}
              </button>
            </div>
          </div>
        </div>
      )}

      {editing && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <div className="modal-header">
              <strong>编辑监控对象</strong>
              <button className="btn btn-sm" onClick={() => setEditing(null)}>关闭</button>
            </div>
            <div className="modal-body">
              <div className="form-row">
                <label className="form-label">名称</label>
                <input className="input" data-testid="input-edit-name" value={editName} onChange={(e) => setEditName(e.target.value)} />
              </div>
              <div className="form-row">
                <label className="form-label">主页链接</label>
                <input className="input" value={editUrl} onChange={(e) => setEditUrl(e.target.value)} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div className="form-row">
                  <label className="form-label">分类</label>
                  <select className="select" value={editCatId} onChange={(e) => setEditCatId(e.target.value)}>
                    <option value="">默认分类</option>
                    {selectableCategories.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </div>
                <div className="form-row">
                  <label className="form-label">优先级</label>
                  <select className="select" value={editPriority} onChange={(e) => setEditPriority(Number(e.target.value))}>
                    <option value={1}>高优先级 (1)</option>
                    <option value={2}>普通 (2)</option>
                    <option value={3}>低优先级 (3)</option>
                  </select>
                </div>
              </div>
              <div className="form-row">
                <label className="form-label">备注</label>
                <input className="input" value={editNotes} onChange={(e) => setEditNotes(e.target.value)} />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => setEditing(null)}>取消</button>
              <button className="btn btn-primary" data-testid="btn-save-edit" onClick={() => void handleSaveEdit()}>保存修改</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
