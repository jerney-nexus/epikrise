#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

build_mode="${2:-diagnostic}"
webview_mode="${EPIKRISE_WINDOWS_WEBVIEW_MODE:-}"

case "${1:-}" in
  x64)
    target="x86_64-pc-windows-msvc"
    updater_arch="x86_64"
    ;;
  arm64)
    target="aarch64-pc-windows-msvc"
    updater_arch="aarch64"
    ;;
  *)
    printf 'Usage: %s <x64|arm64> [diagnostic|release]\n' "$0" >&2
    exit 2
    ;;
esac

case "$build_mode" in
  diagnostic)
    tauri_args=()
    ;;
  release)
    release_private_key="${TAURI_SIGNING_PRIVATE_KEY:-}"
    release_private_key_password="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
    if [[ -z "$release_private_key" ]]; then
      printf 'TAURI_SIGNING_PRIVATE_KEY is required for signed releases.\n' >&2
      exit 1
    fi
    case "$webview_mode" in
      embedBootstrapper|offlineInstaller) ;;
      *)
        printf 'EPIKRISE_WINDOWS_WEBVIEW_MODE must be embedBootstrapper or offlineInstaller for signed releases.\n' >&2
        exit 2
        ;;
    esac
    windows_config="$(node scripts/windows-release-config.mjs \
      "--target=$target" \
      "--webview-mode=$webview_mode")"
    unset TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD
    tauri_args=(
      --features "updater-windows-${updater_arch}-nsis"
      --config src-tauri/tauri.release.conf.json
      --config '{"build":{"beforeBuildCommand":null}}'
      --config "$windows_config"
      --ci
      --no-sign
    )
    ;;
  *)
    printf 'Usage: %s <x64|arm64> [diagnostic|release]\n' "$0" >&2
    exit 2
    ;;
esac

if [[ "$build_mode" == "release" ]]; then
  TAURI_SIGNING_PRIVATE_KEY="$release_private_key" \
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$release_private_key_password" \
    pnpm tauri build --target "$target" "${tauri_args[@]}"
else
  CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16 \
    CARGO_PROFILE_RELEASE_LTO=false \
    CARGO_PROFILE_RELEASE_OPT_LEVEL=2 \
    pnpm tauri build --target "$target" "${tauri_args[@]}"
fi
