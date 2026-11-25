import crypto from 'node:crypto';
import { withHeadlessContext, updateProfileStatus } from '../browser/profileManager.js';
import type {
  AuthorProfileSnapshot,
  AvailabilityResult,
  ExtractedContentItem,
  FetchResult,
  LoginCheckResult,
  PlatformAdapter,
  SourceRecord,
} from './types.js';

const BILI_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
  Referer: 'https://www.bilibili.com/',
  Origin: 'https://www.bilibili.com',
  Accept: 'application/json, text/plain, */*',
};

// B 站 WBI 签名混淆表
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38,
  41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];

let cachedWbi: { mixinKey: string; fetchedAt: number } | null = null;

async function fetchJson<T>(url: string, timeoutMs = 15000, cookie?: string): Promise<T | null> {
  try {
    const headers: Record<string, string> = { ...BILI_HEADERS };
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function getWbiMixinKey(cookie?: string): Promise<string | null> {
  if (cachedWbi && Date.now() - cachedWbi.fetchedAt < 30 * 60 * 1000) {
    return cachedWbi.mixinKey;
  }
  const nav = await fetchJson<{ data?: { wbi_img?: { img_url?: string; sub_url?: string } } }>(
    'https://api.bilibili.com/x/web-interface/nav',
    10000,
    cookie
  );
  const imgUrl = nav?.data?.wbi_img?.img_url || '';
  const subUrl = nav?.data?.wbi_img?.sub_url || '';
  const imgKey = imgUrl.slice(imgUrl.lastIndexOf('/') + 1).split('.')[0] || '';
  const subKey = subUrl.slice(subUrl.lastIndexOf('/') + 1).split('.')[0] || '';
  const raw = imgKey + subKey;
  if (raw.length < 32) return null;
  const mixinKey = MIXIN_KEY_ENC_TAB.map((i) => raw[i] || '').join('').slice(0, 32);
  cachedWbi = { mixinKey, fetchedAt: Date.now() };
  return mixinKey;
}

function signWbiParams(params: Record<string, string | number>, mixinKey: string): string {
  const wts = Math.floor(Date.now() / 1000);
  const full: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...params, wts })) {
    full[k] = String(v).replace(/[!'()*]/g, '');
  }
  const query = Object.keys(full)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(full[k])}`)
    .join('&');
  const wRid = crypto.createHash('md5').update(query + mixinKey).digest('hex');
  return `${query}&w_rid=${wRid}`;
}

export async function extractBiliMid(rawUrl: string): Promise<string | null> {
  const spaceMatch = rawUrl.match(/space\.bilibili\.com\/(\d+)/i);
  if (spaceMatch) return spaceMatch[1];

  const bvMatch = rawUrl.match(/\/video\/(BV[a-zA-Z0-9]+)/i);
  if (bvMatch) {
    const view = await fetchJson<{ code?: number; data?: { owner?: { mid?: number } } }>(
      `https://api.bilibili.com/x/web-interface/view?bvid=${bvMatch[1]}`
    );
    if (view?.code === 0 && view.data?.owner?.mid) {
      return String(view.data.owner.mid);
    }
  }
  return null;
}

interface BiliCardResp {
  code?: number;
  data?: {
    card?: {
      mid?: string;
      name?: string;
      face?: string;
      sign?: string;
      fans?: number;
    };
    follower?: number;
  };
}

async function fetchBiliAuthorProfile(mid: string, cookie?: string): Promise<AuthorProfileSnapshot & { name?: string }> {
  const [cardRes, statRes] = await Promise.all([
    fetchJson<BiliCardResp>(`https://api.bilibili.com/x/web-interface/card?mid=${mid}`, 10000, cookie),
    fetchJson<{ code?: number; data?: { follower?: number } }>(
      `https://api.bilibili.com/x/relation/stat?vmid=${mid}`,
      10000,
      cookie
    ),
  ]);
  const card = cardRes?.data?.card;
  const followerCount =
    typeof statRes?.data?.follower === 'number'
      ? statRes.data.follower
      : typeof cardRes?.data?.follower === 'number'
        ? cardRes.data.follower
        : typeof card?.fans === 'number'
          ? card.fans
          : null;
  return {
    name: card?.name || undefined,
    followerCount,
    avatarUrl: card?.face || '',
    bio: card?.sign || '',
  };
}

interface BiliViewResp {
  code?: number;
  data?: {
    bvid?: string;
    title?: string;
    desc?: string;
    pic?: string;
    pubdate?: number;
    tname?: string;
    owner?: { name?: string; mid?: number };
    stat?: {
      view?: number;
      like?: number;
      reply?: number;
      favorite?: number;
      share?: number;
      coin?: number;
    };
  };
}

// 用公开 view 接口补齐精准三连互动数据（播放/点赞/评论/收藏/转发）
async function enrichBvidMetrics(bvid: string, cookie?: string): Promise<ExtractedContentItem | null> {
  const res = await fetchJson<BiliViewResp>(
    `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
    10000,
    cookie
  );
  if (res?.code !== 0 || !res.data?.bvid) return null;
  const d = res.data;
  const st = d.stat || {};
  return {
    platformItemId: d.bvid,
    url: `https://www.bilibili.com/video/${d.bvid}`,
    title: (d.title || '').trim() || `B站视频 ${d.bvid}`,
    author: d.owner?.name || '',
    summary: (d.desc || d.title || '').trim().slice(0, 500),
    body: (d.desc || d.title || '').trim(),
    coverUrl: d.pic ? (d.pic.startsWith('//') ? `https:${d.pic}` : d.pic) : '',
    tags: d.tname ? [d.tname] : [],
    publishedAt: d.pubdate ? new Date(d.pubdate * 1000).toISOString() : null,
    contentType: 'video',
    metrics: {
      views: typeof st.view === 'number' ? st.view : null,
      likes: typeof st.like === 'number' ? st.like : null,
      comments: typeof st.reply === 'number' ? st.reply : null,
      favorites: typeof st.favorite === 'number' ? st.favorite : null,
      shares: typeof st.share === 'number' ? st.share : null,
    },
    rawMeta: { bvid: d.bvid, tname: d.tname || '', coin: st.coin ?? null },
  };
}

export const bilibiliAdapter: PlatformAdapter = {
  platform: 'bilibili',
  displayName: 'B站 UP 主',
  profilePlatform: 'bilibili',
  defaultCapability: '已接入并验证',

  async checkLoginStatus(): Promise<LoginCheckResult> {
    try {
      const loggedIn = await withHeadlessContext('bilibili', 'login-check', async (ctx) => {
        const page = ctx.pages()[0] || (await ctx.newPage());
        await page.goto('https://www.bilibili.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
        const cookies = await ctx.cookies('https://www.bilibili.com');
        return cookies.some((c) => c.name === 'SESSDATA' && Boolean(c.value));
      });
      updateProfileStatus('bilibili', {
        login_status: loggedIn ? 'logged_in' : 'optional',
        capability_status: '已接入并验证',
        needs_attention: 0,
        note: loggedIn ? 'B站独立浏览器已登录，投稿与接口额度更稳定' : '免登录亦可采集公开 UP 主和全站热门',
      });
      return {
        loggedIn: true,
        status: loggedIn ? 'logged_in' : 'optional',
        capabilityStatus: '已接入并验证',
        message: loggedIn ? 'B站独立浏览器已登录且状态正常' : 'B站公开接口免登录可用（扫码后抓大量历史投稿更稳）',
        needsAttention: false,
      };
    } catch (err) {
      return {
        loggedIn: false,
        status: 'error',
        capabilityStatus: '暂时不可用',
        message: `检测 B站登录态失败: ${(err as Error).message}`,
        needsAttention: false,
      };
    }
  },

  async checkAvailability(url: string): Promise<AvailabilityResult> {
    const mid = await extractBiliMid(url);
    if (!mid) {
      return {
        available: false,
        message: '未能识别 B站 UP 主空间 ID，请粘贴如 https://space.bilibili.com/123456 或任意该 UP 主视频链接',
        capabilityStatus: '采集异常',
      };
    }
    const profile = await fetchBiliAuthorProfile(mid);
    return {
      available: true,
      detectedTitle: profile.name ? `${profile.name} (B站)` : `B站 UP 主 ${mid}`,
      detectedFeedUrl: `https://space.bilibili.com/${mid}/video`,
      message: profile.name
        ? `识别到 B站 UP 主「${profile.name}」${profile.followerCount != null ? `（粉丝 ${profile.followerCount.toLocaleString()}）` : ''}`
        : `识别到 B站 UP 主 ID: ${mid}`,
      capabilityStatus: '已接入并验证',
    };
  },

  async fetchLatest(source: SourceRecord, options): Promise<FetchResult> {
    const logs: string[] = [];
    const writeLog = (m: string) => {
      logs.push(m);
      options.onLog?.(m);
    };

    const mid = await extractBiliMid(source.url);
    if (!mid) {
      return {
        ok: false,
        capabilityStatus: '采集异常',
        items: [],
        logs,
        errorMessage: '无法从链接解析 B站 UP 主 MID',
      };
    }

    writeLog(`解析到 B站 UP 主 MID=${mid}，拉取公开档案与最新投稿`);
    let cookieHeader = '';
    try {
      cookieHeader = await withHeadlessContext(
        'bilibili',
        `bili-cookie:${source.id}`,
        async (ctx) => {
          const cookies = await ctx.cookies('https://www.bilibili.com');
          return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
        },
        { headless: true }
      );
    } catch {
      // 无 cookie 时走免登录公开请求
    }

    const authorProfile = await fetchBiliAuthorProfile(mid, cookieHeader);
    if (authorProfile.name) {
      writeLog(`UP 主档案：${authorProfile.name}，粉丝数：${authorProfile.followerCount ?? '未提供'}`);
    }

    let bvids: string[] = [];

    // 路径一：WBI 签名投稿列表 API（最快）
    const mixinKey = await getWbiMixinKey(cookieHeader);
    if (mixinKey) {
      const qs = signWbiParams({ mid, ps: 15, pn: 1, order: 'pubdate' }, mixinKey);
      const listRes = await fetchJson<{
        code?: number;
        message?: string;
        data?: { list?: { vlist?: Array<{ bvid?: string }> } };
      }>(`https://api.bilibili.com/x/space/wbi/arc/search?${qs}`, 15000, cookieHeader);

      if (listRes?.code === 0 && Array.isArray(listRes.data?.list?.vlist)) {
        bvids = listRes.data.list.vlist.map((v) => v.bvid || '').filter(Boolean);
        writeLog(`WBI 接口返回 ${bvids.length} 条最新投稿`);
      } else {
        writeLog(`WBI 接口受限 (${listRes?.code ?? 'network'} ${listRes?.message ?? ''})，切换独立浏览器读取投稿列表`);
      }
    }

    // 路径二：独立浏览器兜底读取空间页 BV 列表
    if (bvids.length === 0) {
      try {
        bvids = await withHeadlessContext(
          'bilibili',
          `source:${source.id}`,
          async (ctx) => {
            const page = ctx.pages()[0] || (await ctx.newPage());
            await page.goto(`https://space.bilibili.com/${mid}/video`, {
              waitUntil: 'domcontentloaded',
              timeout: 25000,
            });
            await page.waitForTimeout(3000);
            return await page.evaluate(() => {
              const links = Array.from(document.querySelectorAll('a[href*="/video/BV"]'));
              const out: string[] = [];
              const seen = new Set<string>();
              for (const a of links) {
                const m = ((a as HTMLAnchorElement).href || '').match(/\/video\/(BV[a-zA-Z0-9]+)/i);
                if (m && !seen.has(m[1])) {
                  seen.add(m[1]);
                  out.push(m[1]);
                }
                if (out.length >= 15) break;
              }
              return out;
            });
          },
          { headless: options.headless }
        );
        writeLog(`独立浏览器提取到 ${bvids.length} 个投稿 BV 号`);
      } catch (err) {
        writeLog(`独立浏览器读取 B站空间失败: ${(err as Error).message}`);
      }
    }

    // 用公开 view 接口串行补全精准播放、点赞、评论、收藏、转发（轻量控速防风控）
    const items: ExtractedContentItem[] = [];
    for (const bvid of bvids.slice(0, 12)) {
      if (options.signal?.aborted) break;
      const item = await enrichBvidMetrics(bvid, cookieHeader);
      if (item) {
        if (!item.author && authorProfile.name) item.author = authorProfile.name;
        items.push(item);
      }
      await new Promise((r) => setTimeout(r, 180));
    }

    writeLog(`成功补全 ${items.length} 条 B站视频的真实互动数据`);
    return {
      ok: items.length > 0,
      capabilityStatus: items.length > 0 ? '已接入并验证' : '暂时不可用',
      items,
      authorProfile,
      logs,
      errorMessage: items.length === 0 ? '未获取到该 UP 主的公开投稿（可尝试在「浏览器与登录」中扫码登录 B站后重试）' : undefined,
    };
  },
};
