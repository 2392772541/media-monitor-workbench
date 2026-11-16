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
import { stopSauBackend } from './services/sauBridge.js';
import { log } from './utils/logger.js';

async function bootstrap() {
  ensureProjectDirs();
  getDb();

  const app = Fastify({ logger: false });
  await app.register(cors, {
    origin: [/^http:\/\/127\.0\.0\.1(:\d+)?$/, /^http:\/\/localhost(:\d+)?$/],
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
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'API endpoint not found' });
      }
      const indexPath = path.join(PATHS.frontendDist, 'index.html');
      if (fs.existsSync(indexPath)) {
        return reply.type('text/html; charset=utf-8').send(fs.readFileSync(indexPath, 'utf8'));
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
  log('INFO', 'server', `Workbench listening on http://${HOST}:${PORT}`);
}

bootstrap().catch((err) => {
  log('ERROR', 'server', `Fatal startup error: ${(err as Error).stack || (err as Error).message}`);
  process.exit(1);
});
