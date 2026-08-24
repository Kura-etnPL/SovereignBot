# SovereignBot Desktop

SovereignBot Desktop is the Windows-first Electron application that turns the released
local-first Core into a double-click product: no terminal, no manual operator tokens, no
Node.js prerequisite. This document covers architecture and security baseline for the v1.1
development line; user-facing installation docs ship with the release.

## Layout

```
desktop/
  package.json            separate package; all Electron/Forge tooling lives here, never in Core
  forge.config.js         packaging configuration; Squirrel maker + postPackage fuse hook
  src/main/               main process: window, protocol, IPC, RuntimeHost, goal controller,
                          tray/lifecycle, internal Node
  src/main/lib/           pure logic shared with tests (asset allowlist, IPC schema, resolvers,
                          workspaces, safe zip, provider discovery, driver provisioning)
  src/main/preload.cjs    sandboxed contextBridge surface (enumerated API only)
  ui/                     local renderer assets served over sovereignbot://app
  scripts/                sync-core, fetch-node, fuses, packaged smoke, installer E2E,
                          release manifest, secret scan
  test/                   plain-Node unit tests (no Electron required)
  vendor/core/            build-time copy of the Core payload + SHA-256 manifest (gitignored)
  resources/node/         pinned internal node.exe (gitignored; hash-pinned by committed manifest)
```

Core stays a zero-runtime-dependency Node package. The Desktop never edits Core sources; it
consumes a verified vendored copy.

## Security baseline (v1.1 foundation)

| Control | State |
|---|---|
| Renderer sandbox / nodeIntegration / contextIsolation | `true` / `false` / `true`, plus app-level `enableSandbox()` |
| Custom protocol | `sovereignbot://app` registered standard+secure; exact-match asset allowlist, no path resolution |
| CSP | `default-src 'none'; script-src 'self'; ...` enforced via meta tag; remote content impossible to load |
| Navigation | `will-navigate` restricted to the app scheme; `setWindowOpenHandler` denies popups; `<webview>` attach refused |
| DevTools | disabled outside explicit smoke mode; auto-closed if opened |
| IPC | enumerated channels only; per-call sender identity check against the main window's webContents; schema+size validated payloads; no generic `(channel, payload)` escape hatch |
| Fuses | RunAsNode off, cookie encryption on, NODE_OPTIONS off, inspect off, ASAR-integrity on, OnlyLoadAppFromAsar on — flipped and re-verified on every packaged build |
| Secrets | renderer has no access to durable tokens, provider sessions, or harness state |

## Internal Node runtime (`process.execPath` trap)

Inside Electron, `process.execPath` is the Electron executable, and with the RunAsNode fuse
disabled it can never execute JS children again. The governed MCP bridge, the WebDriver
sidecar, and npm-shim provider launchers therefore resolve their interpreter through
`SOVEREIGNBOT_INTERNAL_NODE`:

- Core side (`src/internal-node.js`) honors the env override and falls back to
  `process.execPath` so plain CLI behavior is byte-for-byte unchanged.
- Desktop side pins an official Node LTS binary: `resources/node-runtime.manifest.json`
  commits the exact version + official SHA-256; `scripts/fetch-node.mjs` downloads only that
  URL and verifies the hash fail-closed; RuntimeHost re-verifies before every startup and then
  exports the variable for all Core child launches.
- Updates require a reviewed PR changing version and hash together. No "latest" fetches.

## Vendor integrity

`scripts/sync-core.mjs` copies `src/` + `sidecars/` (+ root `package.json`) into
`desktop/vendor/core` with a SHA-256 manifest. Startup refuses to run when any file is
missing, undeclared, or altered, so a stale copy cannot silently serve old Core behavior.

## Development

```powershell
# repo root
npm ci && npm run check && npm test

cd desktop
npm ci                 # installs pinned Electron toolchain
npm run fetch-node     # download + hash-verify pinned internal node.exe
npm run sync-core      # refresh vendored Core payload
npm run check && npm test
npm run make           # forge make (win32-x64): packages, fuses via postPackage hook,
                       # builds Squirrel SovereignBot-Setup.exe
npm run verify-fuses   # verify-only fuse wire assertion on the packaged exe
npm run smoke:packaged # headless window/IPC/Core smoke against the packaged exe
npm run installer-e2e  # silent-install the Setup.exe, then smoke the installed exe
npm run release-manifest # write out/release-manifest.json (provenance record)
```

Smoke mode (`--desktop-smoke`) is the only test hook in the app. It is unreachable without the
explicit argv flag, uses a temporary dataDir, fake providers only, prints one machine-readable
JSON result, and exits. Production builds contain no other backdoor.

## Installer and provenance

`electron-forge make` produces `SovereignBot-Setup.exe` plus the Squirrel `RELEASES`/nupkg set.
Fuses are flipped inside the packaging pipeline (Forge `postPackage`) — before Squirrel hashes
the payload — and re-verified read-only afterwards. Desktop CI silently installs the produced
Setup.exe on a clean Windows runner and runs the installed executable through the same smoke
gate. `out/release-manifest.json` binds every artifact SHA-256 to its pinned inputs: the
official Electron distribution zip hash, the internal Node runtime manifest, and the vendored
Core manifest digest.

## Current limitations (v1.1 line)

- The packaged build is not yet signed; SmartScreen may warn. Signing status will be stated
  honestly in release notes.
