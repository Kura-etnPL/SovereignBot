# SovereignBot Desktop 3.0.0

3.0.0 is the Windows GA for the V3 Coworker Desktop: the app now ships as a real double-clickable product — bilingual UI, Windows launchers, keyboard access, and a hardened packaging identity at `3.0.0`.

`desktop-v1.1.1` assets remain published and immutable; nothing was rewritten. (v1.1.1 corrects the Desktop provider wiring — this 3.0.0 GA builds directly on the proven 1.1.1 foundation.)

## What is actually true in 3.0.0

- **Bilingual product UI.** System / 简体中文 / English with immediate in-place switching and `document.documentElement.lang` tracking. Default coworker display names map only for exact factory defaults (`Chief of Staff → 幕僚长`, `Coding Lead → 编程主管`, `Researcher → 研究员`); user-renamed values are shown verbatim. User content (messages, files, artifacts, skills) is never auto-translated.
- **Windows launchers.** After `SovereignBot-3.0.0 Setup.exe --silent`, both Start Menu (`sovereignbot/SovereignBot.lnk`) and Desktop (`SovereignBot.lnk`) launch the installed `app-3.0.0/SovereignBot.exe`. Shortcuts are removed on uninstall.
- **Keyboard access that does not steal editing keys.** Ctrl+, Settings · Ctrl+N new Chief conversation · Ctrl+Shift+C Computer · Ctrl+Shift+A Activity · Esc closes transient panels. Tray dialogs and notifications keep their localized variants.
- **Stable packaging.** Desktop is built exclusively through `resources/node/node.exe v22.23.2` (`scripts/run-forge-with-internal-node.mjs`); host Node v24 no longer drives `Finalizing package`. `release-manifest.json` binds artifact SHAs to the exact commit, pinned Electron zip, internal Node manifest, and vendored Core manifest.
- **Unchanged trust boundary.** Trusted workspace binding, governed browser/computer, secret channel, repeat guard, and `desktop-v3.0.0` / `v3.0.0` provenance-bound publication are unchanged from the 1.1.1 foundation.

## Install

Download `SovereignBot-3.0.0 Setup.exe`, verify its SHA-256 against `SHA256SUMS.txt`, double-click to install, then start from either the Start Menu or Desktop shortcut.
