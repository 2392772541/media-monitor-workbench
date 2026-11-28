import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { BrowserContext, Cookie } from 'playwright';
import type { ProfilePlatform } from '../config.js';
import { resolveSauDir } from './sauBridge.js';
import { log } from '../utils/logger.js';

interface PlatformCookieSpec {
  sauType: number;
  domainPattern: RegExp;
  authCookieNames: string[];
  label: string;
}

const PLATFORM_SPECS: Partial<Record<ProfilePlatform, PlatformCookieSpec>> = {
  douyin: {
    sauType: 3,
    domainPattern: /(?:^|\.)douyin\.com$/i,
    authCookieNames: ['sessionid', 'sessionid_ss', 'sid_guard', 'uid_tt'],
    label: '抖音',
  },
  kuaishou: {
    sauType: 4,
    domainPattern: /(?:^|\.)kuaishou\.com$/i,
    authCookieNames: ['userId', 'kuaishou.server.web_st', 'passToken'],
    label: '快手',
  },
  'wechat-channels': {
    sauType: 2,
    domainPattern: /(?:^|\.)weixin\.qq\.com$/i,
    authCookieNames: ['sessionid', 'wxuin'],
    label: '微信视频号',
  },
  bilibili: {
    sauType: 5,
    domainPattern: /(?:^|\.)bilibili\.com$/i,
    authCookieNames: ['SESSDATA', 'bili_jct'],
    label: 'B站',
  },
};

export interface SanitizedCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export function isSauSyncSupportedPlatform(platform: string): platform is ProfilePlatform {
  return Boolean(PLATFORM_SPECS[platform as ProfilePlatform]);
}

// 检查给定 Cookie 集合里是否存在未过期的真实登录态凭证
export function hasActiveAuthCookies(
  platform: ProfilePlatform,
  cookies: Array<{ name: string; value?: string; domain?: string; expires?: number }>
): boolean {
  const spec = PLATFORM_SPECS[platform];
  if (!spec) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  return cookies.some((c) => {
    if (!spec.authCookieNames.includes(c.name)) return false;
    if (!c.value || !String(c.value).trim()) return false;
    if (c.domain && !spec.domainPattern.test(c.domain)) return false;
    if (typeof c.expires === 'number' && c.expires > 0 && c.expires <= nowSec + 60) return false;
    return true;
  });
}

function normalizeSameSite(raw: unknown): 'Strict' | 'Lax' | 'None' | undefined {
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'strict') return 'Strict';
  if (s === 'lax') return 'Lax';
  if (s === 'none') return 'None';
  return undefined;
}

export function filterValidPlatformCookies(
  platform: ProfilePlatform,
  rawCookies: unknown
): SanitizedCookie[] {
  const spec = PLATFORM_SPECS[platform];
  if (!spec || !Array.isArray(rawCookies)) return [];
  const nowSec = Math.floor(Date.now() / 1000);
  const out: SanitizedCookie[] = [];

  for (const item of rawCookies) {
    if (!item || typeof item !== 'object') continue;
    const c = item as Record<string, unknown>;
    const name = String(c.name || '').trim();
    const value = String(c.value || '');
    const domain = String(c.domain || '').trim();
    if (!name || !value || !domain || !spec.domainPattern.test(domain)) continue;
    const expires = typeof c.expires === 'number' && Number.isFinite(c.expires) ? c.expires : undefined;
    if (expires && expires > 0 && expires <= nowSec + 60) continue;

    const clean: SanitizedCookie = {
      name,
      value,
      domain,
      path: String(c.path || '/'),
      httpOnly: Boolean(c.httpOnly),
      secure: Boolean(c.secure),
    };
    if (expires && expires > 0) clean.expires = expires;
    const ss = normalizeSameSite(c.sameSite);
    if (ss) clean.sameSite = ss;
    out.push(clean);
  }
  return out;
}

// 从「视频发布」(sau-engine) 中安全读取指定平台的最新有效登录凭证（绝不打印任何明文值）
export function loadLatestSauPlatformCookies(platform: ProfilePlatform): {
  found: boolean;
  accountName?: string;
  cookieCount: number;
  cookies: SanitizedCookie[];
  reason?: string;
} {
  const spec = PLATFORM_SPECS[platform];
  if (!spec) {
    return { found: false, cookieCount: 0, cookies: [], reason: '该平台暂不支持从视频发布同步' };
  }

  const sauDir = resolveSauDir();
  const sauDbPath = path.join(sauDir, 'db', 'database.db');
  const cookiesDir = path.join(sauDir, 'cookiesFile');
  if (!fs.existsSync(sauDbPath) || !fs.existsSync(cookiesDir)) {
    return { found: false, cookieCount: 0, cookies: [], reason: '未检测到视频发布引擎账号库' };
  }

  let sauDb: DatabaseSync | null = null;
  try {
    sauDb = new DatabaseSync(sauDbPath, { readOnly: true });
    const rows = sauDb
      .prepare('SELECT id, type, filePath, userName, status FROM user_info WHERE type = ? AND status = 1 ORDER BY id DESC')
      .all(spec.sauType) as Array<{ id: number; type: number; filePath: string; userName: string; status: number }>;

    if (rows.length === 0) {
      return {
        found: false,
        cookieCount: 0,
        cookies: [],
        reason: `「视频发布」里还没有处于正常状态的${spec.label}登录账号`,
      };
    }

    for (const row of rows) {
      const fp = path.isAbsolute(row.filePath) ? row.filePath : path.join(cookiesDir, row.filePath);
      if (!fs.existsSync(fp)) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(fp, 'utf8')) as { cookies?: unknown[] };
        const validCookies = filterValidPlatformCookies(platform, parsed.cookies || []);
        if (hasActiveAuthCookies(platform, validCookies)) {
          return {
            found: true,
            accountName: row.userName || `${spec.label}账号#${row.id}`,
            cookieCount: validCookies.length,
            cookies: validCookies,
          };
        }
      } catch {
        // 单个文件损坏时尝试下一个账号
      }
    }

    return {
      found: false,
      cookieCount: 0,
      cookies: [],
      reason: `「视频发布」中的${spec.label}登录凭证已过期或不含主站登录项，请先在视频发布中重新扫码`,
    };
  } catch (err) {
    return { found: false, cookieCount: 0, cookies: [], reason: `读取视频发布账号失败: ${(err as Error).message}` };
  } finally {
    try {
      sauDb?.close();
    } catch {
      // ignore
    }
  }
}

/**
 * 将「视频发布」中有效的登录态自动注入并持久化保存到独立采集浏览器上下文：
 * - 若独立浏览器本身已有未过期的真实登录态且未要求强制覆盖，直接跳过；
 * - 若独立浏览器处于游客态或已过期，自动拉取视频发布最新凭证写入持久化配置目录。
 */
export async function syncSauCookiesToContext(
  platform: ProfilePlatform,
  context: BrowserContext,
  force = false
): Promise<{
  synced: boolean;
  alreadyLoggedIn?: boolean;
  accountName?: string;
  cookieCount?: number;
  message: string;
}> {
  const spec = PLATFORM_SPECS[platform];
  if (!spec) {
    return { synced: false, message: '该平台无需从视频发布同步' };
  }

  try {
    if (!force) {
      const existing = (await context.cookies()) as Cookie[];
      if (hasActiveAuthCookies(platform, existing)) {
        return { synced: false, alreadyLoggedIn: true, message: `${spec.label}采集浏览器已处于登录状态` };
      }
    }

    const loaded = loadLatestSauPlatformCookies(platform);
    if (!loaded.found || loaded.cookies.length === 0) {
      return { synced: false, message: loaded.reason || `未在视频发布中找到有效${spec.label}登录态` };
    }

    await context.addCookies(loaded.cookies);
    log(
      'INFO',
      'cookie-sync',
      `已自动复用「视频发布」${spec.label}登录态（账号: ${loaded.accountName}，同步 ${loaded.cookieCount} 项凭证并持久化）`
    );
    return {
      synced: true,
      accountName: loaded.accountName,
      cookieCount: loaded.cookieCount,
      message: `已将「视频发布」中的${spec.label}账号（${loaded.accountName}）登录态同步并保存到采集浏览器`,
    };
  } catch (err) {
    const msg = (err as Error).message;
    log('WARN', 'cookie-sync', `同步 ${platform} 登录态失败: ${msg}`);
    return { synced: false, message: `同步登录态失败: ${msg}` };
  }
}
