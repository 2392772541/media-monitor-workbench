import { useEffect, useState } from 'react';
import { ExternalLink, RefreshCw, XCircle, ShieldCheck } from 'lucide-react';
import { apiRequest, fmtTime } from '../api';
import type { BrowserProfile } from '../types';

function loginStatusLabel(s: string) {
  const map: Record<string, { text: string; cls: string }> = {
    logged_in: { text: '已登录', cls: 'badge badge-green' },
    optional: { text: '免登录可用', cls: 'badge badge-blue' },
    auth_required: { text: '需要登录', cls: 'badge badge-amber' },
    expired: { text: '登录已过期', cls: 'badge badge-red' },
    error: { text: '检测异常', cls: 'badge badge-red' },
    unknown: { text: '未检测', cls: 'badge badge-gray' },
  };
  return map[s] || { text: s, cls: 'badge badge-gray' };
}

export function BrowsersPage({ onToast }: { onToast: (msg: string) => void }) {
  const [profiles, setProfiles] = useState<BrowserProfile[]>([]);
  const [busyPlatform, setBusyPlatform] = useState<string | null>(null);

  const load = async () => {
    setProfiles(await apiRequest<BrowserProfile[]>('/api/browsers'));
  };

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, []);

  const openWindow = async (platform: string) => {
    setBusyPlatform(platform);
    try {
      const res = await apiRequest<{ started: boolean; message: string }>(`/api/browsers/${platform}/login-window`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      onToast(res.message);
      await load();
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setBusyPlatform(null);
    }
  };

  const closeWindow = async (platform: string) => {
    setBusyPlatform(platform);
    try {
      const res = await apiRequest<{ message: string }>(`/api/browsers/${platform}/close`, { method: 'POST' });
      onToast(res.message);
      await load();
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setBusyPlatform(null);
    }
  };

  const checkLogin = async (platform: string) => {
    setBusyPlatform(platform);
    try {
      const res = await apiRequest<{ message: string }>(`/api/browsers/${platform}/check-login`, { method: 'POST' });
      onToast(res.message);
      await load();
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setBusyPlatform(null);
    }
  };

  return (
    <div>
      <div className="card" style={{ marginBottom: 16, background: '#f0f9ff', borderColor: '#bae6fd' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <ShieldCheck size={20} color="#0284c7" />
          <div>
            <div style={{ fontWeight: 600, color: '#0369a1' }}>主浏览器完全隔离保护中</div>
            <div style={{ fontSize: 13, color: '#0c4a6e' }}>
              此处管理的是独立自动化专用 Chromium 配置目录，绝不读取、复制或控制你的日常 Google Chrome。扫码或人工验证请在下方打开对应平台的独立窗口，完成后关闭窗口即可持久化保留状态。
            </div>
          </div>
          </div>
          <button className="btn btn-sm" onClick={() => void load()}><RefreshCw size={13} /> 刷新</button>
        </div>
      </div>

      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>平台</th>
              <th>浏览器运行状态</th>
              <th>登录状态</th>
              <th>能力状态</th>
              <th>独立配置目录</th>
              <th>最近检查 / 使用</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {profiles.map((p) => {
              const st = loginStatusLabel(p.login_status);
              const isBusy = busyPlatform === p.platform;
              return (
                <tr key={p.platform}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{p.display_name}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{p.note}</div>
                  </td>
                  <td>
                    {p.is_running ? (
                      <span className="badge badge-green">运行中 ({p.running_mode})</span>
                    ) : (
                      <span className="badge badge-gray">空闲</span>
                    )}
                  </td>
                  <td>
                    <span className={st.cls}>{st.text}</span>
                    {p.needs_attention === 1 && <div style={{ fontSize: 11, color: 'var(--warn)', marginTop: 2 }}>需人工维护</div>}
                  </td>
                  <td><span className="badge badge-gray">{p.capability_status}</span></td>
                  <td style={{ fontSize: 11, color: 'var(--text-muted)', maxWidth: 240, wordBreak: 'break-all' }}>{p.profile_dir}</td>
                  <td style={{ fontSize: 12 }}>
                    <div>检：{fmtTime(p.last_checked_at)}</div>
                    <div style={{ color: 'var(--text-muted)' }}>用：{fmtTime(p.last_used_at)}</div>
                  </td>
                  <td>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      <button className="btn btn-sm btn-primary" disabled={isBusy} onClick={() => void openWindow(p.platform)}>
                        <ExternalLink size={12} /> 打开登录窗口
                      </button>
                      <button className="btn btn-sm" disabled={isBusy} onClick={() => void checkLogin(p.platform)}>
                        <RefreshCw size={12} /> 检查状态
                      </button>
                      {p.is_running && (
                        <button className="btn btn-sm btn-danger" disabled={isBusy} onClick={() => void closeWindow(p.platform)}>
                          <XCircle size={12} /> 关闭窗口
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
