import { getDb, upsertContentWithMetrics } from '../db/database.js';
import { getAdapter } from '../adapters/index.js';
import type { SourceRecord } from '../adapters/types.js';
import { log } from '../utils/logger.js';

interface RunningTask {
  collectionId: number;
  sourceId: number;
  controller: AbortController;
}

const queue: number[] = [];
const runningBySource = new Set<number>();
const runningControllers = new Map<number, RunningTask>();
let isProcessing = false;
let schedulerTimer: NodeJS.Timeout | null = null;
const retryCounts = new Map<number, number>();

function appendTaskLog(collectionId: number, sourceId: number, level: 'INFO' | 'WARN' | 'ERROR', message: string) {
  try {
    const db = getDb();
    db.prepare('INSERT INTO collection_logs (collection_id, source_id, level, message, created_at) VALUES (?, ?, ?, ?, ?)').run(
      collectionId,
      sourceId,
      level,
      message,
      new Date().toISOString()
    );
  } catch {
    // ignore
  }
  log(level, `task#${collectionId}`, message);
}

export function enqueueCollection(sourceId: number, triggerType: 'manual' | 'scheduled' | 'retry' = 'manual'): { queued: boolean; collectionId?: number; reason?: string } {
  const db = getDb();
  const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(sourceId) as SourceRecord | undefined;
  if (!source) return { queued: false, reason: '监控对象不存在' };
  if (triggerType === 'scheduled' && source.status !== 'active') {
    return { queued: false, reason: '监控对象当前已暂停' };
  }

  if (runningBySource.has(sourceId)) {
    return { queued: false, reason: '该监控对象正在采集中，请等待完成' };
  }

  const existingQueued = db
    .prepare("SELECT id FROM collections WHERE source_id = ? AND status IN ('queued', 'running') LIMIT 1")
    .get(sourceId) as { id: number } | undefined;
  if (existingQueued) {
    return { queued: false, collectionId: existingQueued.id, reason: '任务已在队列中' };
  }

  const now = new Date().toISOString();
  const res = db
    .prepare("INSERT INTO collections (source_id, trigger_type, status, created_at) VALUES (?, ?, 'queued', ?)")
    .run(sourceId, triggerType, now);
  const collectionId = Number(res.lastInsertRowid);
  appendTaskLog(collectionId, sourceId, 'INFO', `任务已入队 (触发方式: ${triggerType})`);
  queue.push(collectionId);
  void processQueue();
  return { queued: true, collectionId };
}

export function cancelCollection(collectionId: number): { cancelled: boolean; message: string } {
  const db = getDb();
  const row = db.prepare('SELECT id, source_id, status FROM collections WHERE id = ?').get(collectionId) as
    | { id: number; source_id: number; status: string }
    | undefined;
  if (!row) return { cancelled: false, message: '任务不存在' };

  const running = runningControllers.get(collectionId);
  if (running) {
    running.controller.abort(new Error('用户手动取消'));
    db.prepare("UPDATE collections SET status = 'cancelled', finished_at = ?, error_message = '用户已取消' WHERE id = ?").run(
      new Date().toISOString(),
      collectionId
    );
    appendTaskLog(collectionId, row.source_id, 'WARN', '任务已被用户手动取消');
    return { cancelled: true, message: '已发送取消信号给运行中的任务' };
  }

  if (row.status === 'queued') {
    const idx = queue.indexOf(collectionId);
    if (idx !== -1) queue.splice(idx, 1);
    db.prepare("UPDATE collections SET status = 'cancelled', finished_at = ?, error_message = '用户已取消' WHERE id = ?").run(
      new Date().toISOString(),
      collectionId
    );
    appendTaskLog(collectionId, row.source_id, 'WARN', '排队任务已被用户取消');
    return { cancelled: true, message: '已取消排队任务' };
  }

  return { cancelled: false, message: `任务当前状态为 ${row.status}，无法取消` };
}

async function processQueue() {
  if (isProcessing) return;
  isProcessing = true;
  try {
    while (queue.length > 0) {
      const collectionId = queue.shift()!;
      await executeCollection(collectionId);
    }
  } finally {
    isProcessing = false;
  }
}

function getBrowserHeadlessSetting(): boolean {
  const db = getDb();
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'browser_mode'").get() as { value: string } | undefined;
  return row?.value !== 'headed';
}

async function executeCollection(collectionId: number) {
  const db = getDb();
  const col = db.prepare('SELECT * FROM collections WHERE id = ?').get(collectionId) as
    | { id: number; source_id: number; trigger_type: string; status: string }
    | undefined;
  if (!col || col.status !== 'queued') return;

  const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(col.source_id) as SourceRecord | undefined;
  if (!source) {
    db.prepare("UPDATE collections SET status = 'failed', finished_at = ?, error_message = '监控对象已被删除' WHERE id = ?").run(
      new Date().toISOString(),
      collectionId
    );
    return;
  }

  const controller = new AbortController();
  runningBySource.add(source.id);
  runningControllers.set(collectionId, { collectionId, sourceId: source.id, controller });

  const startedAt = new Date().toISOString();
  db.prepare("UPDATE collections SET status = 'running', started_at = ? WHERE id = ?").run(startedAt, collectionId);
  appendTaskLog(collectionId, source.id, 'INFO', `开始采集 [${source.platform}] ${source.name}`);

  try {
    const adapter = getAdapter(source.platform);
    const headless = getBrowserHeadlessSetting();
    const res = await adapter.fetchLatest(source, {
      headless,
      signal: controller.signal,
      onLog: (msg) => appendTaskLog(collectionId, source.id, 'INFO', msg),
    });

    if (controller.signal.aborted) {
      return;
    }

    let itemsNew = 0;
    let itemsUpdated = 0;
    for (const item of res.items) {
      const saved = upsertContentWithMetrics({
        sourceId: source.id,
        platform: source.platform,
        platformItemId: item.platformItemId,
        url: item.url,
        title: item.title,
        author: item.author,
        summary: item.summary,
        body: item.body,
        coverUrl: item.coverUrl,
        tags: item.tags,
        publishedAt: item.publishedAt,
        pageUpdatedAt: item.pageUpdatedAt,
        rawMeta: item.rawMeta,
        metrics: item.metrics,
      });
      if (saved.isNew) itemsNew++;
      else if (saved.metricsUpdated) itemsUpdated++;
    }

    const finishedAt = new Date().toISOString();
    if (res.ok) {
      retryCounts.delete(source.id);
      db.prepare(`
        UPDATE collections SET
          status = 'success',
          finished_at = ?,
          items_found = ?,
          items_new = ?,
          items_updated = ?,
          error_message = ?
        WHERE id = ?
      `).run(finishedAt, res.items.length, itemsNew, itemsUpdated, res.errorMessage || null, collectionId);

      db.prepare(`
        UPDATE sources SET
          capability_status = ?,
          last_checked_at = ?,
          last_content_at = CASE WHEN ? > 0 THEN ? ELSE last_content_at END,
          last_error = ?,
          updated_at = ?
        WHERE id = ?
      `).run(res.capabilityStatus, finishedAt, itemsNew, finishedAt, res.errorMessage || null, finishedAt, source.id);

      appendTaskLog(
        collectionId,
        source.id,
        'INFO',
        `采集完成: 发现 ${res.items.length} 条，新增 ${itemsNew} 条，指标更新 ${itemsUpdated} 条`
      );
    } else if (res.authRequired) {
      retryCounts.delete(source.id);
      db.prepare(`
        UPDATE collections SET status = 'auth_required', finished_at = ?, error_message = ? WHERE id = ?
      `).run(finishedAt, res.errorMessage || '需要登录验证', collectionId);

      db.prepare(`
        UPDATE sources SET capability_status = ?, last_checked_at = ?, last_error = ?, updated_at = ? WHERE id = ?
      `).run('需要登录', finishedAt, res.errorMessage || '需要登录', finishedAt, source.id);

      appendTaskLog(collectionId, source.id, 'WARN', `需要人工登录处理: ${res.errorMessage || ''}`);
    } else {
      db.prepare(`
        UPDATE collections SET status = 'failed', finished_at = ?, error_message = ? WHERE id = ?
      `).run(finishedAt, res.errorMessage || '采集失败', collectionId);

      db.prepare(`
        UPDATE sources SET capability_status = ?, last_checked_at = ?, last_error = ?, updated_at = ? WHERE id = ?
      `).run(res.capabilityStatus, finishedAt, res.errorMessage || '采集失败', finishedAt, source.id);

      appendTaskLog(collectionId, source.id, 'ERROR', `采集失败: ${res.errorMessage || '未知错误'}`);

      // Backoff retry once for transient errors (never for profile lock or auth errors)
      const prevRetries = retryCounts.get(source.id) || 0;
      if (prevRetries < 1 && !(res.errorMessage || '').includes('PROFILE_LOCKED')) {
        retryCounts.set(source.id, prevRetries + 1);
        setTimeout(() => {
          enqueueCollection(source.id, 'retry');
        }, 15000);
        appendTaskLog(collectionId, source.id, 'INFO', '将在 15 秒后自动退避重试一次');
      }
    }
  } catch (err) {
    const finishedAt = new Date().toISOString();
    const msg = (err as Error).message || '未知运行异常';
    db.prepare(`UPDATE collections SET status = 'failed', finished_at = ?, error_message = ? WHERE id = ?`).run(
      finishedAt,
      msg,
      collectionId
    );
    db.prepare(`UPDATE sources SET last_checked_at = ?, last_error = ?, updated_at = ? WHERE id = ?`).run(
      finishedAt,
      msg,
      finishedAt,
      source.id
    );
    appendTaskLog(collectionId, source.id, 'ERROR', `任务异常终止: ${msg}`);
  } finally {
    runningBySource.delete(source.id);
    runningControllers.delete(collectionId);
  }
}

export function checkDueScheduledTasks() {
  try {
    const db = getDb();
    const enabledRow = db.prepare("SELECT value FROM app_settings WHERE key = 'scheduler_enabled'").get() as
      | { value: string }
      | undefined;
    if (enabledRow?.value === 'false') return;

    // Clean up stale queued/running jobs left over from unexpected crash
    const now = Date.now();
    const sources = db
      .prepare("SELECT id, interval_minutes, last_checked_at, status FROM sources WHERE status = 'active'")
      .all() as Array<{ id: number; interval_minutes: number; last_checked_at: string | null; status: string }>;

    for (const s of sources) {
      const intervalMs = Math.max(5, s.interval_minutes || 60) * 60 * 1000;
      const lastMs = s.last_checked_at ? Date.parse(s.last_checked_at) : 0;
      if (!lastMs || now - lastMs >= intervalMs) {
        enqueueCollection(s.id, 'scheduled');
      }
    }
  } catch (err) {
    log('WARN', 'scheduler', `Scheduler tick error: ${(err as Error).message}`);
  }
}

export function startScheduler() {
  // Recover any stale 'running' jobs left over after unexpected process exit
  try {
    const db = getDb();
    const recovered = db
      .prepare("UPDATE collections SET status = 'failed', finished_at = ?, error_message = '服务重启中断恢复' WHERE status IN ('running', 'queued')")
      .run(new Date().toISOString());
    if (recovered.changes > 0) {
      log('WARN', 'scheduler', `Recovered ${recovered.changes} interrupted tasks from previous run`);
    }
  } catch {
    // ignore
  }

  if (schedulerTimer) return;
  schedulerTimer = setInterval(() => {
    checkDueScheduledTasks();
  }, 30000);
  // Run initial check 5s after startup (also handles sleep/reboot catch-up!)
  setTimeout(() => checkDueScheduledTasks(), 5000);
  log('INFO', 'scheduler', 'Background task scheduler started (30s interval)');
}

export function stopScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
  for (const [, running] of runningControllers) {
    running.controller.abort(new Error('服务关闭'));
  }
  queue.length = 0;
  log('INFO', 'scheduler', 'Background task scheduler stopped');
}
