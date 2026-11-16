import { chromium, type BrowserContext } from 'playwright';
import { getSafeProfileDir, resolveChromiumExecutable, type ProfilePlatform } from '../config.js';
import { getDb } from '../db/database.js';
import { log } from '../utils/logger.js';

interface LockEntry {
  mode: 'headless' | 'headed';
  owner: string;
  startedAt: string;
  context: BrowserContext | null;
}

const activeLocks = new Map<ProfilePlatform, LockEntry>();

export const PLATFORM_LOGIN_URLS: Record<ProfilePlatform, string> = {
  douyin: 'https://www.douyin.com/',
  kuaishou: 'https://www.kuaishou.com/',
  'wechat-channels': 'https://channels.weixin.qq.com/',
  x: 'https://x.com/i/flow/login',
  youtube: 'https://www.youtube.com/',
  other: 'about:blank',
};

export function getProfileLockInfo(platform: ProfilePlatform) {
  const lock = activeLocks.get(platform);
  if (!lock) return { locked: false, mode: null, owner: null, startedAt: null };
  return { locked: true, mode: lock.mode, owner: lock.owner, startedAt: lock.startedAt };
}

export function listBrowserProfilesWithRuntime() {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM browser_profiles ORDER BY platform ASC').all() as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const platform = String(row.platform) as ProfilePlatform;
    const lock = getProfileLockInfo(platform);
    return {
      ...row,
      is_running: lock.locked,
      running_mode: lock.mode,
      running_owner: lock.owner,
      running_started_at: lock.startedAt,
    };
  });
}

function touchProfileUsage(platform: ProfilePlatform) {
  try {
    const db = getDb();
    db.prepare('UPDATE browser_profiles SET last_used_at = ? WHERE platform = ?').run(new Date().toISOString(), platform);
  } catch {
    // ignore
  }
}

export function updateProfileStatus(
  platform: ProfilePlatform,
  updates: { login_status?: string; capability_status?: string; needs_attention?: number; note?: string }
) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE browser_profiles SET
      login_status = COALESCE(?, login_status),
      capability_status = COALESCE(?, capability_status),
      needs_attention = COALESCE(?, needs_attention),
      note = COALESCE(?, note),
      last_checked_at = ?
    WHERE platform = ?
  `).run(
    updates.login_status ?? null,
    updates.capability_status ?? null,
    updates.needs_attention ?? null,
    updates.note ?? null,
    now,
    platform
  );
}

export async function openLoginWindow(platform: ProfilePlatform, customUrl?: string): Promise<{ started: boolean; message: string }> {
  const existing = activeLocks.get(platform);
  if (existing) {
    if (existing.mode === 'headed' && existing.context) {
      const pages = existing.context.pages();
      if (pages[0]) {
        await pages[0].bringToFront().catch(() => {});
      }
      return { started: true, message: `已激活当前 ${platform} 的独立登录窗口` };
    }
    return { started: false, message: `当前 ${platform} 配置文件正在被后台采集任务使用（${existing.owner}），请稍候再试` };
  }

  const profileDir = getSafeProfileDir(platform);
  const executablePath = resolveChromiumExecutable();
  const lockEntry: LockEntry = {
    mode: 'headed',
    owner: 'manual-login',
    startedAt: new Date().toISOString(),
    context: null,
  };
  activeLocks.set(platform, lockEntry);

  try {
    const context = await chromium.launchPersistentContext(profileDir, {
      executablePath,
      headless: false,
      viewport: { width: 1280, height: 820 },
      args: ['--no-first-run', '--no-default-browser-check'],
    });
    lockEntry.context = context;
    touchProfileUsage(platform);
    log('INFO', 'browser', `Opened visible login window for ${platform} at ${profileDir}`);

    context.on('close', () => {
      activeLocks.delete(platform);
      log('INFO', 'browser', `Visible login window closed for ${platform}`);
    });

    const page = context.pages()[0] || (await context.newPage());
    const targetUrl = customUrl || PLATFORM_LOGIN_URLS[platform] || 'about:blank';
    if (targetUrl !== 'about:blank') {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((err) => {
        log('WARN', 'browser', `Initial navigation warning for ${platform}: ${err.message}`);
      });
    }

    return { started: true, message: `已打开 ${platform} 独立登录窗口，请在窗口内完成扫码或登录，完成后关闭窗口并点击“检查登录状态”` };
  } catch (err) {
    activeLocks.delete(platform);
    const msg = (err as Error).message;
    log('ERROR', 'browser', `Failed to open login window for ${platform}: ${msg}`);
    throw new Error(`启动 ${platform} 独立登录窗口失败: ${msg}`);
  }
}

export async function closeLoginWindow(platform: ProfilePlatform): Promise<{ closed: boolean; message: string }> {
  const existing = activeLocks.get(platform);
  if (!existing || !existing.context) {
    activeLocks.delete(platform);
    return { closed: false, message: `${platform} 当前没有运行中的独立浏览器窗口` };
  }
  try {
    await existing.context.close();
  } catch {
    // force clear lock
  } finally {
    activeLocks.delete(platform);
  }
  return { closed: true, message: `已安全关闭 ${platform} 独立浏览器` };
}

export async function withHeadlessContext<T>(
  platform: ProfilePlatform,
  owner: string,
  fn: (context: BrowserContext) => Promise<T>,
  options?: { headless?: boolean }
): Promise<T> {
  const existing = activeLocks.get(platform);
  if (existing) {
    throw new Error(`PROFILE_LOCKED: ${platform} 浏览器配置正在被 [${existing.owner}] (${existing.mode}) 占用，禁止并发争抢`);
  }

  const profileDir = getSafeProfileDir(platform);
  const executablePath = resolveChromiumExecutable();
  const headless = options?.headless ?? true;
  const lockEntry: LockEntry = {
    mode: headless ? 'headless' : 'headed',
    owner,
    startedAt: new Date().toISOString(),
    context: null,
  };
  activeLocks.set(platform, lockEntry);

  let context: BrowserContext | null = null;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      executablePath,
      headless,
      viewport: { width: 1280, height: 800 },
      args: ['--no-first-run', '--no-default-browser-check', '--disable-gpu'],
    });
    lockEntry.context = context;
    touchProfileUsage(platform);
    return await fn(context);
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
    activeLocks.delete(platform);
  }
}

export async function closeAllBrowsers(): Promise<void> {
  for (const [platform, entry] of activeLocks.entries()) {
    if (entry.context) {
      log('INFO', 'browser', `Closing browser context for ${platform} during shutdown`);
      await entry.context.close().catch(() => {});
    }
    activeLocks.delete(platform);
  }
}
