#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

if [[ "${GITHUB_ACTIONS:-}" == "true" ||
      "${CI:-}" =~ ^([Tt][Rr][Uu][Ee]|1)$ ||
      -n "${GITLAB_CI:-}${CIRCLECI:-}${JENKINS_URL:-}${BUILD_NUMBER:-}${TF_BUILD:-}${TEAMCITY_VERSION:-}${BUILDKITE:-}${DRONE:-}${CODEBUILD_BUILD_ID:-}" ]]; then
  printf 'Linux Windows cross-builds are for interactive human use and cannot run in CI.\n' >&2
  exit 1
fi

if [[ "${EPIKRISE_ALLOW_LINUX_WINDOWS_CROSS_BUILD:-}" != "true" ]]; then
  printf 'Set EPIKRISE_ALLOW_LINUX_WINDOWS_CROSS_BUILD=true to explicitly opt in to a manual Linux NSIS cross-build.\n' >&2
  exit 1
fi

if [[ $# -gt 2 ]]; then
  printf 'Usage: %s <x64|arm64|all> [diagnostic]\n' "$0" >&2
  exit 2
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
    printf 'Usage: %s <x64|arm64|all> [diagnostic]\n' "$0" >&2
    exit 2
    ;;
esac

build_mode="${2:-diagnostic}"
if [[ "$build_mode" != "diagnostic" ]]; then
  printf 'Linux cross-builds support unsigned diagnostic NSIS packages only; release builds are not supported.\n' >&2
  exit 1
fi

installer_family="${EPIKRISE_WINDOWS_INSTALLER_FAMILY:-nsis}"
if [[ "$installer_family" != "nsis" ]]; then
  printf 'Linux cross-builds support NSIS packages only; EPIKRISE_WINDOWS_INSTALLER_FAMILY must be nsis.\n' >&2
  exit 1
fi

if [[ "$(uname -s)" != "Linux" ]]; then
  printf 'Windows cross-builds are supported only from Linux x64 or ARM64.\n' >&2
  exit 1
fi

host_triple="$(rustc -vV | sed -n 's/^host: //p')"
case "$host_triple" in
  x86_64-*-linux-*|aarch64-*-linux-*) ;;
  *)
    printf 'Windows cross-builds require a native Linux x64 or ARM64 Rust host; found %s.\n' \
      "${host_triple:-unknown}" >&2
    exit 1
    ;;
esac
host_arch="$(node "$repo_root/scripts/verify-linux-host-architecture.mjs" "$host_triple" "$(uname -m)")"

sdk_version="10.0.26100"
crt_version="14.44.17.14"
visual_studio_version="17"
cache_root="${XDG_CACHE_HOME:-$HOME/.cache}/epikrise/windows"
license_marker="$cache_root/sdk-license-accepted-$visual_studio_version-$sdk_version-$crt_version"
if [[ ! -f "$license_marker" ]]; then
  printf 'Run pnpm windows:setup and explicitly accept the Microsoft SDK/CRT license first.\n' >&2
  exit 1
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
  EPIKRISE_ALLOW_LINUX_WINDOWS_CROSS_BUILD=true \
    EPIKRISE_WINDOWS_CROSS_BUILD_PACKAGE=nsis \
    EPIKRISE_WINDOWS_HOST_ARCH="$host_arch" \
    bash scripts/prepare-ocr.sh --target "$target"
  printf 'Building the diagnostic NSIS installer for %s...\n' "$target"
  XWIN_VERSION="$visual_studio_version" \
    XWIN_SDK_VERSION="$sdk_version" \
    XWIN_CRT_VERSION="$crt_version" \
    XWIN_CROSS_COMPILER=clang-cl \
    bash scripts/with-cargo-host-target.sh \
      pnpm exec tauri build \
        --runner cargo-xwin \
        --target "$target" \
        --config '{"bundle":{"targets":["nsis"]}}'
done