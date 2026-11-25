import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { HOST, PATHS, PORT, ensureProjectDirs } from './config.js';
import { closeDb, getDb } from './db/database.js';
import { closeAllBrowsers } from './browser/profileManager.js';
import { startScheduler, stopScheduler } from './scheduler/taskRunner.js';
import { registerRoutes } from './api/routes.js';
import { getSauStatus, startSauBackend, stopSauBackend } from './services/sauBridge.js';
import { log } from './utils/logger.js';

async function bootstrap() {
  ensureProjectDirs();
  getDb();

  const app = Fastify({ logger: false });
  await app.register(cors, {
    origin: [
      /^http:\/\/127\.0\.0\.1(:\d+)?$/,
      /^http:\/\/localhost(:\d+)?$/,
      /^http:\/\/192\.168\.\d+\.\d+(:\d+)?$/,
      /^http:\/\/10\.\d+\.\d+\.\d+(:\d+)?$/,
      /^http:\/\/172\.(1[6-9]|2\d|3[01])\.\d+\.\d+(:\d+)?$/,
      /^http:\/\/100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+(:\d+)?$/,
    ],
  });

  let isShuttingDown = false;
  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    log('INFO', 'server', 'Shutting down Media Monitor Workbench...');
    stopScheduler();
    await stopSauBackend(true);
    await closeAllBrowsers();
    await app.close().catch(() => {});
    closeDb();
    log('INFO', 'server', 'Shutdown complete.');
    process.exit(0);
  };

  registerRoutes(app, shutdown);

  if (fs.existsSync(PATHS.frontendDist)) {
    await app.register(fastifyStatic, {
      root: PATHS.frontendDist,
      prefix: '/',
      wildcard: false,
      setHeaders(res, filePath) {
        if (filePath.endsWith('index.html')) {
          res.header('Cache-Control', 'no-store, no-cache, must-revalidate');
        }
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/assets/')) {
        return reply.code(404).send({ error: 'Not found' });
      }
      const indexPath = path.join(PATHS.frontendDist, 'index.html');
      if (fs.existsSync(indexPath)) {
        return reply
          .header('Cache-Control', 'no-store, no-cache, must-revalidate')
          .type('text/html; charset=utf-8')
          .send(fs.readFileSync(indexPath, 'utf8'));
      }
      return reply.code(404).send('Frontend not built');
    });
  } else {
    app.get('/', async (_, reply) => {
      return reply
        .type('text/html; charset=utf-8')
        .send('<h1>个人自媒体监控工作台 API 运行中</h1><p>前端尚未构建，请运行 npm run build:ui 或访问 Vite 开发服务器。</p>');
    });
  }

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await app.listen({ host: HOST, port: PORT });
  startScheduler();
  // 一体化启动：若发布引擎已安装且尚未运行，后台静默拉起（避免双开窗口）
  void (async () => {
    try {
      const st = await getSauStatus();
      if (st.installed && !st.running) {
        const res = await startSauBackend();
        log('INFO', 'server', `Auto-start SAU engine: ${res.message}`);
      }
    } catch (err) {
      log('WARN', 'server', `Auto-start SAU skipped: ${(err as Error).message}`);
    }
  })();
  log('INFO', 'server', `Workbench listening on http://${HOST}:${PORT}`);
}

bootstrap().catch((err) => {
  log('ERROR', 'server', `Fatal startup error: ${(err as Error).stack || (err as Error).message}`);
  process.exit(1);
});
