import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../config.js';

function sanitize(msg: string): string {
  return msg
    .replace(/(cookie\s*[:=]\s*)([^\r\n;]+)/gi, '$1[REDACTED]')
    .replace(/(authorization\s*[:=]\s*)([^\r\n]+)/gi, '$1[REDACTED]')
    .replace(/(password\s*[:=]\s*)([^\r\n&\s]+)/gi, '$1[REDACTED]');
}

function todayFile(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return path.join(PATHS.logsDir, `workbench-${yyyy}-${mm}-${dd}.log`);
}

export function log(level: 'INFO' | 'WARN' | 'ERROR', scope: string, message: string): void {
  const line = `[${new Date().toISOString()}] [${level}] [${scope}] ${sanitize(message)}`;
  if (level === 'ERROR') {
    console.error(line);
  } else {
    console.log(line);
  }
  try {
    fs.mkdirSync(PATHS.logsDir, { recursive: true });
    fs.appendFileSync(todayFile(), line + '\n', 'utf8');
  } catch {
    // ignore disk log errors to avoid crashing core loop
  }
}

export function readRecentLogs(limitLines = 150): string[] {
  try {
    const file = todayFile();
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
    return lines.slice(-limitLines).reverse();
  } catch {
    return [];
  }
}
