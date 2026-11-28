import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { withHeadlessContext, updateProfileStatus } from '../browser/profileManager.js';

const execFileAsync = promisify(execFile);
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

interface BiliVlistEntry {
  bvid?: string;
  title?: string;
  description?: string;
  pic?: string;
  created?: number;
  play?: number | string;
  comment?: number;
  author?: string;
}

// 内部通用多页拉取实现：常规追更默认 1 页，历史深抓支持 1..5 页
async function fetchBilibiliPages(
  source: SourceRecord,
  options: { headless: boolean; signal?: AbortSignal; onLog?: (msg: string) => void; maxPages?: number }
): Promise<FetchResult> {
  const maxPages = Math.min(Math.max(Math.round(options.maxPages || 1), 1), 5);
  const pageSize = maxPages > 1 ? 30 : 15;
  const maxItems = maxPages > 1 ? maxPages * 30 : 15;
  const enrichCap = maxPages > 1 ? maxPages * 30 : 12;

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

  writeLog(`解析到 B站 UP 主 MID=${mid}，拉取公开档案与投稿（最多 ${maxPages} 页）`);
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

  // 若未登录且无 buvid3，先从公开 spi 接口预热访客指纹 Cookie，大幅降低 -352 风控概率
  if (!cookieHeader.includes('buvid3=')) {
    const spi = await fetchJson<{ code?: number; data?: { b_3?: string; b_4?: string } }>(
      'https://api.bilibili.com/x/frontend/finger/spi',
      8000
    );
    if (spi?.code === 0 && spi.data?.b_3) {
      const extra = `buvid3=${spi.data.b_3}${spi.data.b_4 ? `; buvid4=${spi.data.b_4}` : ''}`;
      cookieHeader = cookieHeader ? `${cookieHeader}; ${extra}` : extra;
    }
  }

  const authorProfile = await fetchBiliAuthorProfile(mid, cookieHeader);
  if (authorProfile.name) {
    writeLog(`UP 主档案：${authorProfile.name}，粉丝数：${authorProfile.followerCount ?? '未提供'}`);
  }

  const vlistMap = new Map<string, BiliVlistEntry>();
  let bvids: string[] = [];

  // 路径一：WBI 签名投稿列表 API（支持 pn=1..maxPages 翻页）
  const mixinKey = await getWbiMixinKey(cookieHeader);
  if (mixinKey) {
    for (let pn = 1; pn <= maxPages; pn++) {
      if (options.signal?.aborted) break;
      const qs = signWbiParams({ mid, ps: pageSize, pn, order: 'pubdate' }, mixinKey);
      const listRes = await fetchJson<{
        code?: number;
        message?: string;
        data?: { list?: { vlist?: BiliVlistEntry[] } };
      }>(`https://api.bilibili.com/x/space/wbi/arc/search?${qs}`, 15000, cookieHeader);

      if (listRes?.code === 0 && Array.isArray(listRes.data?.list?.vlist)) {
        const pageList = listRes.data.list.vlist;
        for (const v of pageList) {
          if (v.bvid && !vlistMap.has(v.bvid)) {
            vlistMap.set(v.bvid, v);
          }
        }
        writeLog(`WBI 接口第 ${pn} 页返回 ${pageList.length} 条投稿（累计 ${vlistMap.size} 条）`);
        if (pageList.length < pageSize) break;
        if (pn < maxPages) await new Promise((r) => setTimeout(r, 320));
      } else {
        if (pn === 1) {
          writeLog(`WBI 接口受限 (${listRes?.code ?? 'network'} ${listRes?.message ?? ''})，自动切换浏览器接口拦截`);
        } else {
          writeLog(`WBI 翻页第 ${pn} 页受限 (${listRes?.code ?? 'network'})，保留前序已抓数据`);
        }
        break;
      }
    }
    bvids = Array.from(vlistMap.keys());
  }

  // 路径二：正常桌面 UA 浏览器访问空间页，直接拦截投稿 API JSON + 翻页/DOM 兜底
  if (bvids.length === 0) {
    try {
      const capturedEntries = await withHeadlessContext(
        'bilibili',
        `source:${source.id}`,
        async (ctx) => {
          const page = ctx.pages()[0] || (await ctx.newPage());
          const captured = new Map<string, BiliVlistEntry>();
          page.on('response', async (resp) => {
            const u = resp.url();
            if (!u.includes('/space/wbi/arc/search') && !u.includes('/space/arc/search')) return;
            try {
              const j = (await resp.json()) as { data?: { list?: { vlist?: BiliVlistEntry[] } } };
              for (const v of j?.data?.list?.vlist || []) {
                if (v.bvid && !captured.has(v.bvid)) captured.set(v.bvid, v);
              }
            } catch {
              // ignore
            }
          });

          await page.goto(`https://space.bilibili.com/${mid}/video`, {
            waitUntil: 'domcontentloaded',
            timeout: 25000,
          });
          for (let i = 0; i < 12; i++) {
            await page.waitForTimeout(500);
            if (captured.size >= 8) break;
          }

          // 历史模式时尝试点击空间页“下一页”抓取更多页
          if (maxPages > 1 && captured.size > 0) {
            for (let pIdx = 1; pIdx < maxPages; pIdx++) {
              if (options.signal?.aborted || captured.size >= maxItems) break;
              const nextBtn = page.locator('button:has-text("下一页"), .be-pager-next:not(.be-pager-disabled)').first();
              const canNext = await nextBtn.isVisible().catch(() => false);
              if (!canNext) break;
              const before = captured.size;
              await nextBtn.click().catch(() => undefined);
              await page.waitForTimeout(1600);
              if (captured.size === before) break;
            }
          }

          if (captured.size === 0) {
            const domBvids = await page.evaluate((domCap) => {
              const links = Array.from(document.querySelectorAll('a[href*="/video/BV"]'));
              const out: string[] = [];
              const seen = new Set<string>();
              for (const a of links) {
                const m = ((a as HTMLAnchorElement).href || '').match(/\/video\/(BV[a-zA-Z0-9]+)/i);
                if (m && !seen.has(m[1])) {
                  seen.add(m[1]);
                  out.push(m[1]);
                }
                if (out.length >= domCap) break;
              }
              return out;
            }, maxItems);
            for (const b of domBvids) captured.set(b, { bvid: b });
          }
          return Array.from(captured.values()).slice(0, maxItems);
        },
        { headless: options.headless }
      );
      for (const e of capturedEntries) {
        if (e.bvid && !vlistMap.has(e.bvid)) vlistMap.set(e.bvid, e);
      }
      bvids = Array.from(vlistMap.keys());
      writeLog(`独立浏览器提取到 ${bvids.length} 个投稿 BV 号`);
    } catch (err) {
      writeLog(`独立浏览器读取 B站空间失败: ${(err as Error).message}`);
    }
  }

  // 路径三（终极免登录兜底）：调用 yt-dlp 拉平空间投稿 BV 号，抗 -352 风控极稳
  if (bvids.length === 0) {
    try {
      const ytdlpLimit = maxPages > 1 ? maxItems : 12;
      writeLog(`切换 yt-dlp 兜底通道读取 UP 主投稿列表（最多 ${ytdlpLimit} 条）...`);
      const { stdout } = await execFileAsync(
        'yt-dlp',
        [
          '--flat-playlist',
          '--no-warnings',
          '--playlist-end',
          String(ytdlpLimit),
          '--print',
          '%(id)s',
          `https://space.bilibili.com/${mid}/video`,
        ],
        { timeout: 45000, windowsHide: true }
      );
      const extracted = stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => /^BV[a-zA-Z0-9]+$/i.test(s));
      bvids = Array.from(new Set(extracted)).slice(0, ytdlpLimit);
      writeLog(`yt-dlp 兜底通道成功获取 ${bvids.length} 个投稿 BV 号`);
    } catch (err) {
      writeLog(`yt-dlp 兜底通道跳过: ${(err as Error).message.slice(0, 100)}`);
    }
  }

  // 用公开 view 接口串行补全精准播放、点赞、评论、收藏、转发（轻量控速防风控）
  const items: ExtractedContentItem[] = [];
  const enrichDelayMs = maxPages > 1 ? 120 : 180;
  for (const bvid of bvids.slice(0, enrichCap)) {
    if (options.signal?.aborted) break;
    let item = await enrichBvidMetrics(bvid, cookieHeader);
    // 若详情接口偶发限流，回退使用 WBI 列表已有的规范化字段，保证历史列表与发布时间完整
    if (!item) {
      const meta = vlistMap.get(bvid);
      if (meta && meta.title) {
        const pubIso =
          typeof meta.created === 'number' && meta.created > 0
            ? new Date(meta.created * 1000).toISOString()
            : null;
        const rawPic = meta.pic || '';
        item = {
          platformItemId: bvid,
          url: `https://www.bilibili.com/video/${bvid}`,
          title: meta.title.trim() || `B站视频 ${bvid}`,
          author: meta.author || authorProfile.name || '',
          summary: (meta.description || meta.title || '').trim().slice(0, 500),
          body: (meta.description || meta.title || '').trim(),
          coverUrl: rawPic.startsWith('//') ? `https:${rawPic}` : rawPic,
          publishedAt: pubIso,
          contentType: 'video',
          metrics: {
            views: typeof meta.play === 'number' ? meta.play : null,
            comments: typeof meta.comment === 'number' ? meta.comment : null,
          },
          rawMeta: { bvid, fromWbiFallback: true },
        };
      }
    }
    if (item) {
      if (!item.author && authorProfile.name) item.author = authorProfile.name;
      items.push(item);
    }
    await new Promise((r) => setTimeout(r, enrichDelayMs));
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
}

// 导出 B站历史多页抓取函数（供 R3 历史深抓接口调用）
export async function fetchBilibiliHistory(
  source: SourceRecord,
  options: { headless?: boolean; maxPages?: number; signal?: AbortSignal; onLog?: (msg: string) => void } = {}
): Promise<FetchResult> {
  return fetchBilibiliPages(source, {
    headless: options.headless ?? true,
    maxPages: options.maxPages ?? 3,
    signal: options.signal,
    onLog: options.onLog,
  });
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
    return fetchBilibiliPages(source, { ...options, maxPages: 1 });
  },
};
