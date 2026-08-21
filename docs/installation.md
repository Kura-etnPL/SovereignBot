# Portable installation and release artifacts

SovereignBot can be distributed as a verified portable application without a global npm install.

The runtime has zero third-party Node dependencies, so the release payload contains the application files directly and uses the user's existing Node.js 22+ runtime.

## Security model

The installer deliberately does **not**:

- require administrator/root access;
- run `npm install` or modify global npm state;
- edit `PATH` or shell profiles;
- write the Windows registry;
- create services or scheduled tasks;
- create background update daemons;
- install from a moving `main` branch;
- publish releases automatically.

Remote installation sources must use HTTPS and are expected to be immutable GitHub Release assets.

## Release bundle

Build locally with:

```bash
npm run build:release
```

`dist/` contains:

- `sovereignbot-<version>.tar.gz`
- `sovereignbot-<version>.tar.gz.sha256`
- `release-manifest.json`
- `portable-install.mjs`
- `install.ps1`
- `install.sh`

The release manifest contains:

- schema/package/version metadata;
- minimum Node major version;
- archive file, size, SHA-256, format, and declared root;
- SHA-256 + size for every file inside the application payload;
- hashes for the standalone installer assets.

The tar/gzip builder uses fixed metadata and sorted file paths so identical source produces a byte-identical archive.

## Install from a locally built release

### Windows PowerShell

```powershell
npm run build:release
./install/install.ps1 `
  -InstallDir "D:\Tools\SovereignBot" `
  -Manifest (Resolve-Path ./dist/release-manifest.json).Path `
  -InstallerCore (Resolve-Path ./dist/portable-install.mjs).Path
```

### macOS / Linux

```bash
npm run build:release
sh install/install.sh \
  --install-dir "$HOME/.local/share/sovereignbot" \
  --manifest "$PWD/dist/release-manifest.json" \
  --installer-core "$PWD/dist/portable-install.mjs"
```

The resulting launcher is:

```text
Windows:       <install>/bin/sovereignbot.cmd
macOS/Linux:   <install>/bin/sovereignbot
```

No PATH change is made. Invoke that launcher directly, or add its directory to PATH yourself if you intentionally want to.

## Future install from an intentional public release

The bootstrap wrappers default to:

```text
https://github.com/Kura-etnPL/SovereignBot/releases/latest/download/release-manifest.json
```

They derive the installer core and archive from the same immutable release asset directory.

This repository change **does not itself publish a GitHub Release**. The commands below are useful only after a maintainer intentionally publishes verified release assets.

Prefer downloading the wrapper first instead of piping remote text directly into a shell.

### Windows

```powershell
Invoke-WebRequest \
  https://github.com/Kura-etnPL/SovereignBot/releases/latest/download/install.ps1 \
  -OutFile ./install-sovereignbot.ps1

./install-sovereignbot.ps1 -InstallDir "D:\Tools\SovereignBot"
Remove-Item ./install-sovereignbot.ps1
```

### macOS / Linux

```bash
curl -fL \
  https://github.com/Kura-etnPL/SovereignBot/releases/latest/download/install.sh \
  -o ./install-sovereignbot.sh

sh ./install-sovereignbot.sh --install-dir "$HOME/.local/share/sovereignbot"
rm ./install-sovereignbot.sh
```

## Verification sequence

Before application replacement, the Node installer core performs this sequence:

1. validate the release manifest schema and safe relative paths;
2. require Node.js at or above the declared major version;
3. download/copy the archive into a staging directory under the chosen install root;
4. verify archive size and SHA-256;
5. list the tar without extracting and reject absolute paths, `..`, wrong roots, missing manifest files, or unmanifested files;
6. extract into staging;
7. verify every extracted file's size and SHA-256;
8. run the staged CLI with `--help`;
9. replace only `<install>/app`;
10. create/update the known launcher under `<install>/bin`;
11. persist `install-manifest.json`;
12. remove staging.

If a post-swap step fails, the previous application directory is restored.

## Upgrade and data separation

The installer owns only known application locations:

```text
<install>/app
<install>/bin/sovereignbot[.cmd]
<install>/install-manifest.json
<install>/.staging   (temporary)
<install>/.bootstrap (temporary wrapper bootstrap)
```

Unrelated files under the install root are preserved.

SovereignBot project/runtime state is not stored inside the release application's `app` directory. Normal `.sovereignbot/` state remains workspace/config scoped, so replacing the portable application payload does not delete task, memory, audit, computer, or policy state.

## CI

Normal CI tests the Node installer core on Ubuntu/Windows Node 22/24 and also executes the real wrappers:

- Linux `install.sh` → installed launcher `--help`
- Windows `install.ps1` → installed launcher `--help`

The release-artifact workflow is intentionally non-publishing. It has `contents: read`, verifies a tag matches `package.json`, builds the release bundle, and uploads it only as a temporary GitHub Actions artifact for maintainer inspection.
