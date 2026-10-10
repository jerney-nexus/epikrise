#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
native_only=false
if [[ "${1:-}" == "--native-only" ]]; then
  native_only=true
  shift
fi

validate_only=false
if [[ "${1:-}" == "--validate-only" ]]; then
  validate_only=true
  shift
fi

host_triple="$(rustc -vV | sed -n 's/^host: //p')"

if [[ -z "$host_triple" ]]; then
  printf 'Could not determine the Rust host triple.\n' >&2
  exit 1
fi

command_args=("$@")
if [[ "$native_only" == true ]]; then
  physical_os="$(uname -s)"
  physical_arch="$(uname -m)"
  case "$physical_os" in
    Linux)
      physical_os_family="linux"
      ;;
    Darwin)
      physical_os_family="darwin"
      if [[ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" == "1" ]]; then
        physical_arch="aarch64"
      fi
      ;;
    MINGW*|MSYS*|CYGWIN*)
      physical_os_family="windows"
      windows_arch="${PROCESSOR_ARCHITEW6432:-${PROCESSOR_ARCHITECTURE:-}}"
      case "$windows_arch" in
        ARM64|arm64)
          physical_arch="aarch64"
          ;;
        AMD64|amd64|x86_64)
          physical_arch="x86_64"
          ;;
      esac
      ;;
    *)
      printf 'Unsupported physical host OS: %s.\n' "$physical_os" >&2
      exit 1
      ;;
  esac

  case "$physical_arch" in
    x86_64|amd64|AMD64)
      physical_arch="x86_64"
      ;;
    aarch64|arm64|ARM64)
      physical_arch="aarch64"
      ;;
    *)
      printf 'Unsupported physical host architecture: %s.\n' "$physical_arch" >&2
      exit 1
      ;;
  esac

  rust_host_arch="${host_triple%%-*}"
  case "$host_triple" in
    *-unknown-linux-*)
      rust_host_os="linux"
      ;;
    *-apple-darwin)
      rust_host_os="darwin"
      ;;
    *-pc-windows-msvc)
      rust_host_os="windows"
      ;;
    *)
      printf 'Unsupported Rust host triple for native builds: %s.\n' "$host_triple" >&2
      exit 1
      ;;
  esac

  if [[ "$rust_host_os" != "$physical_os_family" || "$rust_host_arch" != "$physical_arch" ]]; then
    printf 'Rust host triple %s does not match detected physical host %s/%s.\n' \
      "$host_triple" "$physical_os_family" "$physical_arch" >&2
    exit 1
  fi

  requested_target="${CARGO_BUILD_TARGET:-}"
  explicit_target=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --target|-t)
        shift
        if [[ $# -eq 0 || -z "$1" ]]; then
          printf 'Missing value for --target.\n' >&2
          exit 2
        fi
        explicit_target="$1"
        ;;
      --target=*)
        explicit_target="${1#--target=}"
        ;;
      -t=*)
        explicit_target="${1#-t=}"
        ;;
      -t?*)
        explicit_target="${1#-t}"
        ;;
      --)
        break
        ;;
    esac
    shift
  done

  for target in "$requested_target" "$explicit_target"; do
    if [[ -n "$target" && "$target" != "$host_triple" ]]; then
      printf 'Requested target %s does not match native host %s.\n' "$target" "$host_triple" >&2
      exit 1
    fi
  done
fi

if [[ "$validate_only" == true ]]; then
  if [[ "$native_only" != true ]]; then
    printf 'Validation-only mode requires --native-only.\n' >&2
    exit 2
  fi
  exit 0
fi

export CARGO_TARGET_DIR="$repo_root/src-tauri/target/host-$host_triple"
exec "${command_args[@]}"