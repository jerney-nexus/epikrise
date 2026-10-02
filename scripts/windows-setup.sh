#!/usr/bin/env bash
set -euo pipefail

sdk_version="10.0.26100"
crt_version="14.44.17.14"
visual_studio_version="17"
cache_root="${XDG_CACHE_HOME:-$HOME/.cache}/epikrise/windows"
license_marker="$cache_root/sdk-license-accepted-$visual_studio_version-$sdk_version-$crt_version"

if [[ "${1:-}" == "--ci" ]]; then
  if [[ $# -ne 1 ]]; then
    printf 'Usage: %s [--ci]\n' "$0" >&2
    exit 2
  fi
  if [[ "${EPIKRISE_WINDOWS_SDK_LICENSE_APPROVED:-}" != "true" ]]; then
    printf 'Set the EPIKRISE_WINDOWS_SDK_LICENSE_APPROVED repository variable to true only after reviewing the Microsoft SDK/CRT license.\n' >&2
    exit 1
  fi
elif [[ $# -ne 0 ]]; then
  printf 'Usage: %s [--ci]\n' "$0" >&2
  exit 2
fi

if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "aarch64" ]]; then
  printf 'Windows cross-build setup is supported from the Linux ARM64 dev container.\n' >&2
  exit 1
fi

for tool in cargo rustup clang llvm-rc llvm-ar lld-link cmake ninja makensis; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'Required Windows cross-build tool is missing: %s\n' "$tool" >&2
    exit 1
  fi
done

if [[ ! -f /usr/share/nsis/Include/Win/RestartManager.nsh ]]; then
  printf 'NSIS is missing Win/RestartManager.nsh; rebuild the dev container to install the required header.\n' >&2
  exit 1
fi

if ! cargo xwin --version >/dev/null 2>&1; then
  cargo install cargo-xwin --version 0.23.1 --locked
fi

printf 'Microsoft Windows SDK/CRT license: https://go.microsoft.com/fwlink/?LinkId=2086102\n'
printf 'Review the license before continuing. Type ACCEPT to download the pinned SDK and CRT: '
if [[ ! -t 0 ]]; then
  printf '\nRun pnpm windows:setup in an interactive terminal.\n' >&2
  exit 1
fi
read -r license_response
if [[ "$license_response" != "ACCEPT" ]]; then
  printf 'Windows SDK setup cancelled; no Microsoft SDK/CRT files were requested.\n' >&2
  exit 1
fi

rustup target add x86_64-pc-windows-msvc aarch64-pc-windows-msvc
cargo xwin cache xwin \
  --xwin-version "$visual_studio_version" \
  --xwin-sdk-version "$sdk_version" \
  --xwin-crt-version "$crt_version"

mkdir -p "$cache_root"
touch "$license_marker"
printf 'Windows cross-build tools are ready.\n'