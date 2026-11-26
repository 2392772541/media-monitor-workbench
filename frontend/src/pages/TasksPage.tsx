import { useEffect, useMemo, useState } from 'react';
import { RefreshCw, StopCircle, FileText, Clock, RotateCcw, Trash2, KeyRound, ShieldCheck } from 'lucide-react';
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

export function TasksPage({
  onToast,
  onNavigate,
}: {
  onToast: (msg: string) => void;
  onNavigate?: (tab: string) => void;
}) {
  const [tasks, setTasks] = useState<CollectionTask[]>([]);
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'done' | 'issue'>('all');
  const [busyTaskId, setBusyTaskId] = useState<number | null>(null);
  const [clearing, setClearing] = useState(false);
  const [logsModal, setLogsModal] = useState<{ taskId: number; rows: Array<{ id: number; level: string; message: string; created_at: string }> } | null>(null);

  const load = async () => {
    setTasks(await apiRequest<CollectionTask[]>('/api/tasks'));
  };

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, []);

  const stats = useMemo(() => {
    const finished = tasks.filter((t) => t.status === 'success' || t.status === 'failed' || t.status === 'auth_required');
    const ok = tasks.filter((t) => t.status === 'success').length;
    const issues = tasks.filter((t) => t.status === 'failed' || t.status === 'auth_required').length;
    const rate = finished.length > 0 ? Math.round((ok / finished.length) * 100) : 100;
    return { total: tasks.length, ok, issues, rate };
  }, [tasks]);

  const cancelTask = async (id: number) => {
    setBusyTaskId(id);
    try {
      const res = await apiRequest<{ message: string }>(`/api/tasks/${id}/cancel`, { method: 'POST' });
      onToast(res.message);
      await load();
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setBusyTaskId(null);
    }
  };

  const retryTask = async (id: number) => {
    setBusyTaskId(id);
    try {
      const res = await apiRequest<{ message: string }>(`/api/tasks/${id}/retry`, { method: 'POST' });
      onToast(res.message || '已重新加入抓取队列');
      await load();
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setBusyTaskId(null);
    }
  };

  const clearFailedHistory = async () => {
    setClearing(true);
    try {
      const res = await apiRequest<{ deleted: number }>('/api/tasks/failed', { method: 'DELETE' });
      onToast(`已清理 ${res.deleted} 条旧失败记录`);
      await load();
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setClearing(false);
    }
  };

  const viewLogs = async (id: number) => {
    const rows = await apiRequest<Array<{ id: number; level: string; message: string; created_at: string }>>(`/api/tasks/${id}/logs`);
    setLogsModal({ taskId: id, rows });
  };

  const filteredTasks = tasks.filter((t) => {
    if (statusFilter === 'active') return t.status === 'queued' || t.status === 'running';
    if (statusFilter === 'done') return t.status === 'success';
    if (statusFilter === 'issue') return t.status === 'failed' || t.status === 'auth_required';
    return true;
  });

  return (
    <div>
      {/* 极简防风控与健康概览条 */}
      <div className="panel-card" style={{ padding: '12px 16px', marginBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span className="badge badge-green">
              <ShieldCheck size={12} style={{ marginRight: 4 }} /> 成功率 {stats.rate}%
            </span>
            <span style={{ fontSize: 13, color: 'var(--text)' }}>
              已开启<strong>错峰调度 + B站三层防风控切换 + 报错自动冷却</strong>，大幅降低风控失败率。
            </span>
          </div>
          {stats.issues > 0 && (
            <button
              className="btn btn-sm btn-danger"
              disabled={clearing}
              onClick={() => void clearFailedHistory()}
            >
              <Trash2 size={13} /> {clearing ? '清理中...' : `清理 ${stats.issues} 条旧失败记录`}
            </button>
          )}
        </div>
      </div>

      <div className="toolbar" style={{ justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className={`btn btn-sm ${statusFilter === 'all' ? 'btn-primary' : ''}`} onClick={() => setStatusFilter('all')}>
            全部记录 ({tasks.length})
          </button>
          <button className={`btn btn-sm ${statusFilter === 'active' ? 'btn-primary' : ''}`} onClick={() => setStatusFilter('active')}>
            进行中 ({tasks.filter((t) => t.status === 'queued' || t.status === 'running').length})
          </button>
          <button className={`btn btn-sm ${statusFilter === 'done' ? 'btn-primary' : ''}`} onClick={() => setStatusFilter('done')}>
            成功 ({stats.ok})
          </button>
          <button className={`btn btn-sm ${statusFilter === 'issue' ? 'btn-primary' : ''}`} onClick={() => setStatusFilter('issue')}>
            异常/待登录 ({stats.issues})
          </button>
          <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 6 }}>每 4 秒自动刷新</span>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {onNavigate && (
            <button className="btn btn-sm" onClick={() => onNavigate('publish:history')}>
              <Clock size={13} /> 视频发布历史
            </button>
          )}
          <button className="btn btn-sm" onClick={() => void load()}><RefreshCw size={14} /> 立即刷新</button>
        </div>
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
            {filteredTasks.length === 0 ? (
              <tr>
                <td colSpan={8} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 32 }}>暂无匹配的采集任务记录</td>
              </tr>
            ) : (
              filteredTasks.map((t) => {
                const st = statusBadge(t.status);
                const isBusy = busyTaskId === t.id;
                const canRetry = t.status === 'failed' || t.status === 'cancelled' || t.status === 'auth_required';
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
                      {t.error_message && <div style={{ fontSize: 11.5, color: 'var(--danger)', marginBottom: 6 }}>{t.error_message}</div>}
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {canRetry && (
                          <button className="btn btn-sm btn-primary" disabled={isBusy} onClick={() => void retryTask(t.id)}>
                            <RotateCcw size={12} /> {isBusy ? '重试中...' : '重试'}
                          </button>
                        )}
                        {t.status === 'auth_required' && onNavigate && (
                          <button className="btn btn-sm" onClick={() => onNavigate('browsers')}>
                            <KeyRound size={12} /> 去登录
                          </button>
                        )}
                        <button className="btn btn-sm" onClick={() => void viewLogs(t.id)}><FileText size={12} /> 日志</button>
                        {(t.status === 'queued' || t.status === 'running') && (
                          <button className="btn btn-sm btn-danger" disabled={isBusy} onClick={() => void cancelTask(t.id)}>
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
