#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sdk_version="10.0.26100"
crt_version="14.44.17.14"
visual_studio_version="17"
cache_root="${XDG_CACHE_HOME:-$HOME/.cache}/epikrise/windows"
license_marker="$cache_root/sdk-license-accepted-$visual_studio_version-$sdk_version-$crt_version"

if [[ "${GITHUB_ACTIONS:-}" == "true" ||
      "${CI:-}" =~ ^([Tt][Rr][Uu][Ee]|[Yy][Ee][Ss]|[Oo][Nn]|1)$ ||
      -n "${GITLAB_CI:-}${CIRCLECI:-}${JENKINS_URL:-}${BUILD_NUMBER:-}${TF_BUILD:-}${TEAMCITY_VERSION:-}${BUILDKITE:-}${DRONE:-}${CODEBUILD_BUILD_ID:-}" ]]; then
  printf 'Windows cross-build setup is for interactive human use and cannot run in CI.\n' >&2
  exit 1
fi

if [[ $# -ne 0 ]]; then
  printf 'Usage: %s\n' "$0" >&2
  exit 2
fi

if [[ "$(uname -s)" != "Linux" ]]; then
  printf 'Windows cross-build setup is supported only from Linux x64 or ARM64.\n' >&2
  exit 1
fi

for tool in cargo rustup rustc node clang llvm-rc llvm-ar lld-link cmake ninja makensis; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'Required Windows cross-build tool is missing: %s\n' "$tool" >&2
    exit 1
  fi
done

host_triple="$(rustc -vV | sed -n 's/^host: //p')"
case "$host_triple" in
  x86_64-*-linux-*|aarch64-*-linux-*) ;;
  *)
    printf 'Windows cross-build setup requires a native Linux x64 or ARM64 Rust host; found %s.\n' \
      "${host_triple:-unknown}" >&2
    exit 1
    ;;
esac
host_arch="$(node "$repo_root/scripts/verify-linux-host-architecture.mjs" "$host_triple" "$(uname -m)")"

if [[ ! -f /usr/share/nsis/Include/Win/RestartManager.nsh ]]; then
  printf 'NSIS is missing Win/RestartManager.nsh; rebuild the dev container to install the required header.\n' >&2
  exit 1
fi

printf 'Microsoft Windows SDK/CRT license: https://go.microsoft.com/fwlink/?LinkId=2086102\n'
printf 'Review the license before continuing. Type ACCEPT to download the pinned SDK and CRT: '
if [[ ! -t 0 || ! -t 1 ]]; then
  printf '\nRun pnpm windows:setup in an interactive terminal.\n' >&2
  exit 1
fi
read -r license_response
if [[ "$license_response" != "ACCEPT" ]]; then
  printf 'Windows SDK setup cancelled; no Microsoft SDK/CRT files were requested.\n' >&2
  exit 1
fi

if ! cargo xwin --version >/dev/null 2>&1; then
  cargo install cargo-xwin --version 0.23.1 --locked
fi

rustup target add x86_64-pc-windows-msvc aarch64-pc-windows-msvc
cargo xwin cache xwin \
  --xwin-version "$visual_studio_version" \
  --xwin-sdk-version "$sdk_version" \
  --xwin-crt-version "$crt_version"

mkdir -p "$cache_root"
touch "$license_marker"
printf 'Windows cross-build tools are ready for Linux %s.\n' "$host_arch"