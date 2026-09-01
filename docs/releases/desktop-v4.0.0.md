# SovereignBot Desktop 4.0.0

Desktop 4.0.0 is the stable V4 Windows product identity and the local RC/release boundary for the Electron Forge + Squirrel packaging path.

## Local RC and stable release rules

The local RC path is explicit: set `SOVEREIGNBOT_RELEASE_MODE=rc` and produce unsigned artifacts only when the release manifest says `release.signature.status=unsigned`. Stable packaging requires `SOVEREIGNBOT_WINDOWS_CERTIFICATE_FILE` and `SOVEREIGNBOT_WINDOWS_CERTIFICATE_PASSWORD`; secrets are never committed or projected to the renderer.

The generated `out/release-manifest.json` binds the commit, Desktop/Core version, Electron distribution pin, internal Node runtime, vendored Core manifest, fuse verification, channel, signature state, and artifact hashes. `out/SHA256SUMS.txt` is checked before any maintainer upload. `out/release-publish-command.txt` is an explicit command input; this repository does not perform network upload, GitHub Release creation, push, or PR mutation.

## Update behavior

Settings exposes Stable (default), Preview, or Off and an explicit Check for updates action. The main process accepts only a local trusted update metadata file, validates channel, SemVer direction, minimum current version, backup requirement, signature state, artifact size, and SHA-256, then stages behind a P6 pre-update backup. Applying is explicit and restart-bound; failure records Attention and leaves current product state in place.
