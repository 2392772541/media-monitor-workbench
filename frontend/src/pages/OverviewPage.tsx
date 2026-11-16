import { useEffect, useState } from 'react';
import { apiRequest, fmtTime, PLATFORM_LABELS } from '../api';
import type { OverviewData } from '../types';

function capBadge(status: string) {
  if (status === '已接入并验证') return 'badge badge-green';
  if (status === '需要登录' || status === '需要授权') return 'badge badge-amber';
  if (status === '采集异常' || status === '暂时不可用') return 'badge badge-red';
  return 'badge badge-gray';
}

export function OverviewPage({ onNavigate }: { onNavigate: (tab: string) => void }) {
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);

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

  if (loading && !data) return <div className="card">正在加载监控总览...</div>;
  if (!data) return <div className="card">无法获取总览数据</div>;

  const s = data.stats;
  return (
    <div>
      <div className="grid-4">
        <div className="stat-card">
          <div className="stat-label">监控对象总数</div>
          <div className="stat-value">{s.totalSources}</div>
          <div className="stat-label">网站 {s.websiteCount} · 博主 {s.creatorCount}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">今日新增内容 / 待查看</div>
          <div className="stat-value">{s.todayNew} <span style={{ fontSize: 15, fontWeight: 400, color: 'var(--text-muted)' }}>/ {s.unreadCount} 未读</span></div>
          <div className="stat-label">累计保存 {s.totalContents} 条 · 收藏 {s.favCount} 条</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">采集成功 / 失败次数</div>
          <div className="stat-value">
            <span style={{ color: 'var(--success)' }}>{s.successCount}</span>
            <span style={{ fontSize: 16, margin: '0 6px', color: 'var(--text-muted)' }}>/</span>
            <span style={{ color: s.failedCount > 0 ? 'var(--danger)' : 'var(--text)' }}>{s.failedCount}</span>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">需要关注登录状态</div>
          <div className="stat-value" style={{ color: s.authAlertCount > 0 ? 'var(--warn)' : 'var(--success)' }}>
            {s.authAlertCount}
          </div>
          <div className="stat-label">
            <button className="btn btn-sm" style={{ marginTop: 4 }} onClick={() => onNavigate('browsers')}>
              前往浏览器管理
            </button>
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div className="card">
          <h3 style={{ margin: '0 0 12px', fontSize: 15 }}>平台接入能力与独立配置状态</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>平台</th>
                  <th>当前状态</th>
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
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h3 style={{ margin: 0, fontSize: 15 }}>最近异常与提醒</h3>
            <button className="btn btn-sm" onClick={() => void load()}>刷新</button>
          </div>
          {data.recentFailures.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', padding: '24px 0', textAlign: 'center' }}>
              当前暂无采集失败或登录失效告警。
            </div>
          ) : (
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
          )}
        </div>
      </div>
    </div>
  );
}
