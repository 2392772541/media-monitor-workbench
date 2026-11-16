import type { AvailabilityResult, FetchResult, LoginCheckResult, PlatformAdapter, SourceRecord } from './types.js';
import { fetchText, parseFeedContent } from './webUtils.js';

export const rssAdapter: PlatformAdapter = {
  platform: 'rss',
  displayName: 'RSS / Atom 订阅',
  profilePlatform: null,
  defaultCapability: '已接入并验证',

  async checkLoginStatus(): Promise<LoginCheckResult> {
    return {
      loggedIn: true,
      status: 'optional',
      capabilityStatus: '已接入并验证',
      message: '公开 RSS 订阅无需登录',
      needsAttention: false,
    };
  },

  async checkAvailability(url: string): Promise<AvailabilityResult> {
    const res = await fetchText(url, 15000);
    if (!res.ok) {
      return {
        available: false,
        message: `订阅源访问失败: ${res.error}`,
        capabilityStatus: '采集异常',
      };
    }
    try {
      const parsed = parseFeedContent(res.text, res.finalUrl);
      if (parsed.items.length === 0) {
        return {
          available: false,
          detectedTitle: parsed.feedTitle,
          message: '地址可访问但未解析到有效 RSS/Atom 条目，请确认是否为标准订阅格式',
          capabilityStatus: '采集异常',
        };
      }
      return {
        available: true,
        detectedTitle: parsed.feedTitle || new URL(url).hostname,
        detectedFeedUrl: res.finalUrl,
        message: `RSS 检测成功，发现 ${parsed.items.length} 条内容`,
        capabilityStatus: '已接入并验证',
      };
    } catch (err) {
      return {
        available: false,
        message: `RSS 解析失败: ${(err as Error).message}`,
        capabilityStatus: '采集异常',
      };
    }
  },

  async fetchLatest(source: SourceRecord, options): Promise<FetchResult> {
    const logs: string[] = [];
    const writeLog = (m: string) => {
      logs.push(m);
      options.onLog?.(m);
    };

    writeLog(`开始拉取 RSS 订阅: ${source.url}`);
    const res = await fetchText(source.url, 15000, options.signal);
    if (!res.ok) {
      return {
        ok: false,
        capabilityStatus: '采集异常',
        items: [],
        logs,
        errorMessage: res.error || '无法读取 RSS 订阅',
      };
    }

    try {
      const parsed = parseFeedContent(res.text, res.finalUrl);
      writeLog(`成功解析订阅《${parsed.feedTitle || source.name}》，共获取 ${parsed.items.length} 条内容`);
      return {
        ok: true,
        capabilityStatus: '已接入并验证',
        items: parsed.items,
        logs,
      };
    } catch (err) {
      return {
        ok: false,
        capabilityStatus: '采集异常',
        items: [],
        logs,
        errorMessage: `RSS 解析出错: ${(err as Error).message}`,
      };
    }
  },
};
