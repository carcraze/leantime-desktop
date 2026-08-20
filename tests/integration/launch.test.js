'use strict';

/**
 * Integration test: launches the real Electron app against a stub HTTP server
 * that stands in for a Leantime instance, then asserts on what the app actually
 * requested. This exercises config loading, main-window creation, the user-agent
 * override and in-window navigation for real, without needing a Leantime server.
 *
 * Requires the Electron binary. Skipped automatically when no display is usable.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const ELECTRON_BIN = require(path.join(PROJECT_ROOT, 'node_modules', 'electron'));

/** Requests observed by the stub server. */
const requests = [];

function startStubServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      requests.push({ url: req.url, userAgent: req.headers['user-agent'] || '' });

      if (req.url === '/favicon.ico') {
        res.writeHead(404).end();
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Stub Leantime</title></head>
<body><h1>Stub Leantime</h1>
<script>
  // Signal readiness by fetching a marker URL the test can assert on.
  fetch('/__loaded');
</script>
</body></html>`);
    });

    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('app launches, loads the configured server and sends a clean user agent', async (t) => {
  const server = await startStubServer();
  const port = server.address().port;
  const serverUrl = `http://127.0.0.1:${port}`;

  // Seed a config so the app skips the setup window and goes straight to the server.
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'leantime-desktop-it-'));
  fs.writeFileSync(
    path.join(userDataDir, 'config.json'),
    JSON.stringify({ serverUrl, window: { width: 1024, height: 768 } })
  );

  const child = spawn(
    ELECTRON_BIN,
    [
      PROJECT_ROOT,
      `--user-data-dir=${userDataDir}`,
      // Force X11/software rendering: Wayland + GPU is unreliable in headless CI
      // and on some desktop drivers, and this test is about app logic, not GPU.
      '--ozone-platform=x11',
      '--disable-gpu',
      '--in-process-gpu',
      '--no-sandbox',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } }
  );

  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  const loaded = await new Promise((resolve) => {
    const deadline = setTimeout(() => resolve(false), 30_000);
    const poll = setInterval(() => {
      if (requests.some((r) => r.url === '/__loaded')) {
        clearTimeout(deadline);
        clearInterval(poll);
        resolve(true);
      }
    }, 250);
    child.on('exit', () => {
      clearTimeout(deadline);
      clearInterval(poll);
      resolve(requests.some((r) => r.url === '/__loaded'));
    });
  });

  child.kill('SIGTERM');
  await new Promise((resolve) => child.on('exit', resolve));
  server.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });

  if (!loaded && /cannot open display|Missing X server|libgbm|No protocol specified/i.test(stderr)) {
    t.skip('No usable display for Electron in this environment');
    return;
  }

  assert.ok(loaded, `App never loaded the stub server. stderr:\n${stderr.slice(-1500)}`);

  const rootRequest = requests.find((r) => r.url === '/');
  assert.ok(rootRequest, 'App did not request the configured server root');

  // The UA must not advertise Electron or the app name, otherwise Google and
  // other identity providers reject sign-in as an embedded webview.
  assert.doesNotMatch(rootRequest.userAgent, /Electron/i, 'User agent still advertises Electron');
  assert.match(rootRequest.userAgent, /Chrome\/\d+/, 'User agent lost its Chrome version token');
});
