# SovereignBot V3 GA — 2026-08-28

## Commit
- Worktree: `E:/Eternal/Auto_Empire/worktrees/sovereign-v3-ga`
- Branch: `feature/v3-ga`
- Base: `c79b79f75303f6c00982b124af9ee2d397bd44d6` (origin/main PR #89)
- GA commit: pending push (see git log below)

## Version
- `3.0.0` — `package.json` / `src/version.js` / `desktop/package.json` aligned
- Installer: `SovereignBot-3.0.0 Setup.exe`
- Nupkg: `sovereignbot-3.0.0-full.nupkg`
- Install dir: `C:\Users\Eternal\AppData\Local\sovereignbot\app-3.0.0`

## Language
- zh-CN: PASS (System/zh-CN/en switch, zh* → zh-CN, t fallback, document.documentElement.lang)
- English: PASS
- Dynamic switch: PASS (no restart, persistence via settings.json)

## Windows Shortcuts
- Desktop `C:/Users/Eternal/Desktop/SovereignBot.lnk`: PASS
- Start Menu `C:/Users/Eternal/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/GitHub, Inc/SovereignBot.lnk`: PASS
- Squirrel `--createShortcut` creates both; `--removeShortcut` cleans up
- Double-click launches `app-3.0.0/SovereignBot.exe`: PASS

## Keyboard Shortcuts
- Ctrl+, Settings: PASS (hidden Menu accelerator)
- Ctrl+N new Chief conversation: PASS
- Ctrl+Shift+C Computer: PASS
- Ctrl+Shift+A Activity: PASS
- Esc close panels/dialogs: PASS
- No theft of Ctrl+C/V/X/A/Z, textarea guard intact

## Packaged Smoke
- `out/SovereignBot-win32-x64/SovereignBot.exe --desktop-smoke` with `FAKE_PROVIDER_DIR=e2e/fixtures`: **PASS 15/15**
- `fakePipeline` / `trustedCwd` / `resumeContinuity` / `noSessionLeak` all true
- ASAR contains `src/i18n.js` + `ui/i18n.js` + `ui/index.html`

## Installed Smoke
- `C:/Users/Eternal/AppData/Local/sovereignbot/app-3.0.0/SovereignBot.exe --desktop-smoke` with fake providers: **PASS 15/15**
- `app-3.0.0` verified, `Update.exe` + `app.asar` present

## Real Codex Short Regression
- Not re-run in this GA pass (already proven: Chief → Researcher → Coding Lead → Chief, smoke covers pipeline)

## Persistence
- `desktop-state/settings.json` language field survives restart (tested via normalizeSettings + atomic save)

## Installer Artifacts
- Setup: `desktop/out/make/squirrel.windows/x64/SovereignBot-3.0.0 Setup.exe`
- SHA256 Setup: `fe073cf121004d2cd10c44789ca2dd8287a5caa29504ccec3ea87bc160b4cbde`
- SHA256 Nupkg: `bda47c418ce69c3b739fedabe4371040ede725953c0feaf8da1111cc5e294046`
- Internal Node: `resources/node/node.exe v22.23.2 sha 0d0f5e39f9f3d9587bc19f73eab3c2c9c4903fd02d6dbf9c853dd81b3d95fad4`
- Fuses: verified via `postPackage` hook

## Tests
- `desktop/test/i18n.test.mjs` 4/4 PASS
- `desktop/test/version-freeze.test.mjs` 3/3 PASS
- `tests/release-version.test.js` 1/1 PASS

## Remaining Non-blocking
- Squirrel Start Menu path is `GitHub, Inc/SovereignBot.lnk` (author-derived) — not a product issue, installer E2E already validates existence
- Portable installer tar tests unrelated to desktop GA (ignored)

## Branch / PR
- Branch `feature/v3-ga` ready to push; PR to be opened via ChatGPT
