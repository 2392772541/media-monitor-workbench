import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { PATHS, PROJECT_ROOT } from '../config.js';
import { getDb } from '../db/database.js';
import { log } from '../utils/logger.js';

export const SAU_REPO_URL = process.env.MMW_SAU_REPO_URL || 'https://github.com/2392772541/social-auto-upload.git';
export const SAU_PORT = Number(process.env.MMW_SAU_PORT || 5409);
export const SAU_FRONTEND_PORT = Number(process.env.MMW_SAU_FRONTEND_PORT || 5173);
export const SAU_HOST = '127.0.0.1';
export const SAU_BASE_URL = `http://${SAU_HOST}:${SAU_PORT}`;

let managedChild: ChildProcess | null = null;
let startingPromise: Promise<{ ok: boolean; running: boolean; message: string }> | null = null;
let installingPromise: Promise<{ ok: boolean; sauDir: string; message: string }> | null = null;
// 记录是否为主动停止以及最近一次异常退出信息，用于守护自愈与总览告警
let intentionalStop = false;
let lastExitError: string | null = null;
let autoRestartCount = 0;
let watchdogTimer: NodeJS.Timeout | null = null;

function isSauProjectDir(dir: string): boolean {
  return Boolean(dir) && fs.existsSync(path.join(dir, 'sau_backend.py'));
}

export function getDefaultInstallSauDir(): string {
  return path.join(PROJECT_ROOT, 'sau-engine');
}

export function resolveSauDir(): string {
  const envDir = (process.env.MMW_SAU_DIR || '').trim();
  if (envDir) return path.resolve(envDir);

  const embeddedDir = path.join(PROJECT_ROOT, 'sau-engine');
  if (isSauProjectDir(embeddedDir)) {
    return embeddedDir;
  }

  try {
    const row = getDb()
      .prepare("SELECT value FROM app_settings WHERE key = 'sau_dir'")
      .get() as { value?: string } | undefined;
    if (row?.value?.trim()) {
      return path.resolve(row.value.trim());
    }
  } catch {
    // ignore db lookup if not initialized yet
  }

  const candidates = [
    embeddedDir,
    path.join(PROJECT_ROOT, 'social-auto-upload'),
    getDefaultInstallSauDir(),
    'D:\\HeyGem\\social-auto-upload',
  ];
  for (const dir of candidates) {
    if (isSauProjectDir(dir)) {
      return dir;
    }
  }
  return getDefaultInstallSauDir();
}

export function setConfiguredSauDir(dir: string): string {
  const resolved = path.resolve(dir.trim());
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('sau_dir', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(resolved, now);
  return resolved;
}

function getSauPaths() {
  const sauDir = resolveSauDir();
  const candidates = [
    path.join(sauDir, '.venv', 'Scripts', 'python.exe'),
    'D:\\HeyGem\\social-auto-upload\\.venv\\Scripts\\python.exe',
  ];
  const pythonExe = candidates.find((p) => fs.existsSync(p)) || candidates[0];
  const backendScript = path.join(sauDir, 'sau_backend.py');
  return { sauDir, pythonExe, backendScript };
}

export async function checkSauHealth(timeoutMs = 1500): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${SAU_BASE_URL}/getAccounts`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function getSauStatus() {
  const { sauDir, pythonExe, backendScript } = getSauPaths();
  const installed = fs.existsSync(pythonExe) && fs.existsSync(backendScript);
  let running = await checkSauHealth();
  // 若引擎已安装、未被用户主动停止但意外掉线，自动触发一次静默恢复
  if (installed && !running && !intentionalStop && autoRestartCount < 3) {
    const recovered = await startSauBackend();
    running = recovered.running;
  }
  return {
    installed,
    repoPresent: fs.existsSync(backendScript),
    sauDir,
    pythonPath: pythonExe,
    running,
    managedByWorkbench: Boolean(managedChild && managedChild.exitCode === null),
    port: SAU_PORT,
    frontendPort: SAU_FRONTEND_PORT,
    backendUrl: SAU_BASE_URL,
    frontendUrl: `http://127.0.0.1:${SAU_FRONTEND_PORT}/`,
    lastError: running ? null : lastExitError,
  };
}

// 获取发布中心核心指标摘要，供一体化监控总览展示
export async function getSauOverviewSummary() {
  const st = await getSauStatus();
  if (!st.running) {
    return {
      installed: st.installed,
      running: false,
      lastError: st.lastError,
      totalAccounts: 0,
      invalidAccounts: 0,
      totalFiles: 0,
      totalTemplates: 0,
    };
  }

  const quickGet = async <T>(targetPath: string): Promise<T | null> => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    try {
      const r = await fetch(`${SAU_BASE_URL}${targetPath}`, { signal: ctrl.signal });
      if (!r.ok) return null;
      return (await r.json()) as T;
    } catch {
      return null;
    } finally {
      clearTimeout(t);
    }
  };

  const [accJson, fileJson, tplJson] = await Promise.all([
    quickGet<{ data?: Array<[number, number, string, string, number]> }>('/getAccounts'),
    quickGet<{ data?: unknown[] }>('/getFiles'),
    quickGet<{ data?: unknown[] }>('/getTitleTemplates'),
  ]);

  const accRows = accJson?.data || [];
  const invalidAccounts = accRows.filter((row) => row[4] !== 1).length;

  return {
    installed: st.installed,
    running: true,
    lastError: null,
    totalAccounts: accRows.length,
    invalidAccounts,
    totalFiles: (fileJson?.data || []).length,
    totalTemplates: (tplJson?.data || []).length,
  };
}

function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  extraEnv?: Record<string, string>
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      windowsHide: true,
      env: { ...process.env, ...(extraEnv || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout?.on('data', (d) => {
      out += String(d);
    });
    child.stderr?.on('data', (d) => {
      out += String(d);
    });
    child.on('error', (err) => {
      resolve({ code: 1, output: `${out}\n${err.message}` });
    });
    child.on('close', (code) => {
      resolve({ code: code ?? 1, output: out });
    });
  });
}

export async function installSauEngine(customDir?: string): Promise<{ ok: boolean; sauDir: string; message: string }> {
  if (installingPromise) {
    return installingPromise;
  }
  installingPromise = (async () => {
    const targetDir = customDir?.trim() ? path.resolve(customDir.trim()) : resolveSauDir();
    if (!isSauProjectDir(targetDir)) {
      fs.mkdirSync(path.dirname(targetDir), { recursive: true });
      const cloneRes = await runCommand('git', ['clone', SAU_REPO_URL, targetDir], path.dirname(targetDir));
      if (cloneRes.code !== 0 || !isSauProjectDir(targetDir)) {
        return { ok: false, sauDir: targetDir, message: `拉取发布仓库失败: ${cloneRes.output.slice(-300)}` };
      }
    }

    const confPath = path.join(targetDir, 'conf.py');
    const confExamplePath = path.join(targetDir, 'conf.example.py');
    if (!fs.existsSync(confPath) && fs.existsSync(confExamplePath)) {
      fs.copyFileSync(confExamplePath, confPath);
    }

    const pythonExe = path.join(targetDir, '.venv', 'Scripts', 'python.exe');
    if (!fs.existsSync(pythonExe)) {
      let venvRes = await runCommand('uv', ['venv', '.venv', '--python', '3.12'], targetDir);
      if (venvRes.code !== 0) {
        venvRes = await runCommand('python', ['-m', 'venv', '.venv'], targetDir);
      }
      if (venvRes.code !== 0 || !fs.existsSync(pythonExe)) {
        return { ok: false, sauDir: targetDir, message: `创建 Python 虚拟环境失败: ${venvRes.output.slice(-300)}` };
      }
    }

    const checkDeps = await runCommand(pythonExe, ['-c', 'import flask, flask_cors, playwright, patchright, xhs'], targetDir);
    if (checkDeps.code !== 0) {
      let pipRes = await runCommand('uv', ['pip', 'install', '--python', pythonExe, '-e', '.[web]'], targetDir);
      if (pipRes.code !== 0) {
        pipRes = await runCommand(pythonExe, ['-m', 'pip', 'install', '-e', '.[web]'], targetDir);
      }
      if (pipRes.code !== 0) {
        return { ok: false, sauDir: targetDir, message: `安装 Python 依赖失败: ${pipRes.output.slice(-300)}` };
      }
    }

    const localAppData = process.env.LOCALAPPDATA || '';
    const msPlaywright = path.join(localAppData, 'ms-playwright');
    const hasChromium =
      Boolean(localAppData) &&
      fs.existsSync(msPlaywright) &&
      fs.readdirSync(msPlaywright).some((name) => /^chromium-\d+$/.test(name));
    if (!hasChromium) {
      const mirrorEnv = { PLAYWRIGHT_DOWNLOAD_HOST: 'https://npmmirror.com/mirrors/playwright' };
      await runCommand(pythonExe, ['-m', 'playwright', 'install', 'chromium'], targetDir, mirrorEnv);
      await runCommand(pythonExe, ['-m', 'patchright', 'install', 'chromium'], targetDir, mirrorEnv);
    }

    setConfiguredSauDir(targetDir);
    return { ok: true, sauDir: targetDir, message: `发布引擎已就绪: ${targetDir}` };
  })();

  try {
    return await installingPromise;
  } finally {
    installingPromise = null;
  }
}

export async function startSauBackend(): Promise<{ ok: boolean; running: boolean; message: string }> {
  intentionalStop = false;
  if (watchdogTimer) {
    clearTimeout(watchdogTimer);
    watchdogTimer = null;
  }
  if (await checkSauHealth()) {
    lastExitError = null;
    autoRestartCount = 0;
    return { ok: true, running: true, message: '视频发布引擎已在运行中' };
  }
  if (startingPromise) {
    return startingPromise;
  }

  startingPromise = (async () => {
    const { sauDir, pythonExe, backendScript } = getSauPaths();
    if (!fs.existsSync(backendScript)) {
      return { ok: false, running: false, message: `未找到发布项目主程序: ${backendScript}` };
    }
    if (!fs.existsSync(pythonExe)) {
      return { ok: false, running: false, message: `未找到发布项目虚拟环境: ${pythonExe}` };
    }

    fs.mkdirSync(PATHS.logsDir, { recursive: true });
    const logPath = path.join(PATHS.logsDir, 'sau-backend.log');
    const logFd = fs.openSync(logPath, 'a');

    log('INFO', 'sau-bridge', `Starting SAU backend from ${sauDir} on ${SAU_HOST}:${SAU_PORT}`);
    const child = spawn(pythonExe, ['sau_backend.py'], {
      cwd: sauDir,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        SAU_HOST,
        SAU_PORT: String(SAU_PORT),
        PYTHONUNBUFFERED: '1',
        PYTHONIOENCODING: 'utf-8',
      },
    });
    fs.closeSync(logFd);

    managedChild = child;
    let exitedEarly = false;
    child.once('exit', (code) => {
      exitedEarly = true;
      if (managedChild === child) {
        managedChild = null;
      }
      if (intentionalStop) {
        log('INFO', 'sau-bridge', `SAU backend stopped intentionally (code=${code ?? 'null'})`);
        return;
      }
      lastExitError = `视频发布引擎意外退出 (退出码: ${code ?? 'null'})`;
      log('WARN', 'sau-bridge', `SAU backend exited unexpectedly with code ${code ?? 'null'}`);
      // 自动守护拉起（最多重试 3 次，避免端口占用或坏环境无限循环）
      if (autoRestartCount < 3) {
        autoRestartCount += 1;
        const delayMs = autoRestartCount * 3000;
        log('INFO', 'sau-bridge', `Scheduling SAU backend auto-recovery #${autoRestartCount} in ${delayMs}ms`);
        watchdogTimer = setTimeout(() => {
          watchdogTimer = null;
          if (!intentionalStop) {
            void startSauBackend();
          }
        }, delayMs);
      }
    });

    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      if (exitedEarly) {
        return { ok: false, running: false, message: `发布引擎启动后意外退出，请查看日志: ${logPath}` };
      }
      if (await checkSauHealth(1000)) {
        lastExitError = null;
        autoRestartCount = 0;
        return { ok: true, running: true, message: '视频发布引擎已启动' };
      }
      await new Promise((r) => setTimeout(r, 400));
    }

    lastExitError = '发布引擎启动超时';
    return { ok: false, running: false, message: `发布引擎启动超时，请查看日志: ${logPath}` };
  })();

  try {
    return await startingPromise;
  } finally {
    startingPromise = null;
  }
}

export async function stopSauBackend(onlyIfManaged = false): Promise<{ ok: boolean; running: boolean; message: string }> {
  intentionalStop = true;
  if (watchdogTimer) {
    clearTimeout(watchdogTimer);
    watchdogTimer = null;
  }
  if (managedChild && managedChild.exitCode === null && managedChild.pid) {
    const pid = managedChild.pid;
    managedChild = null;
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('exit', () => resolve());
      killer.once('error', () => resolve());
    });
  } else if (onlyIfManaged) {
    return { ok: true, running: await checkSauHealth(), message: '未由工作台托管的 SAU 进程保持运行' };
  }

  if (!onlyIfManaged && (await checkSauHealth(800))) {
    await new Promise<void>((resolve) => {
      const ps = spawn(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Get-NetTCPConnection -LocalPort ${SAU_PORT} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { if ($_.OwningProcess -gt 0) { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } }`,
        ],
        { windowsHide: true, stdio: 'ignore' }
      );
      ps.once('exit', () => resolve());
      ps.once('error', () => resolve());
    });
  }

  const stillRunning = await checkSauHealth(800);
  return {
    ok: !stillRunning,
    running: stillRunning,
    message: stillRunning ? '发布引擎仍在运行，请检查进程权限' : '视频发布引擎已停止',
  };
}

export async function ensureSauRunning(): Promise<{ ok: boolean; message?: string }> {
  if (await checkSauHealth(1000)) {
    return { ok: true };
  }
  const started = await startSauBackend();
  if (!started.ok) {
    return { ok: false, message: started.message };
  }
  return { ok: true };
}

export async function proxySauJson(
  method: 'GET' | 'POST',
  targetPath: string,
  body?: unknown,
  timeoutMs = 20000
): Promise<{ status: number; payload: unknown }> {
  const ready = await ensureSauRunning();
  if (!ready.ok) {
    return { status: 503, payload: { code: 503, msg: ready.message || '发布引擎未就绪', data: null } };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const init: RequestInit = {
      method,
      signal: controller.signal,
      headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
    };
    const res = await fetch(`${SAU_BASE_URL}${targetPath}`, init);
    const payload = await res.json().catch(() => ({ code: res.status, msg: res.statusText, data: null }));
    return { status: res.status, payload };
  } catch (err) {
    return {
      status: 502,
      payload: { code: 502, msg: `连接发布引擎失败: ${(err as Error).message}`, data: null },
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function proxySauSseLogin(req: FastifyRequest, reply: FastifyReply, queryString: string): Promise<void> {
  const ready = await ensureSauRunning();
  if (!ready.ok) {
    reply.code(503).send({ code: 503, msg: ready.message || '发布引擎未就绪', data: null });
    return;
  }

  reply.hijack();
  const rawRes = reply.raw;
  rawRes.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const upstreamReq = http.request(
    {
      hostname: SAU_HOST,
      port: SAU_PORT,
      path: `/login?${queryString}`,
      method: 'GET',
    },
    (upstreamRes) => {
      if (upstreamRes.statusCode && upstreamRes.statusCode >= 400) {
        rawRes.write('data: 500\n\n');
        rawRes.end();
        return;
      }
      upstreamRes.on('data', (chunk) => {
        if (!rawRes.writableEnded) {
          rawRes.write(chunk);
        }
      });
      upstreamRes.on('end', () => {
        if (!rawRes.writableEnded) {
          rawRes.end();
        }
      });
      upstreamRes.on('error', () => {
        if (!rawRes.writableEnded) {
          rawRes.write('data: 500\n\n');
          rawRes.end();
        }
      });
    }
  );

  upstreamReq.on('error', () => {
    if (!rawRes.writableEnded) {
      rawRes.write('data: 500\n\n');
      rawRes.end();
    }
  });

  req.raw.on('close', () => {
    upstreamReq.destroy();
  });

  upstreamReq.end();
}

export async function proxySauMultipartUpload(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const ready = await ensureSauRunning();
  if (!ready.ok) {
    reply.code(503).send({ code: 503, msg: ready.message || '发布引擎未就绪', data: null });
    return;
  }

  await new Promise<void>((resolve) => {
    const headers: Record<string, string> = {};
    if (req.headers['content-type']) {
      headers['content-type'] = String(req.headers['content-type']);
    }
    if (req.headers['content-length']) {
      headers['content-length'] = String(req.headers['content-length']);
    }

    const upstreamReq = http.request(
      {
        hostname: SAU_HOST,
        port: SAU_PORT,
        path: '/uploadSave',
        method: 'POST',
        headers,
      },
      (upstreamRes) => {
        const chunks: Buffer[] = [];
        upstreamRes.on('data', (c: Buffer) => chunks.push(c));
        upstreamRes.on('end', () => {
          const rawBody = Buffer.concat(chunks).toString('utf8');
          reply.code(upstreamRes.statusCode || 200);
          reply.header('Content-Type', upstreamRes.headers['content-type'] || 'application/json; charset=utf-8');
          reply.send(rawBody);
          resolve();
        });
      }
    );

    upstreamReq.on('error', (err) => {
      reply.code(502).send({ code: 502, msg: `上传视频到发布引擎失败: ${err.message}`, data: null });
      resolve();
    });

    req.raw.pipe(upstreamReq);
  });
}

export async function proxySauFileDownload(req: FastifyRequest, reply: FastifyReply, targetPath: string): Promise<void> {
  const ready = await ensureSauRunning();
  if (!ready.ok) {
    reply.code(503).send({ code: 503, msg: ready.message || '发布引擎未就绪', data: null });
    return;
  }

  await new Promise<void>((resolve) => {
    const upstreamReq = http.request(
      {
        hostname: SAU_HOST,
        port: SAU_PORT,
        path: targetPath,
        method: 'GET',
      },
      (upstreamRes) => {
        reply.hijack();
        const outHeaders: Record<string, string | string[]> = {};
        if (upstreamRes.headers['content-type']) {
          outHeaders['Content-Type'] = upstreamRes.headers['content-type'];
        }
        if (upstreamRes.headers['content-length']) {
          outHeaders['Content-Length'] = upstreamRes.headers['content-length'];
        }
        if (upstreamRes.headers['content-disposition']) {
          outHeaders['Content-Disposition'] = upstreamRes.headers['content-disposition'];
        }
        reply.raw.writeHead(upstreamRes.statusCode || 200, outHeaders);
        upstreamRes.pipe(reply.raw);
        upstreamRes.on('end', () => resolve());
        upstreamRes.on('error', () => {
          if (!reply.raw.writableEnded) reply.raw.end();
          resolve();
        });
      }
    );
    upstreamReq.on('error', () => {
      if (!reply.sent) {
        reply.code(502).send({ code: 502, msg: '读取发布引擎文件失败', data: null });
      }
      resolve();
    });
    req.raw.on('close', () => upstreamReq.destroy());
    upstreamReq.end();
  });
}
