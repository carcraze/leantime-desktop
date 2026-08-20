'use strict';

/**
 * Unit tests for the pure config/URL logic in src/store.js.
 * store.js depends on electron's `app` for the userData path, so a stub module is
 * injected into the require cache before loading it. This keeps the tests runnable
 * under plain `node --test`, with no display or Electron binary required.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const Module = require('node:module');

const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'leantime-desktop-test-'));

// Inject a stub `electron` module.
const electronStub = { app: { getPath: () => USER_DATA } };
const stubPath = require.resolve('electron');
require.cache[stubPath] = new Module(stubPath, null);
require.cache[stubPath].filename = stubPath;
require.cache[stubPath].loaded = true;
require.cache[stubPath].exports = electronStub;

const { normaliseServerUrl, loadConfig, saveConfig, DEFAULTS } = require('../src/store.js');

test('normaliseServerUrl adds https when the scheme is omitted', () => {
  const result = normaliseServerUrl('leantime.example.com');
  assert.equal(result.ok, true);
  assert.equal(result.url, 'https://leantime.example.com');
});

test('normaliseServerUrl preserves a subfolder install path', () => {
  const result = normaliseServerUrl('https://example.com/leantime/');
  assert.equal(result.ok, true);
  assert.equal(result.url, 'https://example.com/leantime');
});

test('normaliseServerUrl keeps an explicit http scheme for LAN installs', () => {
  const result = normaliseServerUrl('http://192.168.1.50:8080');
  assert.equal(result.ok, true);
  assert.equal(result.url, 'http://192.168.1.50:8080');
});

test('normaliseServerUrl strips query strings and fragments', () => {
  const result = normaliseServerUrl('https://example.com/lt?a=1#frag');
  assert.equal(result.ok, true);
  assert.equal(result.url, 'https://example.com/lt');
});

test('normaliseServerUrl rejects an empty value', () => {
  assert.equal(normaliseServerUrl('   ').ok, false);
});

test('normaliseServerUrl rejects non-http schemes', () => {
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'ftp://example.com']) {
    const result = normaliseServerUrl(bad);
    assert.equal(result.ok, false, `${bad} should be rejected`);
  }
});

test('normaliseServerUrl rejects malformed input', () => {
  assert.equal(normaliseServerUrl('https://').ok, false);
});

test('loadConfig returns defaults when no config file exists', () => {
  const config = loadConfig();
  assert.equal(config.serverUrl, '');
  assert.equal(config.allowInsecureCerts, false);
  assert.equal(config.window.width, DEFAULTS.window.width);
});

test('saveConfig then loadConfig round-trips values', () => {
  saveConfig({
    ...DEFAULTS,
    serverUrl: 'https://pm.example.com',
    window: { width: 1024, height: 768, x: 10, y: 20, maximized: true },
  });

  const config = loadConfig();
  assert.equal(config.serverUrl, 'https://pm.example.com');
  assert.equal(config.window.width, 1024);
  assert.equal(config.window.maximized, true);
});

test('loadConfig merges partial saved config over defaults', () => {
  fs.writeFileSync(path.join(USER_DATA, 'config.json'), JSON.stringify({ serverUrl: 'https://a.example' }));
  const config = loadConfig();
  assert.equal(config.serverUrl, 'https://a.example');
  // Missing keys fall back to defaults rather than becoming undefined.
  assert.equal(config.allowInsecureCerts, false);
  assert.equal(config.window.height, DEFAULTS.window.height);
});

test('loadConfig falls back to defaults on corrupt JSON', () => {
  fs.writeFileSync(path.join(USER_DATA, 'config.json'), '{ not json');
  const config = loadConfig();
  assert.equal(config.serverUrl, '');
});

test('config file is written with owner-only permissions', () => {
  saveConfig({ ...DEFAULTS, serverUrl: 'https://b.example' });
  const mode = fs.statSync(path.join(USER_DATA, 'config.json')).mode & 0o777;
  assert.equal(mode, 0o600);
});

test.after(() => {
  fs.rmSync(USER_DATA, { recursive: true, force: true });
});
