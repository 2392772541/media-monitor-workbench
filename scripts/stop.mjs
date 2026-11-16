import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PID_FILE = path.join(ROOT, 'data', 'server.pid');
const PORT = Number(process.env.MMW_PORT || 18910);
const BASE_URL = `http://127.0.0.1:${PORT}`;

async function main() {
  try {
    const r = await fetch(`${BASE_URL}/api/system/shutdown`, { method: 'POST', signal: AbortSignal.timeout(3000) });
    if (r.ok) {
      await new Promise((res) => setTimeout(res, 800));
      console.log('Workbench stopped gracefully.');
    }
  } catch {
    console.log('Workbench HTTP endpoint not active, checking PID file...');
  }

  if (fs.existsSync(PID_FILE)) {
    const raw = fs.readFileSync(PID_FILE, 'ascii').trim();
    const pid = Number(raw);
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
    }
    fs.rmSync(PID_FILE, { force: true });
  }
}

main();
