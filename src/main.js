'use strict';

const path = require('node:path');
const {
  app,
  BrowserWindow,
  Menu,
  shell,
  dialog,
  ipcMain,
  session,
  net,
} = require('electron');

const { loadConfig, saveConfig, normaliseServerUrl, identifyLeantime } = require('./store');

const IS_DEV = process.argv.includes('--dev');

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {BrowserWindow | null} */
let setupWindow = null;

let config = null;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Leantime's SSO providers (Google, Microsoft, ...) reject sign-in from user agents
 * that identify as an embedded webview. Presenting a plain Chrome UA keeps OAuth
 * flows working while still being a truthful Chromium version string.
 */
function desktopUserAgent() {
  const chromeVersion = process.versions.chrome;
  const base = session.defaultSession.getUserAgent();
  return base
    .replace(/ Electron\/[\d.]+/, '')
    .replace(new RegExp(` ${app.getName().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/[\\d.]+`), '')
    .replace(/Chrome\/[\d.]+/, `Chrome/${chromeVersion}`);
}

function isSameOrigin(targetUrl, origin) {
  try {
    return new URL(targetUrl).origin === origin;
  } catch {
    return false;
  }
}

function serverOrigin() {
  try {
    return new URL(config.serverUrl).origin;
  } catch {
    return null;
  }
}

/**
 * Absolute path to the bundled window icon.
 *
 * Linux desktops prefer the icon from the matched .desktop entry, but they can
 * only match a window to an entry when StartupWMClass equals the window's
 * WM_CLASS. When that lookup fails the window falls back to _NET_WM_ICON, and
 * Electron does not set that property unless an icon is supplied explicitly —
 * which is why an unmatched window shows a generic placeholder. Setting it here
 * guarantees a real icon either way.
 *
 * macOS ignores this and uses the icon from the application bundle.
 */
const WINDOW_ICON = path.join(__dirname, 'assets', 'icon.png');

/* -------------------------------------------------------------------------- */
/* Server verification                                                        */
/* -------------------------------------------------------------------------- */

/** Oldest Leantime release this client is known to work against. */
const MINIMUM_VERSION = '3.5.0';

function isVersionBelow(version, minimum) {
  const a = version.split('.').map(Number);
  const b = minimum.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] || 0) < (b[i] || 0)) return true;
    if ((a[i] || 0) > (b[i] || 0)) return false;
  }
  return false;
}

/**
 * Probes a candidate address to confirm a real Leantime server is listening,
 * so a typo or an unrelated website is caught before it is saved.
 *
 * Uses Electron's net stack rather than global fetch so it honours the same
 * proxy settings and certificate policy as the app window.
 *
 * @param {string} baseUrl already normalised
 * @returns {Promise<{ok: boolean, version?: string|null, error?: string}>}
 */
async function verifyServer(baseUrl) {
  const target = `${baseUrl}/auth/login`;

  let response;
  try {
    response = await net.fetch(target, {
      method: 'GET',
      redirect: 'follow',
      // Cloud Run and similar platforms cold-start, so allow a generous window.
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    const message = String(err?.message || err);
    if (/ERR_CERT|certificate/i.test(message)) {
      return {
        ok: false,
        error: 'The server\'s security certificate could not be verified. If this is a local server with a self-signed certificate, enable allowInsecureCerts in the config file.',
      };
    }
    if (/ERR_NAME_NOT_RESOLVED|getaddrinfo/i.test(message)) {
      return { ok: false, error: 'That address could not be found. Check the spelling.' };
    }
    if (/timed out|AbortError|ERR_TIMED_OUT/i.test(message)) {
      return { ok: false, error: 'The server did not respond in time. It may be asleep or unreachable.' };
    }
    if (/ERR_CONNECTION_REFUSED/i.test(message)) {
      return { ok: false, error: 'Connection refused. Is Leantime running on that address and port?' };
    }
    return { ok: false, error: `Could not reach the server (${message}).` };
  }

  const body = await response.text().catch(() => '');
  const result = identifyLeantime({
    status: response.status,
    body,
    csp: response.headers.get('content-security-policy') || '',
  });

  if (!result.ok) {
    switch (result.reason) {
      case 'auth-required':
        return { ok: false, error: 'The server answered but requires authentication before Leantime is reachable (for example a proxy login). This client cannot pass that.' };
      case 'server-error':
        return { ok: false, error: `The server returned an error (HTTP ${response.status}). Leantime may be starting up or misconfigured.` };
      case 'unexpected-status':
        return { ok: false, error: `Unexpected response (HTTP ${response.status}). Check the address, including any subfolder.` };
      default:
        return { ok: false, error: 'That address responded, but it does not look like a Leantime server.' };
    }
  }

  if (result.version && isVersionBelow(result.version, MINIMUM_VERSION)) {
    return {
      ok: false,
      error: `That server runs Leantime ${result.version}. This client needs ${MINIMUM_VERSION} or newer.`,
    };
  }

  return { ok: true, version: result.version };
}

/* -------------------------------------------------------------------------- */
/* Window hardening                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Applies navigation and permission policy to a web contents.
 *
 * Policy:
 *  - Same-origin navigation: allowed in-window.
 *  - Cross-origin https navigation: allowed in-window, because self-hosted SSO
 *    (Keycloak, Authentik, Gitea, ...) can live on any domain and must complete
 *    its redirect chain. The window title shows the foreign host so the user can
 *    always see when they are off the Leantime server.
 *  - Anything that is not http/https (file:, data:, javascript:): blocked.
 *  - New windows / target=_blank: handed to the system browser.
 */
function applyWebPolicy(contents) {
  const origin = serverOrigin();

  contents.on('will-navigate', (event, url) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      event.preventDefault();
      return;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      event.preventDefault();
      return;
    }

    // Allow plain http only for the configured server itself (LAN installs).
    if (parsed.protocol === 'http:' && parsed.origin !== origin) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  contents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        shell.openExternal(url);
      }
    } catch {
      /* ignore malformed URLs */
    }
    return { action: 'deny' };
  });

  // Leantime offers screen and webcam recording plus in-app notifications.
  // Grant only those, and only to the configured server origin.
  contents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    const requesting = webContents.getURL();
    const allowed = ['notifications', 'media', 'display-capture', 'clipboard-sanitized-write', 'fullscreen'];
    callback(allowed.includes(permission) && isSameOrigin(requesting, origin));
  });
}

/**
 * Certificate errors are fatal by default. A user running Leantime on a LAN box
 * with a self-signed certificate can opt in via the config file, and even then the
 * exception is scoped to the configured host only.
 */
function installCertificateHandler() {
  app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
    const origin = serverOrigin();
    if (config.allowInsecureCerts && origin && isSameOrigin(url, origin)) {
      event.preventDefault();
      callback(true);
      return;
    }
    callback(false);
  });
}

/* -------------------------------------------------------------------------- */
/* Windows                                                                    */
/* -------------------------------------------------------------------------- */

function createSetupWindow() {
  if (setupWindow) {
    setupWindow.focus();
    return;
  }

  setupWindow = new BrowserWindow({
    width: 560,
    height: 420,
    resizable: false,
    title: 'Connect to Leantime',
    icon: WINDOW_ICON,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  setupWindow.loadFile(path.join(__dirname, 'renderer', 'setup.html'));
  setupWindow.on('closed', () => {
    setupWindow = null;
    // Closing setup without a configured server leaves nothing to show.
    if (!config.serverUrl && !mainWindow) {
      app.quit();
    }
  });
}

function createMainWindow() {
  const bounds = config.window || {};

  mainWindow = new BrowserWindow({
    width: bounds.width || 1400,
    height: bounds.height || 900,
    x: bounds.x,
    y: bounds.y,
    minWidth: 900,
    minHeight: 600,
    title: 'Leantime',
    icon: WINDOW_ICON,
    backgroundColor: '#f2f3f8',
    autoHideMenuBar: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });

  if (bounds.maximized) {
    mainWindow.maximize();
  }

  applyWebPolicy(mainWindow.webContents);

  const origin = serverOrigin();
  mainWindow.webContents.on('page-title-updated', (event, title) => {
    event.preventDefault();
    const current = mainWindow.webContents.getURL();
    if (origin && !isSameOrigin(current, origin)) {
      let host = 'external site';
      try {
        host = new URL(current).host;
      } catch { /* keep fallback */ }
      mainWindow.setTitle(`${title} — [${host}]`);
    } else {
      mainWindow.setTitle(title || 'Leantime');
    }
  });

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    // -3 is ERR_ABORTED, produced by ordinary redirect cancellation.
    if (!isMainFrame || errorCode === -3) {
      return;
    }
    dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'Cannot reach Leantime',
      message: `Could not load ${config.serverUrl}`,
      detail: `${errorDescription} (${errorCode})\n\nCheck that the server is running and the address is correct.`,
      buttons: ['Retry', 'Change server…', 'Quit'],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 0) {
        mainWindow.loadURL(config.serverUrl);
      } else if (response === 1) {
        createSetupWindow();
      } else {
        app.quit();
      }
    });
  });

  const persistBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const maximized = mainWindow.isMaximized();
    const normal = mainWindow.getNormalBounds();
    config.window = { ...normal, maximized };
    saveConfig(config);
  };

  mainWindow.on('resize', persistBounds);
  mainWindow.on('move', persistBounds);
  mainWindow.on('close', persistBounds);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.loadURL(config.serverUrl);
}

/* -------------------------------------------------------------------------- */
/* Menu                                                                      */
/* -------------------------------------------------------------------------- */

function buildMenu() {
  const template = [
    ...(process.platform === 'darwin'
      ? [{ role: 'appMenu' }]
      : []),
    {
      label: '&File',
      submenu: [
        {
          label: 'Change Server…',
          click: () => createSetupWindow(),
        },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: '&Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: '&View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        {
          label: 'Back',
          accelerator: 'Alt+Left',
          click: () => mainWindow?.webContents.navigationHistory.canGoBack() && mainWindow.webContents.navigationHistory.goBack(),
        },
        {
          label: 'Forward',
          accelerator: 'Alt+Right',
          click: () => mainWindow?.webContents.navigationHistory.canGoForward() && mainWindow.webContents.navigationHistory.goForward(),
        },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(IS_DEV ? [{ role: 'toggleDevTools' }] : []),
      ],
    },
    {
      label: '&Help',
      submenu: [
        {
          label: 'Leantime Documentation',
          click: () => shell.openExternal('https://docs.leantime.io'),
        },
        {
          label: 'About',
          click: () => {
            dialog.showMessageBox({
              type: 'info',
              title: 'About Leantime Desktop',
              message: `Leantime Desktop ${app.getVersion()}`,
              detail:
                'An unofficial desktop client for Leantime.\n' +
                `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}\n\n` +
                `Server: ${config.serverUrl || 'not configured'}\n\n` +
                'Leantime is a registered trademark of Leantime Inc. ' +
                'This client is not affiliated with or endorsed by Leantime Inc.',
            });
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* -------------------------------------------------------------------------- */
/* IPC (setup window)                                                        */
/* -------------------------------------------------------------------------- */

ipcMain.handle('config:get', () => ({ serverUrl: config.serverUrl }));

/** Validates and probes an address without saving it. */
ipcMain.handle('config:testServer', async (event, rawUrl) => {
  const parsed = normaliseServerUrl(rawUrl);
  if (!parsed.ok) {
    return parsed;
  }
  const probe = await verifyServer(parsed.url);
  return probe.ok
    ? { ok: true, url: parsed.url, version: probe.version }
    : { ok: false, error: probe.error };
});

ipcMain.handle('config:setServer', async (event, rawUrl) => {
  const result = normaliseServerUrl(rawUrl);
  if (!result.ok) {
    return result;
  }

  // Never persist an address we could not confirm is a Leantime server.
  const probe = await verifyServer(result.url);
  if (!probe.ok) {
    return { ok: false, error: probe.error };
  }

  const changed = result.url !== config.serverUrl;
  config.serverUrl = result.url;
  saveConfig(config);

  if (setupWindow) {
    setupWindow.close();
  }

  if (!mainWindow) {
    createMainWindow();
  } else if (changed) {
    // A different server means a different session; reload from the new root.
    applyWebPolicy(mainWindow.webContents);
    mainWindow.loadURL(config.serverUrl);
  }

  buildMenu();
  return { ok: true, url: result.url };
});

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                 */
/* -------------------------------------------------------------------------- */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else if (setupWindow) {
      setupWindow.focus();
    }
  });

  app.whenReady().then(() => {
    config = loadConfig();

    session.defaultSession.setUserAgent(desktopUserAgent());
    installCertificateHandler();
    buildMenu();

    if (config.serverUrl) {
      createMainWindow();
    } else {
      createSetupWindow();
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        if (config.serverUrl) createMainWindow();
        else createSetupWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  // Defence in depth: refuse any attempt to attach node integration to new contents.
  app.on('web-contents-created', (event, contents) => {
    contents.on('will-attach-webview', (attachEvent, webPreferences) => {
      delete webPreferences.preload;
      webPreferences.nodeIntegration = false;
      webPreferences.contextIsolation = true;
    });
  });
}
