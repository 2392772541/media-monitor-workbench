import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/database.js';
import {
  approveAndSendCommentReply,
  createManualWarmupJob,
  executeWarmupJobById,
  generateFanCommentReply,
  generateWarmupComments,
  getCommentGuardOverview,
  getCommentGuardSettings,
  runCommentPatrol,
  updateCommentGuardSettings,
  type CommentGuardSettings,
  type CreatorCommentRow,
  type WarmupCommentItem,
  type WarmupJobRow,
  type WarmupStyle,
} from '../services/commentGuardService.js';
import { escapeLikeTerm, parsePositiveIntId } from '../utils/sqlValidation.js';

function hydrateWarmupJob(row: WarmupJobRow) {
  let comments: WarmupCommentItem[] = [];
  let tags: string[] = [];
  try {
    comments = JSON.parse(row.comments_json || '[]') as WarmupCommentItem[];
  } catch {
    comments = [];
  }
  try {
    tags = JSON.parse(row.tags_json || '[]') as string[];
  } catch {
    tags = [];
  }
  return {
    ...row,
    comments,
    tags,
  };
}

export function registerCommentGuardRoutes(app: FastifyInstance): void {
  // 1. 评论托管总览（状态 + 指标 + 平台能力 + 规则）
  app.get('/api/comment-guard/overview', async () => {
    return getCommentGuardOverview();
  });

  app.get('/api/comment-guard/settings', async () => {
    return { settings: getCommentGuardSettings() };
  });

  app.patch<{ Body: Partial<CommentGuardSettings> }>('/api/comment-guard/settings', async (req) => {
    const settings = updateCommentGuardSettings(req.body || {});
    return { ok: true, settings };
  });

  // 2. 立即触发一次巡检（可指定平台或 dryRun / syncOnly）
  app.post<{ Body: { platforms?: number[]; dryRun?: boolean; syncOnly?: boolean } }>(
    '/api/comment-guard/patrol',
    async (req) => {
      const b = req.body || {};
      const platforms = Array.isArray(b.platforms)
        ? b.platforms.map(Number).filter((n) => [1, 2, 3, 4].includes(n))
        : undefined;
      return runCommentPatrol({
        manual: true,
        platforms,
        dryRun: Boolean(b.dryRun),
        syncOnly: Boolean(b.syncOnly),
      });
    }
  );

  // 3. 已同步的自有发布作品列表
  app.get<{ Querystring: { platformType?: string; q?: string; limit?: string } }>(
    '/api/comment-guard/videos',
    async (req) => {
      const db = getDb();
      const conds: string[] = [];
      const vals: Array<string | number> = [];
      if (req.query.platformType && /^\d+$/.test(req.query.platformType)) {
        conds.push('v.platform_type = ?');
        vals.push(Number(req.query.platformType));
      }
      if (req.query.q && req.query.q.trim()) {
        conds.push("v.title LIKE ? ESCAPE '\\'");
        vals.push(`%${escapeLikeTerm(req.query.q.trim())}%`);
      }
      const limit = Math.min(100, Math.max(1, Number(req.query.limit || 40) || 40));
      const whereSql = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
      const items = db
        .prepare(
          `SELECT v.*,
                  (SELECT COUNT(*) FROM creator_video_comments c
                   WHERE c.platform_type = v.platform_type AND c.platform_video_id = v.platform_video_id AND c.is_author_comment = 0) AS synced_fan_comments,
                  (SELECT COUNT(*) FROM creator_video_comments c
                   WHERE c.platform_type = v.platform_type AND c.platform_video_id = v.platform_video_id AND c.reply_status = 'replied') AS replied_fan_comments
           FROM creator_published_videos v
           ${whereSql}
           ORDER BY COALESCE(v.published_at, v.last_synced_at) DESC, v.id DESC
           LIMIT ?`
        )
        .all(...vals, limit);
      return { items };
    }
  );

  // 4. 粉丝评论收件箱与自动回复明细
  app.get<{ Querystring: { platformType?: string; status?: string; videoId?: string; q?: string; limit?: string } }>(
    '/api/comment-guard/comments',
    async (req) => {
      const db = getDb();
      const conds: string[] = [];
      const vals: Array<string | number> = [];
      if (req.query.platformType && /^\d+$/.test(req.query.platformType)) {
        conds.push('platform_type = ?');
        vals.push(Number(req.query.platformType));
      }
      if (req.query.status && req.query.status !== 'all') {
        if (req.query.status === 'actionable') {
          conds.push("reply_status IN ('pending', 'draft_ready', 'failed')");
        } else {
          conds.push('reply_status = ?');
          vals.push(req.query.status);
        }
      }
      if (req.query.videoId && req.query.videoId.trim()) {
        conds.push('platform_video_id = ?');
        vals.push(req.query.videoId.trim());
      }
      if (req.query.q && req.query.q.trim()) {
        const like = `%${escapeLikeTerm(req.query.q.trim())}%`;
        conds.push("(comment_text LIKE ? ESCAPE '\\' OR author_name LIKE ? ESCAPE '\\' OR video_title LIKE ? ESCAPE '\\' OR ai_reply_text LIKE ? ESCAPE '\\')");
        vals.push(like, like, like, like);
      }
      const limit = Math.min(200, Math.max(1, Number(req.query.limit || 80) || 80));
      const whereSql = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
      const items = db
        .prepare(
          `SELECT * FROM creator_video_comments
           ${whereSql}
           ORDER BY COALESCE(comment_created_at, discovered_at) DESC, id DESC
           LIMIT ?`
        )
        .all(...vals, limit);
      return { items };
    }
  );

  app.post<{ Params: { id: string } }>('/api/comment-guard/comments/:id/regenerate', async (req, reply) => {
    const id = parsePositiveIntId(req.params.id);
    if (!id) return reply.code(400).send({ error: '无效的评论 ID' });
    const db = getDb();
    const row = db.prepare('SELECT * FROM creator_video_comments WHERE id = ?').get(id) as CreatorCommentRow | undefined;
    if (!row) return reply.code(404).send({ error: '评论不存在' });
    const gen = await generateFanCommentReply({
      platformType: row.platform_type,
      videoTitle: row.video_title,
      authorName: row.author_name,
      commentText: row.comment_text,
      forceRefresh: true,
    });
    const now = new Date().toISOString();
    const nextStatus = row.reply_status === 'replied' ? 'replied' : 'draft_ready';
    db.prepare('UPDATE creator_video_comments SET ai_reply_text = ?, reply_status = ?, updated_at = ? WHERE id = ?').run(
      gen.replyText,
      nextStatus,
      now,
      id
    );
    const updated = db.prepare('SELECT * FROM creator_video_comments WHERE id = ?').get(id);
    return { ok: true, usedAi: gen.usedAi, comment: updated };
  });

  app.post<{ Params: { id: string }; Body: { replyText?: string; dryRun?: boolean } }>(
    '/api/comment-guard/comments/:id/send',
    async (req, reply) => {
      const id = parsePositiveIntId(req.params.id);
      if (!id) return reply.code(400).send({ error: '无效的评论 ID' });
      const res = await approveAndSendCommentReply(id, req.body?.replyText, { dryRun: Boolean(req.body?.dryRun) });
      if (!res.ok) return reply.code(400).send(res);
      return res;
    }
  );

  app.post<{ Params: { id: string } }>('/api/comment-guard/comments/:id/ignore', async (req, reply) => {
    const id = parsePositiveIntId(req.params.id);
    if (!id) return reply.code(400).send({ error: '无效的评论 ID' });
    const db = getDb();
    const res = db
      .prepare("UPDATE creator_video_comments SET reply_status = 'ignored', skip_reason = '用户手动忽略', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
    if (res.changes === 0) return reply.code(404).send({ error: '评论不存在' });
    return { ok: true };
  });

  // 5. 发片暖场评论队列与 AI 预览/手工创建
  app.get<{ Querystring: { limit?: string } }>('/api/comment-guard/warmups', async (req) => {
    const db = getDb();
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 40) || 40));
    const rows = db
      .prepare('SELECT * FROM comment_warmup_jobs ORDER BY id DESC LIMIT ?')
      .all(limit) as unknown as WarmupJobRow[];
    return { items: rows.map(hydrateWarmupJob) };
  });

  app.post<{
    Body: {
      platformType?: number;
      videoTitle: string;
      videoScript?: string;
      tags?: string[];
      count?: number;
      style?: WarmupStyle;
    };
  }>('/api/comment-guard/warmups/preview', async (req, reply) => {
    const b = req.body || {};
    const videoTitle = String(b.videoTitle || '').trim();
    if (!videoTitle) return reply.code(400).send({ error: '请先输入视频标题' });
    const gen = await generateWarmupComments({
      platformType: Number(b.platformType || 3),
      videoTitle,
      videoScript: b.videoScript,
      tags: Array.isArray(b.tags) ? b.tags : [],
      count: b.count,
      style: b.style,
      forceRefresh: true,
    });
    return { ok: true, ...gen };
  });

  app.post<{
    Body: {
      platformType: number;
      accountName?: string;
      videoId?: string;
      videoTitle: string;
      videoScript?: string;
      tags?: string[];
      comments?: Array<{ text: string; angle?: string }>;
      count?: number;
      style?: WarmupStyle;
      sendNow?: boolean;
      dryRun?: boolean;
    };
  }>('/api/comment-guard/warmups', async (req, reply) => {
    try {
      const created = await createManualWarmupJob(req.body);
      return { ok: true, job: hydrateWarmupJob(created.job), runResult: created.runResult };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.patch<{ Params: { id: string }; Body: { comments?: Array<{ text: string; angle?: string }> } }>(
    '/api/comment-guard/warmups/:id',
    async (req, reply) => {
      const id = parsePositiveIntId(req.params.id);
      if (!id) return reply.code(400).send({ error: '无效的暖评任务 ID' });
      const db = getDb();
      const row = db.prepare('SELECT * FROM comment_warmup_jobs WHERE id = ?').get(id) as WarmupJobRow | undefined;
      if (!row) return reply.code(404).send({ error: '暖评任务不存在' });

      const rawComments = Array.isArray(req.body?.comments) ? req.body.comments : [];
      const nextItems: WarmupCommentItem[] = rawComments
        .map((c) => ({
          text: String(c?.text || '').trim(),
          angle: String(c?.angle || '讨论引子').trim() || '讨论引子',
          status: 'pending' as const,
        }))
        .filter((c) => c.text.length > 0)
        .slice(0, 3);
      if (nextItems.length === 0) {
        return reply.code(400).send({ error: '暖场评论列表不能为空' });
      }
      db.prepare('UPDATE comment_warmup_jobs SET comments_json = ?, target_count = ?, updated_at = ? WHERE id = ?').run(
        JSON.stringify(nextItems),
        nextItems.length,
        new Date().toISOString(),
        id
      );
      const updated = db.prepare('SELECT * FROM comment_warmup_jobs WHERE id = ?').get(id) as unknown as WarmupJobRow;
      return { ok: true, job: hydrateWarmupJob(updated) };
    }
  );

  app.post<{ Params: { id: string } }>('/api/comment-guard/warmups/:id/regenerate', async (req, reply) => {
    const id = parsePositiveIntId(req.params.id);
    if (!id) return reply.code(400).send({ error: '无效的暖评任务 ID' });
    const db = getDb();
    const row = db.prepare('SELECT * FROM comment_warmup_jobs WHERE id = ?').get(id) as WarmupJobRow | undefined;
    if (!row) return reply.code(404).send({ error: '暖评任务不存在' });
    let tags: string[] = [];
    try {
      tags = JSON.parse(row.tags_json || '[]') as string[];
    } catch {
      tags = [];
    }
    const gen = await generateWarmupComments({
      platformType: row.platform_type,
      videoTitle: row.video_title,
      videoScript: row.video_script,
      tags,
      count: row.target_count || 3,
      forceRefresh: true,
    });
    db.prepare('UPDATE comment_warmup_jobs SET comments_json = ?, target_count = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify(gen.comments),
      gen.comments.length,
      new Date().toISOString(),
      id
    );
    const updated = db.prepare('SELECT * FROM comment_warmup_jobs WHERE id = ?').get(id) as unknown as WarmupJobRow;
    return { ok: true, usedAi: gen.usedAi, job: hydrateWarmupJob(updated) };
  });

  app.post<{ Params: { id: string }; Body: { dryRun?: boolean } }>(
    '/api/comment-guard/warmups/:id/run',
    async (req, reply) => {
      const id = parsePositiveIntId(req.params.id);
      if (!id) return reply.code(400).send({ error: '无效的暖评任务 ID' });
      const res = await executeWarmupJobById(id, {
        dryRun: Boolean(req.body?.dryRun),
        skipSpacing: Boolean(req.body?.dryRun),
      });
      if (!res.ok) return reply.code(400).send(res);
      return res;
    }
  );

  app.post<{ Params: { id: string } }>('/api/comment-guard/warmups/:id/cancel', async (req, reply) => {
    const id = parsePositiveIntId(req.params.id);
    if (!id) return reply.code(400).send({ error: '无效的暖评任务 ID' });
    const db = getDb();
    const res = db
      .prepare("UPDATE comment_warmup_jobs SET status = 'cancelled', updated_at = ? WHERE id = ? AND status NOT IN ('done')")
      .run(new Date().toISOString(), id);
    if (res.changes === 0) return reply.code(404).send({ error: '任务不存在或已完成' });
    return { ok: true };
  });

  // 6. 巡检与自动回复运行日志
  app.get<{ Querystring: { limit?: string } }>('/api/comment-guard/logs', async (req) => {
    const db = getDb();
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 60) || 60));
    const items = db.prepare('SELECT * FROM comment_guard_logs ORDER BY id DESC LIMIT ?').all(limit);
    return { items };
  });
}
