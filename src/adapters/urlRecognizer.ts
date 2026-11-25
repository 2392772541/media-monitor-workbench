import type { PlatformKey } from './types.js';

export interface RecognizedSource {
  platform: PlatformKey;
  sourceType: 'website' | 'rss' | 'creator' | 'social' | 'column';
  normalizedUrl: string;
}

export function recognizeSourceUrl(rawUrl: string): RecognizedSource {
  let trimmed = rawUrl.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    trimmed = 'https://' + trimmed;
  }
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return { platform: 'website', sourceType: 'website', normalizedUrl: trimmed };
  }

  const host = u.hostname.toLowerCase();
  const pathname = u.pathname.toLowerCase();

  if (host.includes('douyin.com')) {
    return { platform: 'douyin', sourceType: 'creator', normalizedUrl: u.toString() };
  }
  if (host.includes('bilibili.com') || host === 'b23.tv') {
    return { platform: 'bilibili', sourceType: 'creator', normalizedUrl: u.toString() };
  }
  if (host.includes('kuaishou.com')) {
    return { platform: 'kuaishou', sourceType: 'creator', normalizedUrl: u.toString() };
  }
  if (host.includes('channels.weixin.qq.com')) {
    return { platform: 'wechat-channels', sourceType: 'creator', normalizedUrl: u.toString() };
  }
  if (host === 'x.com' || host.endsWith('.x.com') || host === 'twitter.com' || host.endsWith('.twitter.com')) {
    return { platform: 'x', sourceType: 'social', normalizedUrl: u.toString() };
  }
  if (host.includes('youtube.com') || host === 'youtu.be') {
    return { platform: 'youtube', sourceType: 'creator', normalizedUrl: u.toString() };
  }
  // 识别小红书主页或作品链接，归入动态网页提取链路
  if (host.includes('xiaohongshu.com') || host.includes('xhslink.com')) {
    return { platform: 'website', sourceType: 'social', normalizedUrl: u.toString() };
  }
  if (
    pathname.endsWith('.xml') ||
    pathname.endsWith('.rss') ||
    pathname.endsWith('.atom') ||
    pathname.includes('/feed') ||
    pathname.includes('/rss')
  ) {
    return { platform: 'rss', sourceType: 'rss', normalizedUrl: u.toString() };
  }

  return { platform: 'website', sourceType: 'website', normalizedUrl: u.toString() };
}
