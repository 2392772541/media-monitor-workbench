import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = path.resolve(import.meta.dirname, '..');
const LOCAL_APP_DATA = process.env.LOCALAPPDATA || '';
const CHROMIUM_EXEC = path.join(LOCAL_APP_DATA, 'ms-playwright', 'chromium-1254', 'chrome-win64', 'chrome.exe');
const PROFILE_A = path.join(ROOT, 'browser-profiles', 'other', '_verify_a');
const PROFILE_B = path.join(ROOT, 'browser-profiles', 'other', '_verify_b');

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
}

async function startTestServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/login') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Set-Cookie': 'mmw_session=persist_token_abc123; Path=/; Max-Age=86400; SameSite=Lax',
      });
      res.end(`<!doctype html><html><body><h1>Login OK</h1><script>localStorage.setItem('mmw_user', 'user_profile_a');</script></body></html>`);
      return;
    }
    const cookies = req.headers.cookie || '';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><body>
      <div id="cookie">${cookies}</div>
      <div id="ls"></div>
      <script>document.getElementById('ls').textContent = localStorage.getItem('mmw_user') || 'NONE';</script>
    </body></html>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function main() {
  fs.rmSync(PROFILE_A, { recursive: true, force: true });
  fs.rmSync(PROFILE_B, { recursive: true, force: true });
  fs.mkdirSync(PROFILE_A, { recursive: true });
  fs.mkdirSync(PROFILE_B, { recursive: true });

  assert(fs.existsSync(CHROMIUM_EXEC), `Chromium executable missing at ${CHROMIUM_EXEC}`);
  const { server, baseUrl } = await startTestServer();
  const report = {
    executablePath: CHROMIUM_EXEC,
    headlessLaunch1: false,
    cookieAndLsWritten: false,
    headlessRelaunchPersisted: false,
    profileIsolationVerified: false,
    screenshotSaved: false,
    errors: [],
  };

  try {
    // 1. Launch Profile A headless, login & store Cookie + LocalStorage
    const ctx1 = await chromium.launchPersistentContext(PROFILE_A, {
      executablePath: CHROMIUM_EXEC,
      headless: true,
      args: ['--no-first-run', '--no-default-browser-check'],
    });
    report.headlessLaunch1 = true;
    const page1 = ctx1.pages()[0] || (await ctx1.newPage());
    await page1.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded' });
    const h1 = await page1.textContent('h1');
    assert(h1 === 'Login OK', 'Expected Login OK');
    report.cookieAndLsWritten = true;
    await ctx1.close();

    // 2. Relaunch Profile A, verify persistence
    const ctx2 = await chromium.launchPersistentContext(PROFILE_A, {
      executablePath: CHROMIUM_EXEC,
      headless: true,
      args: ['--no-first-run', '--no-default-browser-check'],
    });
    const page2 = ctx2.pages()[0] || (await ctx2.newPage());
    await page2.goto(`${baseUrl}/check`, { waitUntil: 'domcontentloaded' });
    const cookie2 = await page2.textContent('#cookie');
    const ls2 = await page2.textContent('#ls');
    assert(cookie2.includes('mmw_session=persist_token_abc123'), `Cookie not persisted: ${cookie2}`);
    assert(ls2 === 'user_profile_a', `LocalStorage not persisted: ${ls2}`);
    report.headlessRelaunchPersisted = true;
    await page2.screenshot({ path: path.join(ROOT, 'tests', 'artifacts', 'phase1-persist.png') });
    report.screenshotSaved = true;
    await ctx2.close();

    // 3. Launch Profile B, verify complete isolation from Profile A
    const ctxB = await chromium.launchPersistentContext(PROFILE_B, {
      executablePath: CHROMIUM_EXEC,
      headless: true,
      args: ['--no-first-run', '--no-default-browser-check'],
    });
    const pageB = ctxB.pages()[0] || (await ctxB.newPage());
    await pageB.goto(`${baseUrl}/check`, { waitUntil: 'domcontentloaded' });
    const cookieB = await pageB.textContent('#cookie');
    const lsB = await pageB.textContent('#ls');
    assert(!cookieB.includes('persist_token_abc123'), `Profile B leaked cookie: ${cookieB}`);
    assert(lsB === 'NONE', `Profile B leaked localStorage: ${lsB}`);
    report.profileIsolationVerified = true;
    await ctxB.close();
  } finally {
    server.close();
    fs.rmSync(PROFILE_A, { recursive: true, force: true });
    fs.rmSync(PROFILE_B, { recursive: true, force: true });
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
