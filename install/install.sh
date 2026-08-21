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
mkdir -p "$install_dir/.bootstrap"
bootstrap_dir="$install_dir/.bootstrap"
downloaded_core="$bootstrap_dir/portable-install.mjs"

cleanup() {
  rm -rf "$bootstrap_dir" 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM

if [ -n "$installer_core" ]; then
  core_path=$installer_core
elif printf '%s' "$manifest" | grep -q '^https://'; then
  core_url="${manifest%/*}/portable-install.mjs"
  case "$core_url" in
    https://*) ;;
    *) echo "Remote installer core must use HTTPS." >&2; exit 1 ;;
  esac
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$core_url" -o "$downloaded_core"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$downloaded_core" "$core_url"
  else
    echo "curl or wget is required to download the installer core." >&2
    exit 1
  fi
  core_path=$downloaded_core
else
  manifest_dir=$(CDPATH= cd -- "$(dirname -- "$manifest")" && pwd)
  core_path="$manifest_dir/portable-install.mjs"
  [ -f "$core_path" ] || { echo "portable-install.mjs was not found next to the local release manifest." >&2; exit 1; }
fi

node "$core_path" --install-dir "$install_dir" --manifest "$manifest"
