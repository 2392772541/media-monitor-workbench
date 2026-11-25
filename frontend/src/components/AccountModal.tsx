import { useEffect, useState } from 'react';
import { Plus, Trash2, Check, Sliders, X } from 'lucide-react';
import { apiRequest } from '../api';
import type { CreatorAccount } from '../types';

interface AccountModalProps {
  open: boolean;
  accounts: CreatorAccount[];
  activeAccountId: number;
  onClose: () => void;
  onChanged: (newActiveId?: number) => void;
  onToast: (msg: string) => void;
}

const EMPTY_FORM = {
  name: '',
  platform_focus: '抖音 / B站 / YouTube',
  niche: '',
  target_audience: '',
  content_direction: '',
  personal_expertise: '',
  style_preferences: '',
  weight_match: 25,
  weight_heat: 25,
  weight_diff: 20,
  weight_experience: 15,
  weight_timeliness: 10,
  weight_feasibility: 5,
};

export function AccountModal({ open, accounts, activeAccountId, onClose, onChanged, onToast }: AccountModalProps) {
  const [selectedId, setSelectedId] = useState<number | 'new'>(activeAccountId);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    const acc = accounts.find((a) => a.id === activeAccountId) || accounts[0];
    if (acc) {
      setSelectedId(acc.id);
      setForm({
        name: acc.name,
        platform_focus: acc.platform_focus,
        niche: acc.niche,
        target_audience: acc.target_audience,
        content_direction: acc.content_direction,
        personal_expertise: acc.personal_expertise,
        style_preferences: acc.style_preferences,
        weight_match: acc.weight_match,
        weight_heat: acc.weight_heat,
        weight_diff: acc.weight_diff,
        weight_experience: acc.weight_experience,
        weight_timeliness: acc.weight_timeliness,
        weight_feasibility: acc.weight_feasibility,
      });
    }
  }, [open, activeAccountId, accounts]);

  if (!open) return null;

  const weightTotal =
    form.weight_match +
    form.weight_heat +
    form.weight_diff +
    form.weight_experience +
    form.weight_timeliness +
    form.weight_feasibility;

  const selectAccount = (acc: CreatorAccount) => {
    setSelectedId(acc.id);
    setForm({
      name: acc.name,
      platform_focus: acc.platform_focus,
      niche: acc.niche,
      target_audience: acc.target_audience,
      content_direction: acc.content_direction,
      personal_expertise: acc.personal_expertise,
      style_preferences: acc.style_preferences,
      weight_match: acc.weight_match,
      weight_heat: acc.weight_heat,
      weight_diff: acc.weight_diff,
      weight_experience: acc.weight_experience,
      weight_timeliness: acc.weight_timeliness,
      weight_feasibility: acc.weight_feasibility,
    });
  };

  const handleSave = async () => {
    if (!form.name.trim()) {
      onToast('请填写账号名称');
      return;
    }
    setSaving(true);
    try {
      if (selectedId === 'new') {
        const res = await apiRequest<{ account: CreatorAccount }>('/api/radar/accounts', {
          method: 'POST',
          body: JSON.stringify({ ...form, is_active: true }),
        });
        onToast(`已新建并切换到账号「${res.account.name}」`);
        onChanged(res.account.id);
        onClose();
      } else {
        const res = await apiRequest<{ account: CreatorAccount; recalculated: number }>(`/api/radar/accounts/${selectedId}`, {
          method: 'PATCH',
          body: JSON.stringify(form),
        });
        onToast(
          res.recalculated > 0
            ? `账号定位已更新，已按新权重秒级重算 ${res.recalculated} 条选题得分`
            : `已保存账号「${res.account.name}」定位配置`
        );
        onChanged(res.account.id);
      }
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    if (!window.confirm('确定删除这个账号定位配置吗？关联的历史推荐分也会一并清理。')) return;
    try {
      await apiRequest(`/api/radar/accounts/${id}`, { method: 'DELETE' });
      onToast('已删除账号定位');
      onChanged();
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  const weightFields: Array<{ key: keyof typeof EMPTY_FORM; label: string; hint: string }> = [
    { key: 'weight_match', label: '账号定位匹配度', hint: '默认 25%' },
    { key: 'weight_heat', label: '话题热度及增长', hint: '默认 25%' },
    { key: 'weight_diff', label: '差异化创作空间', hint: '默认 20%' },
    { key: 'weight_experience', label: '个人经验匹配度', hint: '默认 15%' },
    { key: 'weight_timeliness', label: '时效性', hint: '默认 10%' },
    { key: 'weight_feasibility', label: '创作可行性', hint: '默认 5%' },
  ];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head" style={{ borderBottom: '1px solid var(--border)', paddingBottom: 12 }}>
          <div className="panel-title">
            <Sliders size={18} color="#4f46e5" />
            <span>自媒体账号定位与 6 维评分权重配置</span>
          </div>
          <button className="btn btn-secondary" onClick={onClose} style={{ padding: '5px 9px' }}>
            <X size={15} />
          </button>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
          {accounts.map((acc) => (
            <button
              key={acc.id}
              className={`btn ${selectedId === acc.id ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => selectAccount(acc)}
              style={{ fontSize: 12.5, padding: '6px 12px' }}
            >
              {acc.is_active ? '★ ' : ''}
              {acc.name}
            </button>
          ))}
          <button
            className={`btn ${selectedId === 'new' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => {
              setSelectedId('new');
              setForm({ ...EMPTY_FORM });
            }}
            style={{ fontSize: 12.5, padding: '6px 12px' }}
          >
            <Plus size={14} /> 新建账号定位
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <label className="field-label">账号名称 *</label>
            <input
              className="input"
              placeholder="如：AI 实战产品经理 / 农资科普号"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div>
            <label className="field-label">主力发布平台</label>
            <input
              className="input"
              placeholder="如：抖音 / B站 / 视频号 / YouTube"
              value={form.platform_focus}
              onChange={(e) => setForm({ ...form, platform_focus: e.target.value })}
            />
          </div>
          <div>
            <label className="field-label">垂直领域 / 核心赛道</label>
            <input
              className="input"
              placeholder="如：AI工具提效、作物营养农技、短视频方法论"
              value={form.niche}
              onChange={(e) => setForm({ ...form, niche: e.target.value })}
            />
          </div>
          <div>
            <label className="field-label">目标受众画像</label>
            <input
              className="input"
              placeholder="如：种植大户与农资经销商 / 25-35岁职场效率控"
              value={form.target_audience}
              onChange={(e) => setForm({ ...form, target_audience: e.target.value })}
            />
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label className="field-label">内容方向与选题偏好</label>
            <textarea
              className="input"
              rows={2}
              placeholder="你希望多做哪类内容？不想碰哪类内容？"
              value={form.content_direction}
              onChange={(e) => setForm({ ...form, content_direction: e.target.value })}
            />
          </div>
          <div>
            <label className="field-label">个人专业领域与实战背景</label>
            <textarea
              className="input"
              rows={2}
              placeholder="用于计算“个人经验匹配度”，写清你真实懂什么、拍过什么"
              value={form.personal_expertise}
              onChange={(e) => setForm({ ...form, personal_expertise: e.target.value })}
            />
          </div>
          <div>
            <label className="field-label">表达风格与避雷要求</label>
            <textarea
              className="input"
              rows={2}
              placeholder="如：短平快大白话、只讲实战干货、不做纯新闻搬运"
              value={form.style_preferences}
              onChange={(e) => setForm({ ...form, style_preferences: e.target.value })}
            />
          </div>
        </div>

        <div style={{ marginTop: 16, padding: 14, background: 'var(--surface-muted)', borderRadius: 12, border: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <span style={{ fontWeight: 700, fontSize: 13.5 }}>6 维综合推荐权重（拖动保存即刻重算总分，自动归一化）</span>
            <span className="metric-chip" style={{ fontWeight: 700 }}>
              权重合计：{weightTotal}
            </span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
            {weightFields.map((wf) => {
              const val = Number(form[wf.key]);
              const pct = weightTotal > 0 ? Math.round((val / weightTotal) * 100) : 0;
              return (
                <div key={wf.key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5 }}>
                    <span>
                      <strong>{wf.label}</strong> <span style={{ color: 'var(--text-muted)' }}>({wf.hint})</span>
                    </span>
                    <span style={{ color: 'var(--primary)', fontWeight: 700 }}>
                      {val} ({pct}%)
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={50}
                    value={val}
                    onChange={(e) => setForm({ ...form, [wf.key]: Number(e.target.value) })}
                  />
                </div>
              );
            })}
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 18 }}>
          <div>
            {selectedId !== 'new' && accounts.length > 1 && (
              <button className="btn btn-danger" onClick={() => handleDelete(selectedId)}>
                <Trash2 size={14} /> 删除此账号
              </button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-secondary" onClick={onClose}>
              取消
            </button>
            <button className="btn btn-primary" disabled={saving} onClick={handleSave}>
              <Check size={15} /> {saving ? '保存中...' : selectedId === 'new' ? '创建并启用' : '保存并重算权重'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
