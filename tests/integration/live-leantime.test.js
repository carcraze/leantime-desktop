'use strict';

/**
 * Live end-to-end test: launches the real Electron client against a real Leantime
 * server and logs in through the app's own window, driven over the Chrome DevTools
 * Protocol. This is the test that proves the wrapper actually works as a client,
 * as opposed to merely rendering a page.
 *
 * Start the server first:
 *   docker compose -f tests/fixtures/docker-compose.leantime.yml up -d
 *   (then complete /install, or use the credentials below if seeded by CI)
 *
 * The test skips itself when no server is reachable, so the suite stays green
 * for contributors who have not started one.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const ELECTRON_BIN = require(path.join(PROJECT_ROOT, 'node_modules', 'electron'));

const SERVER_URL = process.env.LEANTIME_TEST_URL || 'http://localhost:8099';
const USERNAME = process.env.LEANTIME_TEST_USER || 'admin@local.test';
const PASSWORD = process.env.LEANTIME_TEST_PASSWORD || 'Str0ng-Test-Pw!2026';
const DEBUG_PORT = 9333;

async function serverReachable() {
  try {
    const res = await fetch(`${SERVER_URL}/auth/login`, { signal: AbortSignal.timeout(4000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Minimal CDP client over the built-in WebSocket. */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    });
  }

  static async attach(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    return new CDP(ws);
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 20_000);
    });
  }

  /** Evaluates an expression in the page and returns its value. */
  async evaluate(expression) {
    const { result } = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return result.value;
  }

  close() {
    try { this.ws.close(); } catch { /* already closed */ }
  }
}

/** Polls the DevTools target list until the main page target appears. */
async function findPageTarget(deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`, {
        signal: AbortSignal.timeout(2000),
      });
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page' && t.url.startsWith(SERVER_URL));
      if (page?.webSocketDebuggerUrl) return page;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

async function waitFor(fn, { timeout = 25_000, interval = 400, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Timed out waiting for ${label}. Last value: ${JSON.stringify(last)}`);
}

test('logs into a live Leantime server through the desktop client', async (t) => {
  if (!(await serverReachable())) {
    t.skip(`No Leantime server at ${SERVER_URL}. Start tests/fixtures/docker-compose.leantime.yml`);
    return;
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'leantime-desktop-e2e-'));
  fs.writeFileSync(
    path.join(userDataDir, 'config.json'),
    JSON.stringify({ serverUrl: SERVER_URL })
  );

  const child = spawn(
    ELECTRON_BIN,
    [
      PROJECT_ROOT,
      `--user-data-dir=${userDataDir}`,
      `--remote-debugging-port=${DEBUG_PORT}`,
      '--ozone-platform=x11',
      '--disable-gpu',
      '--in-process-gpu',
      '--no-sandbox',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );

  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  let cdp;
  try {
    const target = await findPageTarget(30_000);
    assert.ok(target, `Client window never appeared. stderr:\n${stderr.slice(-1200)}`);

    cdp = await CDP.attach(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');

    // The client should be sitting on a real Leantime login page.
    const onLoginPage = await waitFor(
      () => cdp.evaluate('!!document.querySelector(\'input[name="username"]\')'),
      { label: 'Leantime login form' }
    );
    assert.ok(onLoginPage, 'Client did not render the Leantime login form');

    const title = await cdp.evaluate('document.title');
    assert.match(title, /Leantime/i, `Unexpected page title: ${title}`);

    // Confirm the identity-provider-hostile Electron token is absent in-page too.
    const ua = await cdp.evaluate('navigator.userAgent');
    assert.doesNotMatch(ua, /Electron/i, `Renderer user agent leaks Electron: ${ua}`);

    // Sign in using the app's own form.
    await cdp.evaluate(`
      (() => {
        const f = document.querySelector('input[name="username"]').form;
        f.querySelector('input[name="username"]').value = ${JSON.stringify(USERNAME)};
        f.querySelector('input[name="password"]').value = ${JSON.stringify(PASSWORD)};
        f.submit();
        return true;
      })()
    `);

    // After login the app should be on the dashboard, still inside the window.
    const landed = await waitFor(
      async () => {
        const href = await cdp.evaluate('location.pathname').catch(() => null);
        return href && !/\/auth\/login/.test(href) ? href : false;
      },
      { label: 'navigation away from the login page', timeout: 30_000 }
    );

    assert.match(landed, /dashboard/i, `Expected a dashboard path, got: ${landed}`);

    // Sanity-check that authenticated chrome is present, not a login form.
    const stillLogin = await cdp.evaluate('!!document.querySelector(\'input[name="username"]\')');
    assert.equal(stillLogin, false, 'Login form still present after sign-in');

    t.diagnostic(`Signed in and landed on ${landed}`);
  } finally {
    cdp?.close();
    child.kill('SIGTERM');
    await new Promise((resolve) => child.on('exit', resolve));
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
