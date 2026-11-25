import fs from 'node:fs';
import path from 'node:path';

export const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
export const HOST = '0.0.0.0';
export const PORT = Number(process.env.MMW_PORT || 18910);

export const PATHS = {
  dataDir: path.join(PROJECT_ROOT, 'data'),
  dbFile: process.env.MMW_DB_PATH || path.join(PROJECT_ROOT, 'data', 'workbench.db'),
  profilesRoot: path.join(PROJECT_ROOT, 'browser-profiles'),
  logsDir: path.join(PROJECT_ROOT, 'logs'),
  backupsDir: path.join(PROJECT_ROOT, 'backups'),
  audioDir: path.join(PROJECT_ROOT, 'data', 'audio'),
  transcriptsDir: path.join(PROJECT_ROOT, 'data', 'transcripts'),
  frontendDist: path.join(PROJECT_ROOT, 'frontend', 'dist'),
  // 本机已有的外部工具路径（通过子进程无端口直接集成）
  defaultMediaCrawlerDir: process.env.MMW_MEDIACRAWLER_DIR || 'E:\\app\\评论爬取',
  defaultTingwuDir: process.env.MMW_TINGWU_DIR || 'E:\\工程项目\\codex项目合集\\个人用\\tingwu-web-batch',
  defaultCliProxyConfig: 'C:\\Users\\win10\\Desktop\\CLIProxyAPI_7.0.2_windows_amd64\\config.yaml',
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
  return undefined;
}
