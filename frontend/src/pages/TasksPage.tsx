import { useEffect, useState } from 'react';
import { RefreshCw, StopCircle, FileText } from 'lucide-react';
import { apiRequest, fmtTime, PLATFORM_LABELS } from '../api';
import type { CollectionTask } from '../types';

function statusBadge(s: string) {
  const map: Record<string, { text: string; cls: string }> = {
    queued: { text: '排队中', cls: 'badge badge-blue' },
    running: { text: '执行中', cls: 'badge badge-blue' },
    success: { text: '成功', cls: 'badge badge-green' },
    failed: { text: '失败', cls: 'badge badge-red' },
    cancelled: { text: '已取消', cls: 'badge badge-gray' },
    auth_required: { text: '需要登录', cls: 'badge badge-amber' },
  };
  return map[s] || { text: s, cls: 'badge badge-gray' };
}

function calcNextRun(lastChecked: string | null, intervalMinutes: number): string {
  if (!lastChecked) return '等待首次自动检查';
  const next = new Date(Date.parse(lastChecked) + intervalMinutes * 60 * 1000);
  return next.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function TasksPage({ onToast }: { onToast: (msg: string) => void }) {
  const [tasks, setTasks] = useState<CollectionTask[]>([]);
  const [logsModal, setLogsModal] = useState<{ taskId: number; rows: Array<{ id: number; level: string; message: string; created_at: string }> } | null>(null);

  const load = async () => {
    setTasks(await apiRequest<CollectionTask[]>('/api/tasks'));
  };

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, []);

  const cancelTask = async (id: number) => {
    const res = await apiRequest<{ message: string }>(`/api/tasks/${id}/cancel`, { method: 'POST' });
    onToast(res.message);
    await load();
  };

  const viewLogs = async (id: number) => {
    const rows = await apiRequest<Array<{ id: number; level: string; message: string; created_at: string }>>(`/api/tasks/${id}/logs`);
    setLogsModal({ taskId: id, rows });
  };

  return (
    <div>
      <div className="toolbar" style={{ justifyContent: 'space-between' }}>
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>每 4 秒自动刷新任务队列状态（最多展示最近 80 条记录）</div>
        <button className="btn" onClick={() => void load()}><RefreshCw size={14} /> 立即刷新</button>
      </div>

      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>监控对象</th>
              <th>触发方式</th>
              <th>状态</th>
              <th>发现 / 新增 / 更新</th>
              <th>开始 / 结束</th>
              <th>下次计划检查</th>
              <th>说明与操作</th>
            </tr>
          </thead>
          <tbody>
            {tasks.length === 0 ? (
              <tr>
                <td colSpan={8} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 32 }}>暂无采集任务记录</td>
              </tr>
            ) : (
              tasks.map((t) => {
                const st = statusBadge(t.status);
                return (
                  <tr key={t.id}>
                    <td>{t.id}</td>
                    <td>
                      <strong>{t.source_name}</strong>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{PLATFORM_LABELS[t.platform] || t.platform}</div>
                    </td>
                    <td>{t.trigger_type === 'manual' ? '手动' : t.trigger_type === 'scheduled' ? '定时' : '重试'}</td>
                    <td><span className={st.cls}>{st.text}</span></td>
                    <td>{t.items_found} / <strong style={{ color: 'var(--success)' }}>{t.items_new}</strong> / {t.items_updated}</td>
                    <td style={{ fontSize: 12 }}>
                      <div>起：{fmtTime(t.started_at || t.created_at)}</div>
                      <div>止：{fmtTime(t.finished_at)}</div>
                    </td>
                    <td style={{ fontSize: 12 }}>{calcNextRun(t.last_checked_at, t.interval_minutes)}</td>
                    <td>
                      {t.error_message && <div style={{ fontSize: 11, color: 'var(--danger)', marginBottom: 4 }}>{t.error_message}</div>}
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="btn btn-sm" onClick={() => void viewLogs(t.id)}><FileText size={12} /> 日志</button>
                        {(t.status === 'queued' || t.status === 'running') && (
                          <button className="btn btn-sm btn-danger" onClick={() => void cancelTask(t.id)}>
                            <StopCircle size={12} /> 取消
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {logsModal && (
        <div className="modal-backdrop" onClick={() => setLogsModal(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <strong>任务 #{logsModal.taskId} 执行日志</strong>
              <button className="btn btn-sm" onClick={() => setLogsModal(null)}>关闭</button>
            </div>
            <div className="modal-body" style={{ fontFamily: 'Consolas, monospace', fontSize: 12, background: '#0f172a', color: '#e2e8f0' }}>
              {logsModal.rows.length === 0 ? '暂无详细日志' : logsModal.rows.map((r) => (
                <div key={r.id} style={{ marginBottom: 6 }}>
                  <span style={{ color: '#94a3b8' }}>[{fmtTime(r.created_at)}]</span>{' '}
                  <span style={{ color: r.level === 'ERROR' ? '#f87171' : r.level === 'WARN' ? '#fbbf24' : '#38bdf8' }}>[{r.level}]</span>{' '}
                  {r.message}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
