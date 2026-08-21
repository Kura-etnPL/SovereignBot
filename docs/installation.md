# Portable installation and release artifacts

SovereignBot is designed to be installable without a global npm install, administrator/root access, PATH/profile mutation, a system service, or a background updater.

The current portable distribution requires **Node.js 22+** and a system `tar` command. SovereignBot itself has zero third-party Node runtime dependencies.

## Release artifacts

`npm run build:release` creates deterministic artifacts under `dist/`:

- `sovereignbot-<version>.tar.gz`
- `sovereignbot-<version>.tar.gz.sha256`
- `release-manifest.json`
- `portable-install.mjs`
- `install.ps1`
- `install.sh`

The release manifest records:

- archive file name, byte size, SHA-256, format and declared root;
- minimum supported Node major version;
- every shipped payload file with SHA-256 and byte size;
- each installer/bootstrap asset with SHA-256 and byte size.

The archive is deterministic: identical source at the same version produces byte-identical archive output.

## What the package contains

The portable app payload contains the supported product surface:

- `src/`
- `sidecars/`
- `ui/`
- `docs/`
- `examples/`
- `package.json`
- `README.md`
- `LICENSE`
- `SECURITY.md`

It does not intentionally package tests, `.git`, `node_modules`, `.sovereignbot` runtime state, coverage, or build output.

## Installation boundary

Both platform wrappers use the same `portable-install.mjs` transaction core.

Before executing that core, the wrapper reads the release manifest, locates the declared `portable-install.mjs` asset hash, computes the actual SHA-256 of the selected/downloaded core, and refuses execution on mismatch.

The wrappers also refuse a symlink/reparse-point install/bootstrap path rather than recursively cleaning through an attacker-controlled link.

The Node installer then:

1. loads the local or HTTPS release manifest;
2. validates the manifest schema and path fields;
3. validates Node.js 22+;
4. obtains the archive;
5. verifies archive byte size and SHA-256;
6. checks tar paths and exact manifest membership;
7. rejects non-regular tar entries (symlink, hardlink, directory, device, FIFO, etc.) before extraction;
8. extracts into a staging directory under the selected install root;
9. re-hashes every extracted file against the manifest;
10. runs the staged CLI with `--help` before replacing the installed app;
11. swaps the application directory transactionally;
12. creates a local launcher under `<install>/bin`;
13. writes `install-manifest.json`;
14. removes staging state after completion.

A corrupt archive is rejected before the installed app is replaced.

## Upgrade and rollback

Application files live under:

```text
<install>/app
```

Launchers live under:

```text
<install>/bin
```

An upgrade stages and verifies the new app first, then moves the previous app aside and swaps the new app into place. If a later launcher/manifest step fails, the previous app is restored.

Windows filesystem/antivirus races on rename/remove (`EPERM`, `EBUSY`, `EACCES`) receive bounded retry; permanent errors are not retried indefinitely.

Installer-owned launcher/manifest files are also replaced transactionally. If both replacement and rollback of one of these files fail, the installer preserves the last recoverable `.old-*` backup and surfaces both errors instead of deleting the final recovery point.

Files unrelated to the installer-owned app/launcher/manifest paths are not deleted by normal reinstall/upgrade.

## Windows

For a prepared local release directory:

```powershell
pwsh -NoProfile -File .\install.ps1 `
  -InstallDir "$env:LOCALAPPDATA\SovereignBot" `
  -Manifest .\release-manifest.json `
  -InstallerCore .\portable-install.mjs
```

The launcher is:

```text
<install>\bin\sovereignbot.cmd
```

## macOS / Linux

For a prepared local release directory:

```sh
sh ./install.sh \
  --install-dir "$HOME/.local/share/sovereignbot" \
  --manifest ./release-manifest.json \
  --installer-core ./portable-install.mjs
```

The launcher is:

```text
<install>/bin/sovereignbot
```

## Remote release source

The production default points at the GitHub Releases `latest/download` asset path over HTTPS. The installer does not use a moving `main` branch as a release source.

A public GitHub Release is intentionally separate from building/testing release artifacts. The release-artifact workflow has read-only repository contents permission and only uploads a GitHub Actions artifact; it cannot publish a public Release by itself.

## What installation does not do

Installation does **not** automatically:

- modify `PATH`;
- edit shell profiles;
- write Windows registry entries;
- create a system service;
- create a scheduled task;
- install a global npm package;
- start SovereignBot in the background;
- expose the operator console publicly;
- configure Cloudflare or a domain.

Those are separate, explicit operational choices.

## CI acceptance

The installer/release pipeline is covered by:

- deterministic release build tests;
- archive corruption refusal;
- non-regular tar entry refusal;
- local install and launcher `--help`;
- reinstall preserving unrelated files;
- failed-upgrade app rollback;
- installer-owned file rollback failure preserving the final backup;
- invalid Node version and unsafe manifest-path refusal;
- wrapper refusal of a tampered installer core;
- real POSIX bootstrap install on Ubuntu;
- real PowerShell bootstrap install on Windows;
- the existing Ubuntu/Windows Node 22/24 core matrix;
- real Chrome + governed MCP browser E2E.

No public release should be treated as trusted merely because artifact generation succeeded; an intentional version/release review remains required before publishing a stable tag.