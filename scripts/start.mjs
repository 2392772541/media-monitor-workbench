import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST_ENTRY = path.join(ROOT, 'dist', 'server.js');
const PID_FILE = path.join(ROOT, 'data', 'server.pid');
const PORT = Number(process.env.MMW_PORT || 18910);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const NO_OPEN = process.argv.includes('--no-open');

async function isHealthy() {
  try {
    const r = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

async function main() {
  if (!fs.existsSync(DIST_ENTRY)) {
    console.error('Missing dist/server.js, please run "npm run build" first.');
    process.exit(1);
  }

  if (await isHealthy()) {
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
