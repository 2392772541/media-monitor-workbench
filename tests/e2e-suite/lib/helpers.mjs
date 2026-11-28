import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
export const SKILL_DIR = 'C:\\Users\\win10\\.gemini\\config\\skills\\video-auto-publisher';
export const SKILL_MD_PATH = path.join(SKILL_DIR, 'SKILL.md');
export const MCP_SCRIPT_PATH = path.join(PROJECT_ROOT, 'mcp', 'video-publisher-mcp.mjs');
export const MCP_CONFIG_PATH = 'C:\\Users\\win10\\.gemini\\antigravity\\mcp_config.json';
export const SKILL_DOCTOR_SCRIPT = 'D:\\AI-Skills\\skills\\skill-doctor\\scripts\\doctor.py';
export const NODE_EXE = process.execPath;

export function resolvePythonExe() {
  const condaPy = 'E:\\app\\Miniconda\\python.exe';
  if (fs.existsSync(condaPy)) return condaPy;
  return 'python';
}

export const PYTHON_EXE = resolvePythonExe();

export class PendingLiveError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PendingLiveError';
  }
}

export function pendingIfOffline(ctx, reason) {
  if (ctx?.offlineCheck) {
    throw new PendingLiveError(reason);
  }
  assert.fail(reason);
}

export function isConnectionError(err) {
  const msg = String(err?.message || err || '');
  const code = String(err?.cause?.code || err?.code || '');
  return (
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    /fetch failed|ECONNREFUSED|aborted|timeout/i.test(msg)
  );
}

export async function httpRaw(url, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Request timeout after ${timeoutMs}ms: ${url}`)), timeoutMs);
  try {
    const fetchOpts = {
      method: opts.method || 'GET',
      headers: { ...(opts.headers || {}) },
      signal: controller.signal,
    };
    if (opts.body !== undefined) {
      if (typeof opts.body === 'string' || opts.body instanceof Uint8Array || opts.body instanceof FormData) {
        fetchOpts.body = opts.body;
      } else {
        fetchOpts.headers['Content-Type'] = fetchOpts.headers['Content-Type'] || 'application/json';
        fetchOpts.body = JSON.stringify(opts.body);
      }
    }
    const res = await fetch(url, fetchOpts);
    const arrayBuf = await res.arrayBuffer();
    const buf = Buffer.from(arrayBuf);
    const text = buf.toString('utf8');
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return {
      status: res.status,
      ok: res.ok,
      headers: res.headers,
      buf,
      text,
      json,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function httpJson(ctx, url, opts = {}) {
  try {
    return await httpRaw(url, opts);
  } catch (err) {
    if (ctx?.offlineCheck && isConnectionError(err)) {
      throw new PendingLiveError(`Live service unreachable in offline-check: ${url} (${err.message})`);
    }
    throw err;
  }
}

export function isRouteMissing(res) {
  if (!res) return false;
  if (res.status !== 404) return false;
  if (res.json?.error === 'Not found' || res.json?.msg === 'Not found') return true;
  const bodyMsg = String(res.json?.message || res.json?.error || res.text || '');
  return (
    /Route\s+\w+:[^\s]+\s+not found/i.test(bodyMsg) ||
    /404 Not Found/i.test(bodyMsg) ||
    /The requested URL was not found/i.test(bodyMsg) ||
    res.text.trim().startsWith('<!doctype html') ||
    res.text.trim().startsWith('<!DOCTYPE html')
  );
}

export function isFastifyRouteNotFound(res) {
  if (!res || res.status !== 404) return false;
  const bodyMsg = String(res.json?.message || res.text || '');
  return /Route\s+\w+:[^\s]+\s+not found/i.test(bodyMsg);
}

export async function isM1Deployed(ctx) {
  if (typeof ctx?._m1Deployed === 'boolean') return ctx._m1Deployed;
  const res = await httpJson(ctx, `${ctx.baseUrl}/api/radar/creators/feed?limit=1`);
  const deployed =
    res.status === 200 &&
    res.json?.todayUpdates !== undefined &&
    res.json?.todayLeaderboard !== undefined;
  if (ctx && typeof ctx === 'object') ctx._m1Deployed = deployed;
  return deployed;
}

export async function isM3ImportDeployed(ctx) {
  if (typeof ctx?._m3ImportDeployed === 'boolean') return ctx._m3ImportDeployed;
  const probe = await httpJson(ctx, `${ctx.baseUrl}/api/sau/import-local-file`, {
    method: 'POST',
    body: {},
  });
  const deployed = !isRouteMissing(probe) && probe.status === 400;
  if (ctx && typeof ctx === 'object') ctx._m3ImportDeployed = deployed;
  return deployed;
}

/**
 * Generates a minimal synthetic MP4 file with valid ISO BMFF `ftyp` + `free` + `mdat` + `moov` boxes.
 * Always call `cleanup()` in a `finally` block.
 */
export function createSyntheticMp4(filename = 'e2e_synthetic.mp4') {
  const baseTmp = process.env.E2E_TMP_DIR || os.tmpdir();
  fs.mkdirSync(baseTmp, { recursive: true });
  const dir = fs.mkdtempSync(path.join(baseTmp, 'mmw-e2e-'));
  const filePath = path.join(dir, filename);

  // ftyp box (24 bytes): isom / iso2 / mp41
  const ftyp = Buffer.from([
    0x00, 0x00, 0x00, 0x18,
    0x66, 0x74, 0x79, 0x70, // 'ftyp'
    0x69, 0x73, 0x6f, 0x6d, // 'isom'
    0x00, 0x00, 0x02, 0x00, // minor_version
    0x69, 0x73, 0x6f, 0x32, // 'iso2'
    0x6d, 0x70, 0x34, 0x31, // 'mp41'
  ]);
  // free box (8 bytes)
  const freeBox = Buffer.from([0x00, 0x00, 0x00, 0x08, 0x66, 0x72, 0x65, 0x65]);
  // mdat box (24 bytes)
  const mdat = Buffer.alloc(24, 0);
  mdat.writeUInt32BE(24, 0);
  mdat.write('mdat', 4, 'ascii');
  // minimal moov + mvhd (116 bytes)
  const mvhdSize = 108;
  const moovSize = 8 + mvhdSize;
  const moov = Buffer.alloc(moovSize, 0);
  moov.writeUInt32BE(moovSize, 0);
  moov.write('moov', 4, 'ascii');
  moov.writeUInt32BE(mvhdSize, 8);
  moov.write('mvhd', 12, 'ascii');
  moov.writeUInt32BE(1000, 28); // timescale
  moov.writeUInt32BE(1000, 32); // duration (1s)
  moov.writeUInt32BE(0x00010000, 36); // rate 1.0
  moov.writeUInt16BE(0x0100, 40); // volume 1.0
  moov.writeUInt32BE(0x00010000, 52); // matrix
  moov.writeUInt32BE(0x00010000, 68);
  moov.writeUInt32BE(0x40000000, 84);
  moov.writeUInt32BE(2, 112); // next_track_ID

  const content = Buffer.concat([ftyp, freeBox, mdat, moov]);
  fs.writeFileSync(filePath, content);

  return {
    dir,
    filePath,
    size: content.length,
    cleanup() {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    },
  };
}

export function createTempPathWithExtension(filename, content = 'e2e test placeholder') {
  const baseTmp = process.env.E2E_TMP_DIR || os.tmpdir();
  fs.mkdirSync(baseTmp, { recursive: true });
  const dir = fs.mkdtempSync(path.join(baseTmp, 'mmw-e2e-bad-'));
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, content, 'utf8');
  return {
    dir,
    filePath,
    cleanup() {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

export async function cleanupSauFile(baseUrl, id) {
  if (!id) return;
  try {
    await httpRaw(`${baseUrl}/api/sau/files/${encodeURIComponent(String(id))}`, {
      method: 'DELETE',
      timeoutMs: 10000,
    });
  } catch {
    // ignore cleanup errors
  }
}

export async function cleanupBoardItem(baseUrl, id) {
  if (!id) return;
  try {
    await httpRaw(`${baseUrl}/api/radar/board/${encodeURIComponent(String(id))}`, {
      method: 'DELETE',
      timeoutMs: 10000,
    });
  } catch {
    // ignore cleanup errors
  }
}

export function runCommandSync(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd || PROJECT_ROOT,
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 60000,
    env: { ...process.env, ...(opts.env || {}) },
    windowsHide: true,
  });
  return {
    status: res.status ?? (res.error ? 1 : 0),
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    error: res.error || null,
  };
}

export class McpStdioClient {
  constructor(scriptPath = MCP_SCRIPT_PATH, env = {}) {
    this.scriptPath = scriptPath;
    this.env = env;
    this.proc = null;
    this.pending = new Map();
    this.nextId = 1;
    this.stderrChunks = [];
  }

  start() {
    if (!fs.existsSync(this.scriptPath)) {
      throw new Error(`MCP script not found: ${this.scriptPath}`);
    }
    this.proc = spawn(NODE_EXE, [this.scriptPath], {
      cwd: PROJECT_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.env },
      windowsHide: true,
    });
    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const msg = JSON.parse(trimmed);
        if (msg && msg.id !== undefined && msg.id !== null && this.pending.has(msg.id)) {
          const entry = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          clearTimeout(entry.timer);
          entry.resolve(msg);
        }
      } catch {
        // ignore non-JSON diagnostic lines if any
      }
    });
    this.proc.stderr.on('data', (chunk) => {
      this.stderrChunks.push(chunk.toString('utf8'));
    });
    this.proc.on('exit', (code) => {
      for (const [id, entry] of this.pending.entries()) {
        clearTimeout(entry.timer);
        entry.reject(new Error(`MCP exited (code=${code}) before responding to id=${id}`));
        this.pending.delete(id);
      }
    });
  }

  sendRawLine(line) {
    if (!this.proc || !this.proc.stdin.writable) {
      throw new Error('MCP stdin is not writable');
    }
    this.proc.stdin.write(line.endsWith('\n') ? line : `${line}\n`);
  }

  request(method, params, timeoutMs = 20000) {
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method };
    if (params !== undefined) payload.params = params;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timeout (${timeoutMs}ms): ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.sendRawLine(JSON.stringify(payload));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  notify(method, params) {
    const payload = { jsonrpc: '2.0', method };
    if (params !== undefined) payload.params = params;
    this.sendRawLine(JSON.stringify(payload));
  }

  async initialize() {
    const res = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mmw-e2e-suite', version: '1.0.0' },
    });
    this.notify('notifications/initialized');
    return res;
  }

  async close() {
    if (!this.proc) return;
    try {
      this.proc.stdin.end();
    } catch {
      // ignore
    }
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        try {
          this.proc?.kill('SIGKILL');
        } catch {
          // ignore
        }
        resolve();
      }, 800);
      this.proc.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
    this.proc = null;
  }
}

export function parseMcpToolJson(callResp) {
  const content = callResp?.result?.content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const textPart = content.find((c) => c?.type === 'text' && typeof c?.text === 'string');
  if (!textPart) return null;
  try {
    return JSON.parse(textPart.text);
  } catch {
    return textPart.text;
  }
}

export function getMcpCallText(callResp) {
  const content = callResp?.result?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c?.type === 'text' && typeof c?.text === 'string')
    .map((c) => c.text)
    .join('\n');
}

export function throwIfMcpOfflineOrPreM3(ctx, callResp, label = 'MCP tool') {
  if (!ctx?.offlineCheck) return;
  if (callResp?.result?.isError !== true) return;
  const text = getMcpCallText(callResp);
  if (
    /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|无法连接本地媒体工作台|HTTP 404|Route .* not found/i.test(
      text
    )
  ) {
    throw new PendingLiveError(`${label} requires live M3 workbench/routes in offline-check: ${text}`);
  }
}

export function listFilesRecursive(dir, extFilter) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(full, extFilter));
    } else if (!extFilter || extFilter(full)) {
      out.push(full);
    }
  }
  return out;
}

export function scanCssCompliance(projectRoot = PROJECT_ROOT) {
  const violations = [];
  const srcStyles = path.join(projectRoot, 'frontend', 'src', 'styles.css');
  const distIndexHtml = path.join(projectRoot, 'frontend', 'dist', 'index.html');
  const distAssetsDir = path.join(projectRoot, 'frontend', 'dist', 'assets');
  const tsxFiles = listFilesRecursive(path.join(projectRoot, 'frontend', 'src'), (f) => /\.(tsx|ts|css)$/.test(f));
  let distCssFiles = [];
  if (fs.existsSync(distIndexHtml)) {
    const html = fs.readFileSync(distIndexHtml, 'utf8');
    const refs = [...html.matchAll(/href=["']\/?(assets\/[^"']+\.css)["']/gi)].map((m) =>
      path.join(projectRoot, 'frontend', 'dist', m[1])
    );
    distCssFiles = refs.filter((p) => fs.existsSync(p));
  }
  if (distCssFiles.length === 0) {
    distCssFiles = listFilesRecursive(distAssetsDir, (f) => /\.css$/i.test(f));
  }

  const borderLeft3PxRe =
    /(?:border-left(?:-width)?|border-inline-start(?:-width)?)\s*:[^;}\r\n]*?(?<![0-9.])3px\b/i;
  const inlineBorderLeft3PxRe =
    /(?:borderLeft|borderInlineStart)\s*:\s*(['"`])(?:(?!\1)[^;\r\n])*?(?<![0-9.])3px\b(?:(?!\1)[^;\r\n])*\1|borderLeftWidth\s*:\s*(?:(['"`])\s*3px\s*\2|(?<![0-9.])3(?![0-9.]))/i;
  const nestedCardRuleRe =
    /(?:\.card|\.stat-card|\.panel)(?:\s*>\s*|\s+)(?:\.card|\.stat-card|\.panel)[^{]*\{([^}]*)\}/gi;

  for (const file of [...tsxFiles, ...distCssFiles]) {
    const content = fs.readFileSync(file, 'utf8');
    if (borderLeft3PxRe.test(content) || inlineBorderLeft3PxRe.test(content)) {
      violations.push(`border-left: 3px violation in ${path.relative(projectRoot, file)}`);
    }
    if (/\.css$/i.test(file)) {
      for (const m of content.matchAll(nestedCardRuleRe)) {
        const block = (m[1] || '').replace(/\/\*[\s\S]*?\*\//g, '');
        let hasBorderShorthand = false;
        let hasBorderWidth = false;
        let hasBorderStyle = false;
        for (const decl of block.split(';')) {
          const colonIdx = decl.indexOf(':');
          if (colonIdx === -1) continue;
          const prop = decl.slice(0, colonIdx).trim().toLowerCase();
          const val = decl
            .slice(colonIdx + 1)
            .replace(/!important/gi, '')
            .trim()
            .toLowerCase();
          if (!val) continue;
          if (/^border(?:-top|-right|-bottom|-left|-inline|-block)?$/.test(prop)) {
            if (!/^(?:none|0(?:px|em|rem)?(?:\s+(?:none|solid|dashed|dotted|transparent))*)$/.test(val)) {
              hasBorderShorthand = true;
            }
          } else if (prop === 'border-width') {
            if (!/^(?:0(?:px|em|rem)?\s*)+$/.test(val)) {
              hasBorderWidth = true;
            }
          } else if (prop === 'border-style') {
            if (!/^(?:none\s*)+$/.test(val)) {
              hasBorderStyle = true;
            }
          }
        }
        if (hasBorderShorthand || (hasBorderWidth && hasBorderStyle)) {
          violations.push(`Nested bordered card selector violation in ${path.relative(projectRoot, file)}`);
          break;
        }
      }
    }
  }

  let lightVarsPresent = false;
  if (fs.existsSync(srcStyles)) {
    const css = fs.readFileSync(srcStyles, 'utf8');
    lightVarsPresent = /--bg\s*:\s*#f1f5f9/i.test(css) && /--surface\s*:\s*#ffffff/i.test(css);
  }

  return {
    ok: violations.length === 0 && lightVarsPresent,
    lightVarsPresent,
    scannedFiles: tsxFiles.length + distCssFiles.length,
    violations,
  };
}

/**
 * Scans text for potential plaintext API keys or raw Cookie strings.
 * Returns sanitized finding descriptions (never echoing secret values!).
 */
export function scanForSecrets(text, label = 'payload') {
  const s = String(text || '');
  const findings = [];
  const patterns = [
    { name: 'OpenAI/Proxy API Key (sk-...)', re: /\bsk-[A-Za-z0-9_-]{10,}\b/ },
    { name: 'CPA/Proxy API Key (cpa-key-...)', re: /\bcpa-key-[A-Za-z0-9_-]{6,}\b/i },
    { name: 'Unmasked ai_api_key JSON value', re: /"ai_api_key"\s*:\s*"(?!\*+")[^"]{6,}"/i },
    { name: 'Google API Key (AIza...)', re: /\bAIza[0-9A-Za-z_-]{20,}\b/ },
    { name: 'Cookie SESSDATA literal', re: /\bSESSDATA=[A-Za-z0-9%._-]{10,}/i },
    { name: 'Cookie sessionid literal', re: /\bsessionid=[A-Za-z0-9%._-]{10,}/i },
    { name: 'Cookie bili_jct literal', re: /\bbili_jct=[A-Za-z0-9%._-]{10,}/i },
    { name: 'Cookie web_session (XHS) literal', re: /\bweb_session=[A-Za-z0-9%._-]{8,}/i },
    { name: 'Cookie a1 (XHS) literal', re: /\ba1=[A-Za-z0-9%._-]{8,}/i },
    { name: 'Cookie ttwid (Douyin) literal', re: /\bttwid=[A-Za-z0-9%._-]{8,}/i },
    { name: 'Cookie odin_tt (Douyin) literal', re: /\bodin_tt=[A-Za-z0-9%._-]{8,}/i },
    { name: 'Raw cookies array dump', re: /"cookies"\s*:\s*\[\s*\{[^}]*"value"\s*:\s*"(?!\*+")[^"]{12,}"/i },
    {
      name: 'Raw cookies dict dump',
      re: /"cookies"\s*:\s*\{[^}]*"(?:SESSDATA|sessionid|bili_jct|web_session|a1|ttwid|odin_tt)"\s*:\s*"(?!\*+")[^"]{8,}"/i,
    },
  ];
  for (const p of patterns) {
    if (p.re.test(s)) {
      findings.push(`${label}: detected ${p.name}`);
    }
  }
  return findings;
}

export function parseTimestampUtcMs(ts) {
  if (!ts) return 0;
  const s = String(ts).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(s)) {
    return new Date(`${s.replace(' ', 'T')}Z`).getTime();
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(s)) {
    return new Date(`${s}Z`).getTime();
  }
  return new Date(s).getTime();
}

export function assertSortedNewestFirst(items, contextLabel = 'items') {
  for (let i = 0; i < items.length - 1; i++) {
    const a = items[i];
    const b = items[i + 1];
    const ta = a.published_at || a.discovered_at || '';
    const tb = b.published_at || b.discovered_at || '';
    const msA = parseTimestampUtcMs(ta);
    const msB = parseTimestampUtcMs(tb);
    assert.ok(
      msA >= msB,
      `${contextLabel}[${i}] timestamp (${ta}) must be >= [${i + 1}] (${tb})`
    );
    if (msA === msB && a.id !== undefined && b.id !== undefined) {
      assert.ok(
        Number(a.id) > Number(b.id),
        `${contextLabel}[${i}] tie-break id (${a.id}) must be > [${i + 1}] id (${b.id})`
      );
    }
  }
}

export function parseSkillFrontmatter(mdText) {
  const normalized = mdText.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return { valid: false, reason: 'Missing opening YAML frontmatter ---' };
  }
  const endIdx = normalized.indexOf('\n---\n', 4);
  if (endIdx === -1) {
    return { valid: false, reason: 'Missing closing YAML frontmatter ---' };
  }
  const yamlBlock = normalized.slice(4, endIdx);
  const body = normalized.slice(endIdx + 5);
  const fields = {};
  let currentKey = null;
  for (const line of yamlBlock.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (m) {
      currentKey = m[1];
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      fields[currentKey] = val;
    } else if (currentKey && /^\s+/.test(line)) {
      fields[currentKey] = `${fields[currentKey] || ''} ${line.trim()}`.trim();
    }
  }
  return { valid: true, fields, body };
}

export async function pickCreatorAndContentIds(ctx) {
  const res = await httpJson(ctx, `${ctx.baseUrl}/api/radar/creators/feed?days=0&limit=50`);
  if (res.status !== 200 || !res.json) {
    pendingIfOffline(ctx, `GET /api/radar/creators/feed failed with status ${res.status}`);
  }
  const feed = res.json;
  const creators = Array.isArray(feed.creators) ? feed.creators : [];
  const items = Array.isArray(feed.items) ? feed.items : [];
  const creatorOnly = creators.filter((c) => c.source_type === 'creator');
  const activeCreators = creatorOnly.length > 0 ? creatorOnly : creators.filter((c) => c.platform !== 'rss');
  const biliCreator = activeCreators.find((c) => c.platform === 'bilibili') || null;
  const douyinCreator = activeCreators.find((c) => c.platform === 'douyin') || null;
  const biliItems = items.filter((it) => it.platform === 'bilibili');
  const douyinItems = items.filter((it) => it.platform === 'douyin');
  return {
    feed,
    creators: activeCreators,
    allCreators: creators,
    items,
    biliCreator,
    douyinCreator,
    biliItems,
    douyinItems,
  };
}
