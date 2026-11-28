import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, RefreshCw, XCircle, ShieldCheck, Copy, Send, Cpu, MessageSquareText, ArrowRight } from 'lucide-react';
import { apiRequest, fmtTime } from '../api';
import type { BrowserProfile, IntegrationsStatus } from '../types';

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

const PRIORITY_PLATFORMS = ['douyin', 'bilibili', 'xiaohongshu', 'kuaishou', 'youtube', 'x', 'rss'];
const PUBLISH_SYNC_PLATFORMS = new Set(['douyin', 'kuaishou', 'wechat-channels']);

export function BrowsersPage({
  onToast,
  onNavigate,
}: {
  onToast: (msg: string) => void;
  onNavigate?: (tab: string) => void;
}) {
  const [profiles, setProfiles] = useState<BrowserProfile[]>([]);
  const [integrations, setIntegrations] = useState<IntegrationsStatus | null>(null);
  const [busyPlatform, setBusyPlatform] = useState<string | null>(null);

  const load = async () => {
    const [p, integ] = await Promise.all([
      apiRequest<BrowserProfile[]>('/api/browsers'),
      apiRequest<IntegrationsStatus>('/api/radar/integrations').catch(() => null),
    ]);
    setProfiles(p);
    if (integ) setIntegrations(integ);
  };

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, []);

  const sortedProfiles = useMemo(() => {
    return [...profiles].sort((a, b) => {
      const ia = PRIORITY_PLATFORMS.indexOf(a.platform);
      const ib = PRIORITY_PLATFORMS.indexOf(b.platform);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
  }, [profiles]);

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

  const syncFromPublish = async (platform: string) => {
    setBusyPlatform(platform);
    try {
      const res = await apiRequest<{ ok: boolean; message: string }>(`/api/browsers/${platform}/sync-from-publish`, {
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

  return (
    <div>
      {/* 极简人话说明条 */}
      <div className="card" style={{ marginBottom: 16, background: '#f0f9ff', borderColor: '#bae6fd' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flex: '1 1 440px' }}>
            <ShieldCheck size={20} color="#0284c7" style={{ marginTop: 2, flexShrink: 0 }} />
            <div>
              <div style={{ fontWeight: 700, color: '#0369a1' }}>已打通登录态自动复用：在「视频发布」登过的抖音/快手会自动同步保存到这里</div>
              <div style={{ fontSize: 13, color: '#0c4a6e', marginTop: 3 }}>
                抖音未登录时平台会隐藏最近 7 天新视频；只要你在「视频发布」里扫过码，后台抓对标博主时会自动复用并保存登录态（无需重复扫码）。
                B站扫一次码可避免限流漏抓，全程与你日常 Chrome 完全隔离。
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {onNavigate && (
              <button className="btn btn-primary btn-sm" onClick={() => onNavigate('publish:accounts')}>
                <Send size={13} /> 去管视频发布账号
              </button>
            )}
            <button className="btn btn-sm" onClick={() => void load()}>
              <RefreshCw size={13} /> 刷新状态
            </button>
          </div>
        </div>
      </div>

      {/* 本机显卡离线转写 + 评论采集快捷入口（彻底去掉容易过期的通义听悟登录） */}
      {integrations && (
        <div className="grid-2" style={{ marginBottom: 16 }}>
          <div className="panel-card" style={{ marginBottom: 0 }}>
            <div className="panel-head">
              <div className="panel-title">
                <Cpu size={16} color="#16a34a" />
                <span>本机显卡语音转写（免登录 · 免费无限转）</span>
              </div>
              <span className={`badge ${integrations.tingwu.installed ? 'badge-green' : 'badge-amber'}`}>
                {integrations.tingwu.installed
                  ? integrations.tingwu.gpuReady
                    ? 'RTX 显卡加速就绪'
                    : 'CPU 模式就绪'
                  : '待检查环境'}
              </span>
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6 }}>
              已彻底替换掉容易掉线的通义听悟网页版，改用开源本地引擎 <strong>faster-whisper ({integrations.tingwu.model || 'medium'})</strong>。
              在任意视频右侧抽屉点「本机显卡转口播稿」，约 10~25 秒自动出带标点逐字稿，永不掉登录。
              {integrations.tingwu.running && (
                <div style={{ color: '#4f46e5', fontWeight: 600, marginTop: 6 }}>正在转写：{integrations.tingwu.currentJob}</div>
              )}
            </div>
          </div>

          <div className="panel-card" style={{ marginBottom: 0 }}>
            <div className="panel-head">
              <div className="panel-title">
                <MessageSquareText size={16} color="#ea580c" />
                <span>评论采集工作台（单端口 18910 内置）</span>
              </div>
              <span className={`badge ${integrations.mediaCrawler.installed ? 'badge-green' : 'badge-red'}`}>
                {integrations.mediaCrawler.installed ? '引擎已就绪' : '未检测到内核'}
              </span>
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 10 }}>
              无需再打开 8089 独立界面。直接去左侧「评论采集」页面，支持贴单条链接、搜关键词、抓博主评论，并一键用 AI 提炼观众高频痛点。
              {integrations.mediaCrawler.running && (
                <div style={{ color: '#ea580c', fontWeight: 600, marginTop: 4 }}>运行中：{integrations.mediaCrawler.currentTask}</div>
              )}
            </div>
            {onNavigate && (
              <button className="btn btn-primary btn-sm" onClick={() => onNavigate('comments')}>
                打开「评论采集」工作台 <ArrowRight size={13} />
              </button>
            )}
          </div>
        </div>
      )}

      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th style={{ minWidth: 150 }}>采集平台</th>
              <th style={{ whiteSpace: 'nowrap' }}>窗口状态</th>
              <th style={{ whiteSpace: 'nowrap' }}>登录状态</th>
              <th>独立配置目录（点击复制）</th>
              <th style={{ whiteSpace: 'nowrap' }}>最近检查 / 使用</th>
              <th style={{ whiteSpace: 'nowrap' }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {sortedProfiles.map((p) => {
              const st = loginStatusLabel(p.login_status);
              const isBusy = busyPlatform === p.platform;
              const isOptional = p.login_status === 'optional';
              return (
                <tr key={p.platform}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{p.display_name}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{p.note}</div>
                  </td>
                  <td>
                    {p.is_running ? (
                      <span className="badge badge-green">运行中</span>
                    ) : (
                      <span className="badge badge-gray">空闲</span>
                    )}
                  </td>
                  <td>
                    <span className={st.cls}>{st.text}</span>
                    {p.needs_attention === 1 && <div style={{ fontSize: 11, color: 'var(--warn)', marginTop: 2 }}>建议重新扫码</div>}
                  </td>
                  <td>
                    <span
                      className="path-ellipsis"
                      title={`点击复制完整路径：${p.profile_dir}`}
                      onClick={() => {
                        void navigator.clipboard?.writeText(p.profile_dir);
                        onToast('已复制独立配置目录路径');
                      }}
                    >
                      <Copy size={11} style={{ marginRight: 4, verticalAlign: '-1px' }} />
                      {p.profile_dir}
                    </span>
                  </td>
                  <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                    <div>检：{fmtTime(p.last_checked_at)}</div>
                    <div style={{ color: 'var(--text-muted)' }}>用：{fmtTime(p.last_used_at)}</div>
                  </td>
                  <td>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {PUBLISH_SYNC_PLATFORMS.has(p.platform) && (
                        <button
                          className="btn btn-sm"
                          style={{ background: '#f0fdf4', color: '#15803d', borderColor: '#bbf7d0' }}
                          disabled={isBusy}
                          title="直接把「视频发布」里已扫码的登录状态同步保存过来"
                          onClick={() => void syncFromPublish(p.platform)}
                        >
                          <Send size={12} /> 同步发布登录态
                        </button>
                      )}
                      <button
                        className={`btn btn-sm ${isOptional ? '' : 'btn-primary'}`}
                        disabled={isBusy}
                        onClick={() => void openWindow(p.platform)}
                      >
                        <ExternalLink size={12} /> {isOptional ? '打开浏览器' : '打开登录窗口'}
                      </button>
                      <button className="btn btn-sm" disabled={isBusy} onClick={() => void checkLogin(p.platform)}>
                        <RefreshCw size={12} /> 检测
                      </button>
                      {p.is_running && (
                        <button className="btn btn-sm btn-danger" disabled={isBusy} onClick={() => void closeWindow(p.platform)}>
                          <XCircle size={12} /> 关闭
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
