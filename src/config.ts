import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');

// 轻量零依赖加载同目录 .env（不覆盖已显式设置的系统环境变量）
function loadDotEnvIfPresent(): void {
  const envFile = path.join(PROJECT_ROOT, '.env');
  if (!fs.existsSync(envFile)) return;
  try {
    const lines = fs.readFileSync(envFile, 'utf8').split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key && process.env[key] === undefined) {
        process.env[key] = val;
      }
    }
  } catch {
    // ignore malformed .env
  }
}
loadDotEnvIfPresent();

export const HOST = process.env.MMW_HOST || '0.0.0.0';
export const PORT = Number(process.env.MMW_PORT || 18910);

// 跨电脑自动探测 MediaCrawler（优先环境变量 -> 仓库内 ./tools/MediaCrawler -> 常见本机目录）
function resolveDefaultMediaCrawlerDir(): string {
  if (process.env.MMW_MEDIACRAWLER_DIR) return process.env.MMW_MEDIACRAWLER_DIR;
  const bundled = path.join(PROJECT_ROOT, 'tools', 'MediaCrawler');
  if (fs.existsSync(path.join(bundled, 'main.py'))) return bundled;
  const legacyLocal = 'E:\\app\\评论爬取';
  if (fs.existsSync(path.join(legacyLocal, 'main.py'))) return legacyLocal;
  return bundled;
}

// 跨电脑自动探测通义听悟脚本（优先环境变量 -> 仓库内置 ./tools/tingwu-web-batch）
function resolveDefaultTingwuDir(): string {
  if (process.env.MMW_TINGWU_DIR) return process.env.MMW_TINGWU_DIR;
  return path.join(PROJECT_ROOT, 'tools', 'tingwu-web-batch');
}

// 仅当本机存在本地中转配置时可选探测，换新电脑不存在时绝不报错
function resolveOptionalLocalProxyConfig(): string {
  if (process.env.MMW_CLIPROXY_CONFIG) return process.env.MMW_CLIPROXY_CONFIG;
  const desktop = path.join(os.homedir(), 'Desktop');
  if (fs.existsSync(desktop)) {
    try {
      const candidates = fs
        .readdirSync(desktop, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^CLIProxyAPI/i.test(entry.name))
        .map((entry) => ({
          name: entry.name,
          cfg: path.join(desktop, entry.name, 'config.yaml'),
          isBackup: /backup|bak/i.test(entry.name),
          isTest: /test/i.test(entry.name),
        }))
        .filter((item) => fs.existsSync(item.cfg))
        .sort((a, b) => {
          const score = (x: typeof a) => (x.isBackup ? 2 : x.isTest ? 1 : 0);
          if (score(a) !== score(b)) return score(a) - score(b);
          return b.name.localeCompare(a.name);
        });
      if (candidates.length > 0) return candidates[0].cfg;
    } catch {
      // ignore
    }
  }
  return '';
}

export const PATHS = {
  dataDir: path.join(PROJECT_ROOT, 'data'),
  dbFile: process.env.MMW_DB_PATH || path.join(PROJECT_ROOT, 'data', 'workbench.db'),
  profilesRoot: path.join(PROJECT_ROOT, 'browser-profiles'),
  logsDir: path.join(PROJECT_ROOT, 'logs'),
  backupsDir: path.join(PROJECT_ROOT, 'backups'),
  audioDir: path.join(PROJECT_ROOT, 'data', 'audio'),
  transcriptsDir: path.join(PROJECT_ROOT, 'data', 'transcripts'),
  frontendDist: path.join(PROJECT_ROOT, 'frontend', 'dist'),
  defaultMediaCrawlerDir: resolveDefaultMediaCrawlerDir(),
  defaultTingwuDir: resolveDefaultTingwuDir(),
  defaultCliProxyConfig: resolveOptionalLocalProxyConfig(),
};

export const PLATFORM_PROFILES = ['douyin', 'bilibili', 'kuaishou', 'wechat-channels', 'x', 'youtube', 'other'] as const;
export type ProfilePlatform = (typeof PLATFORM_PROFILES)[number];

export function ensureProjectDirs(): void {
  for (const dir of [PATHS.dataDir, PATHS.profilesRoot, PATHS.logsDir, PATHS.backupsDir, PATHS.audioDir, PATHS.transcriptsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  for (const p of PLATFORM_PROFILES) {
    fs.mkdirSync(path.join(PATHS.profilesRoot, p), { recursive: true });
  }
}

export function getSafeProfileDir(platform: ProfilePlatform): string {
  const target = path.resolve(PATHS.profilesRoot, platform);
  const rootResolved = path.resolve(PATHS.profilesRoot);
  if (!target.startsWith(rootResolved + path.sep)) {
    throw new Error(`Unsafe browser profile path rejected: ${target}`);
  }
  // Explicit guard against touching daily Chrome User Data
  const lower = target.toLowerCase();
  if (lower.includes('google\\chrome\\user data') || lower.includes('google/chrome/user data')) {
    throw new Error('Forbidden: cannot touch daily Chrome User Data directory.');
  }
  fs.mkdirSync(target, { recursive: true });
  return target;
}

export function resolveChromiumExecutable(): string | undefined {
  if (process.env.MMW_CHROMIUM_PATH && fs.existsSync(process.env.MMW_CHROMIUM_PATH)) {
    return process.env.MMW_CHROMIUM_PATH;
  }
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return undefined;
  const msPlaywright = path.join(localAppData, 'ms-playwright');
  if (!fs.existsSync(msPlaywright)) return undefined;

  const dirs = fs
    .readdirSync(msPlaywright, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^chromium-\d+$/.test(d.name))
    .map((d) => ({
      name: d.name,
      num: Number(d.name.replace('chromium-', '')),
    }))
    .sort((a, b) => b.num - a.num);

  for (const d of dirs) {
    const exe = path.join(msPlaywright, d.name, 'chrome-win64', 'chrome.exe');
    if (fs.existsSync(exe)) return exe;
  }

  // 新电脑若尚未下载 Playwright Chromium 缓存，自动回退复用本机已安装的 Chrome/Edge 程序本体
  // （仍严格运行在独立 browser-profiles/ 配置目录中，绝不触碰日常浏览器数据）
  const systemBrowsers = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  for (const exe of systemBrowsers) {
    if (fs.existsSync(exe)) return exe;
  }
  return undefined;
}
