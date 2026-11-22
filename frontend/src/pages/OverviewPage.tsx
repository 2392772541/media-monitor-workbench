import { useEffect, useState } from 'react';
import { Sparkles, Send, Plus, ArrowRight, AlertTriangle } from 'lucide-react';
import { apiRequest, fmtTime, PLATFORM_LABELS } from '../api';
import type { OverviewData } from '../types';

function capBadge(status: string) {
  if (status === '已接入并验证') return 'badge badge-green';
  if (status === '需要登录' || status === '需要授权') return 'badge badge-amber';
  if (status === '采集异常' || status === '暂时不可用') return 'badge badge-red';
  return 'badge badge-gray';
}

export function OverviewPage({
  onNavigate,
  onToast,
}: {
  onNavigate: (tab: string, keepToast?: boolean) => void;
  onToast: (msg: string) => void;
}) {
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [seeding, setSeeding] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      setData(await apiRequest<OverviewData>('/api/overview'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  // 一键导入公开示例源并触发首次采集
  const handleSeedExamples = async () => {
    setSeeding(true);
    try {
      const res = await apiRequest<{ ok: boolean; addedCount: number; message: string }>('/api/sources/seed-examples', {
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

  if (loading && !data) return <div className="card">正在加载监控总览...</div>;
  if (!data) return <div className="card">无法获取总览数据</div>;

  const s = data.stats;
  const pub = data.publishSummary;
  const hasSystemAlerts =
    Boolean(pub?.lastError) || (pub?.invalidAccounts || 0) > 0 || s.authAlertCount > 0 || data.recentFailures.length > 0;

  return (
    <div>
      {s.totalSources === 0 && (
        <div className="onboarding-banner">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 16, display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text)' }}>
                <Sparkles size={18} color="var(--primary)" />
                快速上手：3 步跑通「对标监控 → 爆款提炼 → 多平台矩阵发布」闭环
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 6 }}>
                1. 添加对标博主或资讯源自动追踪动态 → 2. 在「最新内容」按高赞/高播筛出爆款并一键存入标题库 → 3. 在「视频发布」勾选抖音/快手/小红书/视频号批量错峰分发。
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn btn-primary btn-sm" disabled={seeding} onClick={() => void handleSeedExamples()}>
                <Sparkles size={13} /> {seeding ? '正在导入示例源...' : '一键导入精选示例源（5秒体验）'}
              </button>
              <button className="btn btn-sm" onClick={() => onNavigate('sources')}>
                <Plus size={13} /> 手动添加对标源
              </button>
              <button className="btn btn-sm" onClick={() => onNavigate('publish')}>
                <Send size={13} /> 直接去批量发视频
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="grid-4">
        <div className="stat-card">
          <div className="stat-label">监控对象总数</div>
          <div className="stat-value">{s.totalSources}</div>
          <div className="stat-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
            <span>网站 {s.websiteCount} · 博主 {s.creatorCount}</span>
            <button className="btn btn-sm" style={{ padding: '3px 8px' }} onClick={() => onNavigate('sources')}>管理</button>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">今日新增内容 / 待查看</div>
          <div className="stat-value">{s.todayNew} <span style={{ fontSize: 15, fontWeight: 400, color: 'var(--text-muted)' }}>/ {s.unreadCount} 未读</span></div>
          <div className="stat-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
            <span>累计 {s.totalContents} 条 · 收藏 {s.favCount} 条</span>
            <button className="btn btn-sm" style={{ padding: '3px 8px' }} onClick={() => onNavigate('contents')}>看内容</button>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">采集成功 / 失败次数</div>
          <div className="stat-value">
            <span style={{ color: 'var(--success)' }}>{s.successCount}</span>
            <span style={{ fontSize: 16, margin: '0 6px', color: 'var(--text-muted)' }}>/</span>
            <span style={{ color: s.failedCount > 0 ? 'var(--danger)' : 'var(--text)' }}>{s.failedCount}</span>
          </div>
          <div className="stat-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
            <span>需关注登录：{s.authAlertCount} 个</span>
            <button className="btn btn-sm" style={{ padding: '3px 8px' }} onClick={() => onNavigate('browsers')}>浏览器管理</button>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">多平台视频发布矩阵</div>
          <div className="stat-value" style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span>{pub?.totalAccounts ?? 0}</span>
            <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-muted)' }}>个账号</span>
            <span className={`badge ${pub?.running ? 'badge-green' : 'badge-amber'}`} style={{ marginLeft: 'auto' }}>
              {pub?.running ? '引擎在线' : '待启动'}
            </span>
          </div>
          <div className="stat-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6, gap: 6 }}>
            <span style={{ whiteSpace: 'nowrap' }}>素材 {pub?.totalFiles ?? 0} · 模板 {pub?.totalTemplates ?? 0}</span>
            <button className="btn btn-primary btn-sm" style={{ padding: '3px 9px' }} onClick={() => onNavigate('publish')}>
              去发布 <ArrowRight size={12} />
            </button>
          </div>
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 8 }}>
            <h3 style={{ margin: 0, fontSize: 15 }}>平台接入能力与独立配置状态</h3>
            <button className="btn btn-sm" onClick={() => onNavigate('browsers')}>前往浏览器管理</button>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 110 }}>平台</th>
                  <th style={{ width: 110 }}>当前状态</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                {data.profiles.map((p) => (
                  <tr key={p.platform}>
                    <td><strong>{p.display_name}</strong></td>
                    <td><span className={capBadge(p.capability_status)}>{p.capability_status}</span></td>
                    <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>{p.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 8 }}>
            <h3 style={{ margin: 0, fontSize: 15 }}>最近异常与提醒</h3>
            <button className="btn btn-sm" onClick={() => void load()}>刷新</button>
          </div>

          {pub?.lastError && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 9, background: 'var(--danger-soft)', color: 'var(--danger)', fontSize: 13, marginBottom: 10 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <AlertTriangle size={15} /> {pub.lastError}
              </span>
              <button className="btn btn-sm" onClick={() => onNavigate('publish')}>前往恢复</button>
            </div>
          )}

          {(pub?.invalidAccounts || 0) > 0 && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 9, background: 'var(--warn-soft)', color: 'var(--warn)', fontSize: 13, marginBottom: 10 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <AlertTriangle size={15} /> 有 {pub?.invalidAccounts} 个视频发布账号 Cookie 待验证或已失效
              </span>
              <button className="btn btn-sm" onClick={() => onNavigate('publish:accounts')}>检查账号</button>
            </div>
          )}

          {!hasSystemAlerts ? (
            <div style={{ color: 'var(--text-muted)', padding: '24px 0', textAlign: 'center' }}>
              当前暂无采集失败、引擎异常或登录失效告警。
            </div>
          ) : data.recentFailures.length > 0 ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>监控对象</th>
                    <th>状态</th>
                    <th>原因</th>
                    <th>时间</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentFailures.map((f) => (
                    <tr key={f.id}>
                      <td>{f.source_name} ({PLATFORM_LABELS[f.platform] || f.platform})</td>
                      <td>
                        <span className={f.status === 'auth_required' ? 'badge badge-amber' : 'badge badge-red'}>
                          {f.status === 'auth_required' ? '需登录' : '失败'}
                        </span>
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{f.error_message || '未知错误'}</td>
                      <td style={{ fontSize: 12 }}>{fmtTime(f.finished_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
