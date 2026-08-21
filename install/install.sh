#!/bin/sh
set -eu

manifest="https://github.com/Kura-etnPL/SovereignBot/releases/latest/download/release-manifest.json"
install_dir="${XDG_DATA_HOME:-$HOME/.local/share}/sovereignbot"
installer_core=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --install-dir)
      [ "$#" -ge 2 ] || { echo "--install-dir requires a value" >&2; exit 2; }
      install_dir=$2
      shift 2
      ;;
    --manifest)
      [ "$#" -ge 2 ] || { echo "--manifest requires a value" >&2; exit 2; }
      manifest=$2
      shift 2
      ;;
    --installer-core)
      [ "$#" -ge 2 ] || { echo "--installer-core requires a value" >&2; exit 2; }
      installer_core=$2
      shift 2
      ;;
    --help|-h)
      cat <<'EOF'
Usage: install.sh [--install-dir PATH] [--manifest URL_OR_PATH] [--installer-core PATH]

Installs SovereignBot as a portable local CLI. It does not edit PATH, shell profiles,
services, scheduled tasks, or global npm state.
EOF
      exit 0
      ;;
    *)
      echo "unknown installer option: $1" >&2
      exit 2
      ;;
  esac
done

command -v node >/dev/null 2>&1 || { echo "SovereignBot requires Node.js 22+ and 'node' was not found on PATH." >&2; exit 1; }

case "$install_dir" in
  /) echo "Refusing to use / as the install directory." >&2; exit 1 ;;
esac
if [ -L "$install_dir" ]; then
  echo "Refusing to use a symbolic-link install directory: $install_dir" >&2
  exit 1
fi
mkdir -p "$install_dir"
bootstrap_dir="$install_dir/.bootstrap"
if [ -L "$bootstrap_dir" ]; then
  echo "Refusing to use a symbolic-link bootstrap directory: $bootstrap_dir" >&2
  exit 1
fi
mkdir -p "$bootstrap_dir"
if [ -L "$bootstrap_dir" ]; then
  echo "Refusing to use a symbolic-link bootstrap directory: $bootstrap_dir" >&2
  exit 1
fi

downloaded_core="$bootstrap_dir/portable-install.mjs"
downloaded_manifest="$bootstrap_dir/release-manifest.json"
manifest_for_hash=""

cleanup() {
  if [ ! -L "$bootstrap_dir" ]; then
    rm -rf "$bootstrap_dir" 2>/dev/null || true
  fi
}
trap cleanup EXIT HUP INT TERM

fetch_to_file() {
  url=$1
  destination=$2
  case "$url" in
    https://*) ;;
    *) echo "Remote installer sources must use HTTPS." >&2; exit 1 ;;
  esac
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$destination"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$destination" "$url"
  else
    echo "curl or wget is required to download installer assets." >&2
    exit 1
  fi
}

case "$manifest" in
  https://*)
    fetch_to_file "$manifest" "$downloaded_manifest"
    manifest_for_hash=$downloaded_manifest
    ;;
  *)
    manifest_for_hash=$manifest
    [ -f "$manifest_for_hash" ] || { echo "Release manifest was not found: $manifest_for_hash" >&2; exit 1; }
    ;;
esac

if [ -n "$installer_core" ]; then
  core_path=$installer_core
  [ -f "$core_path" ] || { echo "Installer core was not found: $core_path" >&2; exit 1; }
elif printf '%s' "$manifest" | grep -q '^https://'; then
  core_url="${manifest%/*}/portable-install.mjs"
  fetch_to_file "$core_url" "$downloaded_core"
  core_path=$downloaded_core
else
  manifest_dir=$(CDPATH= cd -- "$(dirname -- "$manifest_for_hash")" && pwd)
  core_path="$manifest_dir/portable-install.mjs"
  [ -f "$core_path" ] || { echo "portable-install.mjs was not found next to the local release manifest." >&2; exit 1; }
fi

expected_core_hash=$(node -e '
const fs = require("fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const entry = Array.isArray(manifest.installers) && manifest.installers.find((item) => item && item.file === "portable-install.mjs");
if (!entry || !/^[0-9a-f]{64}$/.test(entry.sha256 || "")) {
  console.error("release manifest does not contain a valid portable-install.mjs SHA-256");
  process.exit(2);
}
process.stdout.write(entry.sha256);
' "$manifest_for_hash")

actual_core_hash=$(node -e '
const fs = require("fs");
const crypto = require("crypto");
const bytes = fs.readFileSync(process.argv[1]);
process.stdout.write(crypto.createHash("sha256").update(bytes).digest("hex"));
' "$core_path")

if [ "$actual_core_hash" != "$expected_core_hash" ]; then
  echo "portable-install.mjs SHA-256 mismatch; refusing to execute installer core." >&2
  exit 1
fi

node "$core_path" --install-dir "$install_dir" --manifest "$manifest"
