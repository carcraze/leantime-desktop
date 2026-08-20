'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const CONFIG_FILE = 'config.json';

const DEFAULTS = {
  // Base URL of the Leantime server this client connects to, e.g. https://pm.example.com
  serverUrl: '',
  // Remembered window geometry.
  window: { width: 1400, height: 900, x: undefined, y: undefined, maximized: false },
  // Opt-in only. Allows TLS errors for the configured host (self-signed certs on a LAN box).
  // Off by default: enabling it weakens transport security for this app.
  allowInsecureCerts: false,
};

function configPath() {
  return path.join(app.getPath('userData'), CONFIG_FILE);
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULTS,
      ...parsed,
      window: { ...DEFAULTS.window, ...(parsed.window || {}) },
    };
  } catch {
    return { ...DEFAULTS, window: { ...DEFAULTS.window } };
  }
}

function saveConfig(config) {
  const target = configPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Write-then-rename so a crash mid-write cannot truncate an existing config.
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, target);
}

/**
 * Validates and normalises a user-supplied server URL.
 * Only http/https are accepted; anything else (file:, javascript:, data:) is rejected
 * so a malformed config cannot be used to load local resources into the app window.
 *
 * @param {string} input
 * @returns {{ok: true, url: string, origin: string} | {ok: false, error: string}}
 */
function normaliseServerUrl(input) {
  const trimmed = String(input || '').trim();
  if (!trimmed) {
    return { ok: false, error: 'Enter your Leantime server address.' };
  }

  // Default to https when the user omits the scheme.
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;

  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { ok: false, error: 'That does not look like a valid address.' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'Only http:// and https:// addresses are supported.' };
  }
  if (!parsed.hostname) {
    return { ok: false, error: 'Missing host name.' };
  }

  // Preserve any subfolder path (Leantime supports subfolder installs) but drop
  // query/fragment and collapse a trailing slash.
  const basePath = parsed.pathname.replace(/\/+$/, '');
  const url = `${parsed.origin}${basePath}`;

  return { ok: true, url, origin: parsed.origin };
}

/**
 * Decides whether an HTTP response looks like a real Leantime installation.
 *
 * Deliberately avoids the page title and site name, because LEAN_SITENAME is
 * user-configurable and a renamed instance would fail. Instead it relies on two
 * markers that Leantime emits regardless of configuration:
 *
 *  1. Versioned asset paths, e.g. /dist/css/main.3.9.8.min.css — this also
 *     yields the version, so the caller can warn about unsupported releases.
 *  2. The Content-Security-Policy header, which hardcodes *.leantime.io in
 *     img-src.
 *
 * A third fallback is the /api/jsonrpc endpoint answering {"error":"Unauthorized"}.
 *
 * @param {{status: number, body: string, csp?: string}} response
 * @returns {{ok: true, version: string|null, signal: string} | {ok: false, reason: string}}
 */
function identifyLeantime({ status, body = '', csp = '' }) {
  if (status === 401 || status === 403) {
    // Reachable but gated by an external proxy or auth layer.
    return { ok: false, reason: 'auth-required' };
  }
  if (status >= 500) {
    return { ok: false, reason: 'server-error' };
  }
  if (status !== 200) {
    return { ok: false, reason: 'unexpected-status' };
  }

  // Marker 1: versioned asset path, which also carries the version number.
  const asset = body.match(/\/dist\/(?:css|js)\/[a-z-]*?\.?(\d+\.\d+\.\d+)\.min\.(?:css|js)/i);
  if (asset) {
    return { ok: true, version: asset[1], signal: 'asset-version' };
  }

  // Marker 2: Leantime's own CSP allowlist.
  if (/img-src[^;]*\*\.leantime\.io/i.test(csp)) {
    return { ok: true, version: null, signal: 'csp' };
  }

  // Marker 3: an unversioned dist path still indicates Leantime's asset layout.
  if (/\/dist\/(?:css|js)\/[^"']*\.min\.(?:css|js)/i.test(body)) {
    return { ok: true, version: null, signal: 'asset-path' };
  }

  return { ok: false, reason: 'not-leantime' };
}

module.exports = { loadConfig, saveConfig, normaliseServerUrl, identifyLeantime, configPath, DEFAULTS };
