import type { PlatformAdapter, PlatformKey } from './types.js';
import { websiteAdapter } from './websiteAdapter.js';
import { rssAdapter } from './rssAdapter.js';
import { douyinAdapter } from './douyinAdapter.js';
import { bilibiliAdapter } from './bilibiliAdapter.js';
import { kuaishouAdapter } from './kuaishouAdapter.js';
import { wechatChannelsAdapter } from './wechatChannelsAdapter.js';
import { xAdapter } from './xAdapter.js';
import { youtubeAdapter } from './youtubeAdapter.js';

const adapters: Record<PlatformKey, PlatformAdapter> = {
  website: websiteAdapter,
  rss: rssAdapter,
  douyin: douyinAdapter,
  bilibili: bilibiliAdapter,
  kuaishou: kuaishouAdapter,
  'wechat-channels': wechatChannelsAdapter,
  x: xAdapter,
  youtube: youtubeAdapter,
};

export function getAdapter(platform: string): PlatformAdapter {
  if (platform in adapters) {
    return adapters[platform as PlatformKey];
  }
  return websiteAdapter;
}

export function listAdapters(): PlatformAdapter[] {
  return Object.values(adapters);
}
