#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

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
    printf 'Usage: %s <x64|arm64|all>\n' "$0" >&2
    exit 2
    ;;
esac

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
  printf 'Building the NSIS installer for %s...\n' "$target"
  XWIN_VERSION="$visual_studio_version" \
    XWIN_SDK_VERSION="$sdk_version" \
    XWIN_CRT_VERSION="$crt_version" \
    XWIN_CROSS_COMPILER=clang-cl \
    pnpm exec tauri build --runner cargo-xwin --target "$target"
done