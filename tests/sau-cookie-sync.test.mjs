import test from 'node:test';
import assert from 'node:assert/strict';

const { filterValidPlatformCookies, hasActiveAuthCookies, isSauSyncSupportedPlatform } = await import(
  '../dist/services/sauCookieSync.js'
);

test('发布登录态同步过滤器：仅保留目标平台未过期 Cookie 并精准识别真实登录态', () => {
  assert.equal(isSauSyncSupportedPlatform('douyin'), true);
  assert.equal(isSauSyncSupportedPlatform('kuaishou'), true);
  assert.equal(isSauSyncSupportedPlatform('youtube'), false);

  const future = Math.floor(Date.now() / 1000) + 86400;
  const expired = Math.floor(Date.now() / 1000) - 3600;

  const filtered = filterValidPlatformCookies('douyin', [
    { name: 'sessionid', value: 'demo-token', domain: '.douyin.com', path: '/', expires: future, sameSite: 'lax' },
    { name: 'uid_tt', value: 'expired-token', domain: '.douyin.com', path: '/', expires: expired },
    { name: 'unrelated', value: 'x', domain: '.example.com', path: '/', expires: future },
    { name: 'ttwid', value: 'guest-only', domain: '.douyin.com', path: '/', expires: future },
  ]);

  assert.equal(filtered.length, 2);
  assert.equal(filtered[0].sameSite, 'Lax');
  assert.equal(hasActiveAuthCookies('douyin', filtered), true);

  // 仅有游客 ttwid 时必须判定为未登录（绝不误判为已登录）
  assert.equal(
    hasActiveAuthCookies('douyin', [{ name: 'ttwid', value: 'guest-only', domain: '.douyin.com', expires: future }]),
    false
  );
});
