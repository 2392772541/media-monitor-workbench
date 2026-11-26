import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST_ENTRY = path.join(ROOT, 'dist', 'server.js');
const PID_FILE = path.join(ROOT, 'data', 'server.pid');
const PORT = Number(process.env.MMW_PORT || 18910);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const NO_OPEN = process.argv.includes('--no-open');

async function getHealth() {
  try {
    const r = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

async function isHealthy() {
  return Boolean(await getHealth());
}

function readManagedPid() {
  try {
    const n = Number(fs.readFileSync(PID_FILE, 'ascii').trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

async function shutdownExisting() {
  try {
    await fetch(`${BASE_URL}/api/system/shutdown`, { method: 'POST', signal: AbortSignal.timeout(3000) });
  } catch {
    // ignore
  }
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (!(await isHealthy())) return;
  }
}

async function main() {
  if (!fs.existsSync(DIST_ENTRY)) {
    console.error('Missing dist/server.js, please run "npm run build" first.');
    process.exit(1);
  }

  const FORCE_RESTART = process.argv.includes('--restart');
  let health = await getHealth();
  const managedPid = readManagedPid();

  // 若 18910 由非桌面终端（如后台自动化进程）拉起，PID 与 server.pid 不一致，自动接管重启到真实桌面
  if (health && (FORCE_RESTART || !managedPid || health.pid !== managedPid)) {
    console.log(`检测到后台已有旧工作台进程 (PID=${health.pid})，正在切回当前真实桌面重启...`);
    await shutdownExisting();
    health = await getHealth();
  }

  if (health) {
    console.log(`Media Monitor Workbench is already running: ${BASE_URL}`);
  } else {
    const child = spawn(process.execPath, [DIST_ENTRY], {
      cwd: ROOT,
      env: { ...process.env, MMW_PORT: String(PORT) },
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    });
    child.unref();
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
    fs.writeFileSync(PID_FILE, String(child.pid), 'ascii');

    let ready = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (await isHealthy()) {
        ready = true;
        break;
      }
    }
    if (!ready) {
      console.error('Workbench startup timeout. Please inspect logs/ folder.');
      process.exit(1);
    }
    console.log(`Media Monitor Workbench started (PID=${child.pid}): ${BASE_URL}`);
  }

  if (!NO_OPEN) {
    spawn('cmd', ['/c', 'start', '', BASE_URL], { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
