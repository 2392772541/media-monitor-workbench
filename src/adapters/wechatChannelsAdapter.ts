import { withHeadlessContext, updateProfileStatus } from '../browser/profileManager.js';
import type { AvailabilityResult, FetchResult, LoginCheckResult, PlatformAdapter, SourceRecord } from './types.js';

export const wechatChannelsAdapter: PlatformAdapter = {
  platform: 'wechat-channels',
  displayName: '微信视频号',
  profilePlatform: 'wechat-channels',
  defaultCapability: '需要登录',

  async checkLoginStatus(): Promise<LoginCheckResult> {
    try {
      const res = await withHeadlessContext('wechat-channels', 'login-check', async (ctx) => {
        const page = ctx.pages()[0] || (await ctx.newPage());
        await page.goto('https://channels.weixin.qq.com/', { waitUntil: 'domcontentloaded', timeout: 25000 });
        await page.waitForTimeout(2500);
        const url = page.url();
        const text = await page.evaluate(() => document.body?.innerText?.slice(0, 1500) || '');
        const isLoginPage = url.includes('/login') || text.includes('微信扫码') || text.includes('请使用微信扫一扫');
        return { isLoginPage, url };
      });

      if (!res.isLoginPage) {
        updateProfileStatus('wechat-channels', {
          login_status: 'logged_in',
          capability_status: '需要授权',
          needs_attention: 0,
          note: '视频号助手网页端已登录（注：受微信生态限制，网页端仅开放已授权账号自身数据，暂不支持任意外部博主主页抓取）',
        });
        return {
          loggedIn: true,
          status: 'logged_in',
          capabilityStatus: '需要授权',
          message: '微信视频号助手已登录，但网页端仅支持已授权自有/管理账号范围，暂不支持任意第三方博主主页',
          needsAttention: false,
        };
      }

      updateProfileStatus('wechat-channels', {
        login_status: 'auth_required',
        capability_status: '需要登录',
        needs_attention: 1,
        note: '尚未扫码登录微信视频号网页端',
      });
      return {
        loggedIn: false,
        status: 'auth_required',
        capabilityStatus: '需要登录',
        message: '微信视频号尚未登录或会话已过期，请打开独立窗口微信扫码',
        needsAttention: true,
      };
    } catch (err) {
      return {
        loggedIn: false,
        status: 'error',
        capabilityStatus: '采集异常',
        message: `微信视频号检测异常: ${(err as Error).message}`,
        needsAttention: true,
      };
    }
  },

  async checkAvailability(url: string): Promise<AvailabilityResult> {
    if (!/channels\.weixin\.qq\.com/i.test(url)) {
      return { available: false, message: '链接不属于微信视频号域名', capabilityStatus: '暂不支持' };
    }
    return {
      available: true,
      message: '受微信视频号网页生态权限限制，目前仅支持在扫码登录后读取本人/授权账号内容，不支持公开任意博主主页抓取',
      capabilityStatus: '需要授权',
    };
  },

  async fetchLatest(source: SourceRecord, options): Promise<FetchResult> {
    const logs: string[] = [];
    const writeLog = (m: string) => {
      logs.push(m);
      options.onLog?.(m);
    };

    writeLog('启动独立微信视频号浏览器检测登录与权限范围...');
    try {
      const res = await withHeadlessContext(
        'wechat-channels',
        `source:${source.id}`,
        async (ctx) => {
          const page = ctx.pages()[0] || (await ctx.newPage());
          await page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
          await page.waitForTimeout(3000);
          const text = await page.evaluate(() => document.body?.innerText?.slice(0, 2000) || '');
          const currentUrl = page.url();
          const needsLogin = currentUrl.includes('/login') || text.includes('微信扫码') || text.includes('请使用微信扫一扫');
          return { needsLogin, currentUrl };
        },
        { headless: options.headless }
      );

      if (res.needsLogin) {
        writeLog('微信视频号需要微信扫码登录，已暂停采集');
        updateProfileStatus('wechat-channels', { login_status: 'auth_required', capability_status: '需要登录', needs_attention: 1 });
        return {
          ok: false,
          authRequired: true,
          capabilityStatus: '需要登录',
          items: [],
          logs,
          errorMessage: '微信视频号未登录或扫码已过期，请打开独立浏览器扫码',
        };
      }

      writeLog('受微信生态开放边界限制，网页端未提供外部任意博主公开动态列表接口，已如实标记为受限状态');
      return {
        ok: false,
        capabilityStatus: '暂不支持',
        items: [],
        logs,
        errorMessage: '受微信视频号平台生态限制：网页端不提供任意第三方博主公开作品流接口，不进行未授权私有接口绕过。',
      };
    } catch (err) {
      const msg = (err as Error).message;
      writeLog(`微信视频号访问异常: ${msg}`);
      return { ok: false, capabilityStatus: '采集异常', items: [], logs, errorMessage: msg };
    }
  },
};
