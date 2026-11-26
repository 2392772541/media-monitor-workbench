import type { PlatformKey } from './types.js';

export interface RecognizedSource {
  platform: PlatformKey;
  sourceType: 'website' | 'rss' | 'creator' | 'social' | 'column';
  normalizedUrl: string;
  valid: boolean;
}

const DEFAULT_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

// 从抖音/B站/小红书等带中文口令的分享文案中精准提取第一条完整网址
export function extractUrlFromShareText(raw: string): string {
  const text = (raw || '').trim();
  if (!text) return '';
  const match = text.match(/https?:\/\/[^\s\u4e00-\u9fa5，。！？、；：“”‘’（）【】《》"'<>]+/i);
  if (match) {
    return match[0].replace(/[.,;!?)}\]]+$/, '');
  }
  return text;
}

export function recognizeSourceUrl(rawUrl: string): RecognizedSource {
  let trimmed = extractUrlFromShareText(rawUrl);
  if (!trimmed) {
    return { platform: 'website', sourceType: 'website', normalizedUrl: '', valid: false };
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    // 若无协议前缀且包含空白或中文，判定为无效链接而非拼接非法 URL
    if (/[\s\u4e00-\u9fa5]/.test(trimmed) || !trimmed.includes('.')) {
      return { platform: 'website', sourceType: 'website', normalizedUrl: trimmed, valid: false };
    }
    trimmed = 'https://' + trimmed;
  }
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return { platform: 'website', sourceType: 'website', normalizedUrl: trimmed, valid: false };
  }

  const host = u.hostname.toLowerCase();
  const pathname = u.pathname.toLowerCase();

  if (host.includes('douyin.com') || host.includes('iesdouyin.com')) {
    return { platform: 'douyin', sourceType: 'creator', normalizedUrl: u.toString(), valid: true };
  }
  if (host.includes('bilibili.com') || host === 'b23.tv') {
    return { platform: 'bilibili', sourceType: 'creator', normalizedUrl: u.toString(), valid: true };
  }
  if (host.includes('kuaishou.com')) {
    return { platform: 'kuaishou', sourceType: 'creator', normalizedUrl: u.toString(), valid: true };
  }
  if (host.includes('channels.weixin.qq.com')) {
    return { platform: 'wechat-channels', sourceType: 'creator', normalizedUrl: u.toString(), valid: true };
  }
  if (host === 'x.com' || host.endsWith('.x.com') || host === 'twitter.com' || host.endsWith('.twitter.com')) {
    return { platform: 'x', sourceType: 'social', normalizedUrl: u.toString(), valid: true };
  }
  if (host.includes('youtube.com') || host === 'youtu.be') {
    return { platform: 'youtube', sourceType: 'creator', normalizedUrl: u.toString(), valid: true };
  }
  if (host.includes('xiaohongshu.com') || host.includes('xhslink.com')) {
    return { platform: 'website', sourceType: 'social', normalizedUrl: u.toString(), valid: true };
  }
  if (
    pathname.endsWith('.xml') ||
    pathname.endsWith('.rss') ||
    pathname.endsWith('.atom') ||
    pathname.includes('/feed') ||
    pathname.includes('/rss')
  ) {
    return { platform: 'rss', sourceType: 'rss', normalizedUrl: u.toString(), valid: true };
  }

  return { platform: 'website', sourceType: 'website', normalizedUrl: u.toString(), valid: true };
}

function extractDouyinSecUid(urlStr: string): string | null {
  try {
    const u = new URL(urlStr);
    const m = u.pathname.match(/\/(?:share\/)?user\/([^/?#]+)/i);
    if (m && m[1] && m[1] !== 'self') return m[1];
    const sec = u.searchParams.get('sec_uid');
    if (sec && sec.length > 8) return sec;
  } catch {
    // ignore
  }
  return null;
}

// 解析抖音 v.douyin.com / iesdouyin.com 短链和 B站 b23.tv 短链，统一转为规范桌面主页 URL
export async function resolveShortSourceUrl(rawUrl: string): Promise<{ resolvedUrl: string; changed: boolean }> {
  const cleaned = extractUrlFromShareText(rawUrl);
  if (!cleaned) return { resolvedUrl: rawUrl, changed: false };

  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`);
  } catch {
    return { resolvedUrl: cleaned, changed: false };
  }

  const host = u.hostname.toLowerCase();

  // 1. 抖音主页链接直接规范化（去掉追踪参数，把 mobile share/user 转为桌面 www.douyin.com/user/<sec_uid>）
  const directSecUid = extractDouyinSecUid(u.toString());
  if (directSecUid && (host.includes('douyin.com') || host.includes('iesdouyin.com'))) {
    const canonical = `https://www.douyin.com/user/${directSecUid}`;
    return { resolvedUrl: canonical, changed: canonical !== rawUrl };
  }

  // 2. 跟随短链重定向（v.douyin.com / b23.tv）
  if (host === 'v.douyin.com' || host === 'b23.tv' || host.endsWith('.douyin.com')) {
    let current = u.toString();
    for (let hop = 0; hop < 4; hop++) {
      try {
        const res = await fetch(current, {
          redirect: 'manual',
          headers: { 'User-Agent': DEFAULT_UA },
          signal: AbortSignal.timeout(10000),
        });
        const loc = res.headers.get('location');
        if (!loc) break;
        current = new URL(loc, current).toString();
        const secUid = extractDouyinSecUid(current);
        if (secUid) {
          const canonical = `https://www.douyin.com/user/${secUid}`;
          return { resolvedUrl: canonical, changed: canonical !== rawUrl };
        }
        // B站短链跳转到 space.bilibili.com/<mid> 后清洗多余参数
        if (host === 'b23.tv' && /space\.bilibili\.com\/(\d+)/i.test(current)) {
          const mid = current.match(/space\.bilibili\.com\/(\d+)/i)![1];
          const canonical = `https://space.bilibili.com/${mid}`;
          return { resolvedUrl: canonical, changed: canonical !== rawUrl };
        }
      } catch {
        break;
      }
    }
    if (current !== u.toString()) {
      return { resolvedUrl: current, changed: true };
    }
  }

  return { resolvedUrl: u.toString(), changed: u.toString() !== rawUrl };
}
