#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
build_mode="${2:-diagnostic}"
installer_family="${EPIKRISE_WINDOWS_INSTALLER_FAMILY:-}"
webview_mode="${EPIKRISE_WINDOWS_WEBVIEW_MODE:-offline}"

sdk_version="10.0.26100"
crt_version="14.44.17.14"
visual_studio_version="17"
cache_root="${XDG_CACHE_HOME:-$HOME/.cache}/epikrise/windows"
license_marker="$cache_root/sdk-license-accepted-$visual_studio_version-$sdk_version-$crt_version"

if [[ ! -f "$license_marker" ]]; then
  printf 'Run pnpm windows:setup and explicitly accept the Microsoft SDK/CRT license first.\n' >&2
  exit 1
fi

case "${1:-}" in
  x64)
    targets=(x86_64-pc-windows-msvc)
    ;;
  arm64)
    targets=(aarch64-pc-windows-msvc)
    ;;
  all)
    targets=(x86_64-pc-windows-msvc aarch64-pc-windows-msvc)
    ;;
  *)
    printf 'Usage: %s <x64|arm64|all> [diagnostic|release]\n' "$0" >&2
    exit 2
    ;;
esac

if [[ "$build_mode" == "release" ]]; then
  release_private_key="${TAURI_SIGNING_PRIVATE_KEY:-}"
  release_private_key_password="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
  if [[ -z "$release_private_key" ]]; then
    printf 'TAURI_SIGNING_PRIVATE_KEY is required for signed releases.\n' >&2
    exit 1
  fi
  case "$installer_family" in
    nsis|msi) ;;
    *)
      printf 'EPIKRISE_WINDOWS_INSTALLER_FAMILY must be set to nsis or msi for signed releases.\n' >&2
      exit 2
      ;;
  esac
  case "$webview_mode" in
    offline)
      tauri_webview_mode="offlineInstaller"
      ;;
    bootstrapper)
      tauri_webview_mode="embedBootstrapper"
      ;;
    *)
      printf 'EPIKRISE_WINDOWS_WEBVIEW_MODE must be set to offline or bootstrapper.\n' >&2
      exit 2
      ;;
  esac
  unset TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD
fi

case "$build_mode" in
  diagnostic)
    tauri_args=()
    ;;
  release)
    tauri_args=(
      --config src-tauri/tauri.release.conf.json
      --config '{"build":{"beforeBuildCommand":null}}'
      --ci
      --no-sign
    )
    ;;
  *)
    printf 'Usage: %s <x64|arm64|all> [diagnostic|release]\n' "$0" >&2
    exit 2
    ;;
esac

if [[ "$build_mode" == "release" && "$installer_family" == "msi" ]]; then
  tauri_args+=(--no-bundle)
fi

tool_wrapper_dir="$cache_root/bin"
mkdir -p "$tool_wrapper_dir"
clang_path="$(command -v clang || true)"
if [[ -z "$clang_path" ]]; then
  printf 'clang is required by cargo-xwin.\n' >&2
  exit 1
fi
export EPIKRISE_WINDOWS_CLANG="$clang_path"
ln -sfn "$repo_root/scripts/clang-xwin.sh" "$tool_wrapper_dir/clang"
if ! command -v clang-cl >/dev/null 2>&1; then
  ln -sfn "$clang_path" "$tool_wrapper_dir/clang-cl"
fi
export PATH="$tool_wrapper_dir:$PATH"

for target in "${targets[@]}"; do
  printf 'Preparing OCR assets for %s...\n' "$target"
  bash scripts/prepare-ocr.sh --target "$target"
  if [[ "$build_mode" == "release" ]]; then
    printf 'Building the %s installer for %s...\n' "$installer_family" "$target"
    if [[ "$target" == x86_64-pc-windows-msvc ]]; then
      updater_arch="x86_64"
    else
      updater_arch="aarch64"
    fi
    windows_bundle_config="$(node scripts/windows-packages.mjs config "$updater_arch" "$installer_family" "$webview_mode")"
    XWIN_VERSION="$visual_studio_version" \
      XWIN_SDK_VERSION="$sdk_version" \
      XWIN_CRT_VERSION="$crt_version" \
      XWIN_CROSS_COMPILER=clang-cl \
      TAURI_SIGNING_PRIVATE_KEY="$release_private_key" \
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$release_private_key_password" \
      bash scripts/with-cargo-host-target.sh \
        pnpm exec tauri build \
          --runner cargo-xwin \
          --target "$target" \
          --features "updater-windows-${updater_arch}-${installer_family}" \
          --config "$windows_bundle_config" \
          "${tauri_args[@]}"
    host_target="$(rustc -vV | sed -n 's/^host: //p')"
    release_root="$repo_root/src-tauri/target/host-$host_target/$target/release"
    if [[ "$installer_family" == "msi" ]]; then
      release_commit="${GITHUB_SHA:-$(git rev-parse HEAD)}"
      release_version="$(node -p "require('./package.json').version")"
      node scripts/windows-packages.mjs stage-layout \
        "$target" "$installer_family" "$release_root/epikrise.exe" \
        "$repo_root/src-tauri/resources/ocr" "$repo_root/src-tauri/binaries" \
        "$release_root/windows-layout" "$release_commit" "$release_version" \
        "$sdk_version" "$crt_version" "$visual_studio_version"
    else
      node scripts/windows-packages.mjs stage \
        "$release_root/bundle/$installer_family" \
        "$release_root/windows-packages" \
        "$updater_arch" "$installer_family" "$webview_mode"
    fi
  else
    printf 'Building the NSIS installer for %s...\n' "$target"
    XWIN_VERSION="$visual_studio_version" \
      XWIN_SDK_VERSION="$sdk_version" \
      XWIN_CRT_VERSION="$crt_version" \
      XWIN_CROSS_COMPILER=clang-cl \
      bash scripts/with-cargo-host-target.sh \
        pnpm exec tauri build --runner cargo-xwin --target "$target" "${tauri_args[@]}"
  fi
done