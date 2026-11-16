import { useEffect, useState } from 'react';
import { Save, Database } from 'lucide-react';
import { apiRequest } from '../api';

interface SettingsPayload {
  settings: Record<string, string>;
  paths: {
    dataDir: string;
    dbFile: string;
    profilesRoot: string;
    logsDir: string;
    backupsDir: string;
  };
  recentLogs: string[];
}

export function SettingsPage({ onToast }: { onToast: (msg: string) => void }) {
  const [data, setData] = useState<SettingsPayload | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});

  const load = async () => {
    const res = await apiRequest<SettingsPayload>('/api/settings');
    setData(res);
    setForm(res.settings);
  };

  useEffect(() => {
    void load();
  }, []);

  const handleSave = async () => {
    await apiRequest('/api/settings', { method: 'PATCH', body: JSON.stringify(form) });
    onToast('系统设置已保存');
    await load();
  };

  const handleBackup = async () => {
    const res = await apiRequest<{ backupPath: string; sizeBytes: number }>('/api/backup', { method: 'POST' });
    onToast(`数据库备份完成：${res.backupPath} (${Math.round(res.sizeBytes / 1024)} KB)`);
  };

  if (!data) return <div className="card">加载系统设置中...</div>;

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div className="card">
        <h3 style={{ margin: '0 0 14px', fontSize: 15 }}>采集与调度设置</h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <div className="form-row">
            <label className="form-label">网站默认采集频率（分钟）</label>
            <input
              className="input"
              type="number"
              value={form.default_website_interval || '60'}
              onChange={(e) => setForm({ ...form, default_website_interval: e.target.value })}
            />
          </div>
          <div className="form-row">
            <label className="form-label">自媒体博主默认采集频率（分钟）</label>
            <input
              className="input"
              type="number"
              value={form.default_creator_interval || '120'}
              onChange={(e) => setForm({ ...form, default_creator_interval: e.target.value })}
            />
          </div>
          <div className="form-row">
            <label className="form-label">自动化浏览器运行模式</label>
            <select
              className="select"
              value={form.browser_mode || 'headless'}
              onChange={(e) => setForm({ ...form, browser_mode: e.target.value })}
            >
              <option value="headless">无界面静默后台模式（推荐，不打扰日常办公）</option>
              <option value="headed">可见窗口模式（调试或特殊平台观察）</option>
            </select>
          </div>
          <div className="form-row">
            <label className="form-label">后台自动定时调度</label>
            <select
              className="select"
              value={form.scheduler_enabled || 'true'}
              onChange={(e) => setForm({ ...form, scheduler_enabled: e.target.value })}
            >
              <option value="true">开启定时自动采集</option>
              <option value="false">暂停全部自动调度（仅手动检查）</option>
            </select>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn btn-primary" onClick={() => void handleSave()}>
            <Save size={14} /> 保存设置
          </button>
          <button className="btn" onClick={() => void handleBackup()}>
            <Database size={14} /> 立即备份本地数据库
          </button>
        </div>
      </div>

      <div className="card">
        <h3 style={{ margin: '0 0 12px', fontSize: 15 }}>本地存储路径与 Windows 开机启动</h3>
        <div className="table-wrap">
          <table>
            <tbody>
              <tr><td style={{ width: 180 }}><strong>SQLite 数据库</strong></td><td>{data.paths.dbFile}</td></tr>
              <tr><td><strong>独立浏览器配置根目录</strong></td><td>{data.paths.profilesRoot}</td></tr>
              <tr><td><strong>数据库备份目录</strong></td><td>{data.paths.backupsDir}</td></tr>
              <tr><td><strong>运行日志目录</strong></td><td>{data.paths.logsDir}</td></tr>
              <tr><td><strong>Windows 开机自启脚本</strong></td><td>scripts\register-autostart.ps1（使用 Windows 任务计划程序，支持睡眠唤醒补查）</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>今日系统运行日志（最新 100 行）</h3>
          <button className="btn btn-sm" onClick={() => void load()}>刷新日志</button>
        </div>
        <div style={{ background: '#0f172a', color: '#cbd5e1', padding: 14, borderRadius: 8, maxHeight: 300, overflowY: 'auto', fontFamily: 'Consolas, monospace', fontSize: 12 }}>
          {data.recentLogs.length === 0 ? '今日暂无日志' : data.recentLogs.map((l, idx) => <div key={idx}>{l}</div>)}
        </div>
      </div>
    </div>
  );
}
