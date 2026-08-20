# Leantime Desktop (unofficial)

A desktop client for [Leantime](https://leantime.io), packaged for Linux (Snap,
AppImage, deb), Windows (NSIS installer) and macOS (dmg).

This is a **thin client**, in the same shape as WhatsApp Desktop: it wraps a
Chromium window around a Leantime server you already run. It does not contain
Leantime itself and does not vendor a copy of the Leantime source.

> Leantime is a registered trademark of Leantime Inc. This project is not
> affiliated with, endorsed by, or supported by Leantime Inc.

## Why a thin client, and not a self-contained app

Leantime is a Laravel/PHP application requiring PHP 8.2+ with roughly fourteen
extensions and a MySQL 8 / MariaDB 10.6 server. It is not a JavaScript SPA, so
there is no bundle to simply wrap offline. Packaging the whole stack into one
desktop installer is possible (the Nextcloud snap is the precedent) but it means
shipping and supervising a database server per machine, and the resulting app is
single-user — which removes the collaboration that is the point of the product.

Wrapping a server you already run keeps the app small, keeps collaboration
intact, and — critically — means **zero changes to the Leantime tree**, so
pulling upstream monthly never conflicts.

If a fully offline single-user build is wanted later, see
[Phase 2](#phase-2-optional-self-contained-build) below.

## Requirements

* A reachable Leantime server (self-hosted or leantime.io cloud), v3.5.0+
* Node.js 20+ and npm, to build from source

## Install from source

```bash
npm ci
npm start
```

On first launch the app asks for your server address. It accepts a bare host
(`leantime.example.com`, assumed https), an explicit scheme, a non-standard port,
and subfolder installs (`https://example.com/leantime`).

To change servers later: **File → Change Server…**

## Build packages

```bash
npm run dist:linux     # snap + AppImage + deb
npm run dist:win       # NSIS installer
npm run dist:mac       # dmg
```

Cross-compiling is not supported for signed Windows/macOS output; the CI
workflow builds each platform on its own runner.

### Building the snap

There are two paths, and the easy one needs no root at all.

#### Option A — core22, no snapcraft and no LXD (recommended to get started)

```bash
npm run dist:snap:core22
```

With `base: core22` and default `stagePackages`, electron-builder assembles the
snap from a prebuilt Electron template using its own `app-builder-bin` helper.
No snapcraft, no LXD, no `sudo`. This produces a valid, publishable strict-
confinement snap (~94 MB).

#### Option B — core24, the long-term target

`base: core24` drives the real snapcraft CLI, which brings the `gnome` extension,
the `gpu-2404` graphics stack and first-class Wayland. It needs an isolated build
environment:

```bash
sudo snap install snapcraft --classic
sudo snap install lxd
sudo lxd init --minimal
sudo usermod -aG lxd "$USER"        # then: sg lxd -c '...' , or re-login
npx electron-builder --linux snap
```

**If you also run Docker on this host, the build will fail** with *"A network
related operation failed in a context of no network access."* Docker sets the
global iptables `FORWARD` policy to `drop`, which stops LXD forwarding traffic,
so the build container cannot reach the network. Allow egress for the LXD bridge:

```bash
sudo iptables  -I DOCKER-USER -i lxdbr0 -j ACCEPT
sudo ip6tables -I DOCKER-USER -i lxdbr0 -j ACCEPT
sudo iptables  -I DOCKER-USER -o lxdbr0 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
sudo ip6tables -I DOCKER-USER -o lxdbr0 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
```

These rules are not persistent across reboots; make them permanent using your
distribution's iptables-restore mechanism. Setting
`net.ipv4.conf.all.forwarding=1` is an alternative fix and is safe on Docker
28.0+, which no longer exposes container ports to the LAN as a side effect.
Reference: [LXD — configure your firewall](https://documentation.ubuntu.com/lxd/latest/howto/network_bridge_firewalld/#prevent-connectivity-issues-with-lxd-and-docker).

Swap `useLXD` for `useMultipass` in `electron-builder.yml` to build on macOS or
Windows instead.

#### Test the snap locally

```bash
sudo snap install --dangerous dist/*.snap
leantime-desktop
snap connect leantime-desktop:camera        # not auto-connected on all systems
snap connect leantime-desktop:audio-record
```

## Configuration

Stored at `<userData>/config.json`, written with `0600` permissions:

| Key | Purpose |
| --- | --- |
| `serverUrl` | Base URL of your Leantime server |
| `window` | Remembered geometry |
| `allowInsecureCerts` | Opt-in only. Accepts TLS errors **for the configured host only**. Needed for self-signed certs on a LAN box; leave `false` otherwise. |

`<userData>` is `~/.config/leantime-desktop` on Linux,
`%APPDATA%\leantime-desktop` on Windows,
`~/Library/Application Support/leantime-desktop` on macOS.

## Security posture

The renderer runs with `contextIsolation: true`, `nodeIntegration: false` and
`sandbox: true`. The preload exposes exactly two IPC methods, only to the setup
window. Beyond that:

* Only `http:` and `https:` navigation is allowed; `file:`, `data:` and
  `javascript:` URLs are blocked.
* Plain `http:` is permitted only for the configured server itself, so a LAN
  install works while cross-origin downgrades do not.
* `target=_blank` and window-open requests are handed to the system browser.
* Camera, microphone, screen-capture and notification permissions are granted
  only to the configured server origin, and every other permission is denied.
* TLS errors are fatal unless `allowInsecureCerts` is explicitly enabled.

**Known trade-off:** cross-origin *https* top-level navigation is allowed
in-window, because self-hosted SSO (Keycloak, Authentik, Gitea, Okta) can live on
any domain and must complete its redirect chain. When the window is showing a
host other than your Leantime server, the title bar displays that host in
brackets so it is visible. If you do not use SSO, you can tighten
`applyWebPolicy` in `src/main.js` to same-origin only.

The user agent is stripped of its `Electron/` token, because Google and other
identity providers refuse sign-in from user agents they identify as embedded
webviews. This is asserted by the integration test.

## Tests

```bash
npm test                 # unit: URL normalisation, config persistence
npm run test:integration # launches the real app against a stub server
npm run test:all
```

The integration test needs a display; under Wayland use
`xvfb-run --auto-servernum npm run test:integration` if you hit GPU crashes.

### Testing against a real Leantime

```bash
docker compose -f tests/fixtures/docker-compose.leantime.yml up -d
# then visit http://localhost:8099/install to complete setup,
# and point the client at http://localhost:8099
```

The image tag in that file tracks `upstream.json → testedVersion`.

## Staying current with upstream Leantime

Because this client holds no Leantime code, upstream releases cannot break the
build — only runtime compatibility matters. `.github/workflows/upstream-watch.yml`
runs on the 1st of each month, resolves the newest Leantime release, and opens a
PR updating `upstream.json` with a manual verification checklist. Merging that PR
and tagging `v*` rebuilds and republishes every artifact.

## Publishing

Tagging `v*` runs `.github/workflows/build.yml`, which builds all platforms,
attaches artifacts to a GitHub Release, and uploads the snap to the Snap Store.

Secrets used (all optional; each is skipped when unset):

| Secret | Purpose |
| --- | --- |
| `SNAPCRAFT_STORE_CREDENTIALS` | Snap Store upload. Generate with `snapcraft export-login -` |
| `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD` | macOS signing certificate |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | macOS notarisation |

### Before you can publish — open items

1. **Snap name registration.** The name in `electron-builder.yml` must be
   registered at <https://snapcraft.io/account>. A name containing a registered
   trademark can be refused or reassigned under the Snap Store dispute process.
   Get written permission from Leantime Inc. or pick an unmistakably unofficial
   name.
2. **Icon.** `build/icon.png` is a neutral generated placeholder. Do not
   substitute Leantime's logo without permission.
3. **macOS signing.** Unsigned dmg builds are blocked by Gatekeeper on first
   launch. Distributing a working macOS build needs a paid Apple Developer
   account (99 USD/year) for signing and notarisation.
4. **Windows signing.** Unsigned installers trigger SmartScreen warnings. An OV
   or EV code-signing certificate removes them.
5. **Licence review.** Leantime is AGPL-3.0. This client is an independent
   program that talks to it over HTTP and is licensed AGPL-3.0-only to stay
   compatible; confirm your intended distribution with counsel if you plan to
   diverge.

## Phase 2 (optional): self-contained build

To ship Leantime itself inside the package, the pieces are:

* **PHP + app in one binary** — [FrankenPHP](https://frankenphp.dev) can embed
  the PHP runtime and application into a single static executable. Upstream has
  an unmerged, stale experiment on the `chore/frankenphp-conversion` branch
  (a Caddyfile and dockerfile only).
* **Database** — the installer schema is MySQL-specific (`ENGINE=InnoDB`,
  `AUTO_INCREMENT`, `utf8mb4`), so SQLite is not an option without real porting
  work. PostgreSQL *is* supported (`LEAN_DB_DEFAULT_CONNECTION=pgsql`), and
  embedding PostgreSQL is more tractable than MySQL inside strict confinement.
* **Supervision** — snap can run the server and database as confined daemons;
  AppImage cannot supervise services and is a poor fit for this mode.
* **Migrations** — run `php bin/leantime system:update` on launch after backing
  up, since Leantime bumps its schema between releases.

Realistic outcome: a Linux snap in the 300–500 MB range, single-user, no
collaboration. Worth building only if offline solo use is an explicit goal.

## Licence

AGPL-3.0-only.
