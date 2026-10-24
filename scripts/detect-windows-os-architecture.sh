#!/usr/bin/env bash
set -euo pipefail

windows_os_arch="${PROCESSOR_ARCHITEW6432:-}"
if [[ -z "$windows_os_arch" ]]; then
  if ! windows_os_arch="$(
    powershell.exe -NoLogo -NoProfile -NonInteractive \
      -Command '[System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture' \
      2>/dev/null
  )"; then
    windows_os_arch=""
  fi
fi
windows_os_arch="${windows_os_arch//$'\r'/}"
windows_os_arch="${windows_os_arch//$'\n'/}"
if [[ -z "$windows_os_arch" ]]; then
  printf 'Could not determine physical Windows OS architecture using PowerShell or PROCESSOR_ARCHITEW6432.\n' >&2
  exit 1
fi

case "$windows_os_arch" in
  Arm64|ARM64|arm64)
    printf 'aarch64\n'
    ;;
  X64|x64|AMD64|amd64|x86_64)
    printf 'x86_64\n'
    ;;
  *)
    printf 'Unsupported native Windows OS architecture: %s.\n' "$windows_os_arch" >&2
    exit 1
    ;;
esac
