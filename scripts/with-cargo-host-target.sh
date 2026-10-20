#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
native_only=false
if [[ "${1:-}" == "--native-only" ]]; then
  native_only=true
  shift
fi

tauri_build=false
if [[ "${1:-}" == "--tauri-build" ]]; then
  tauri_build=true
  shift
fi

tauri_dev=false
if [[ "${1:-}" == "--tauri-dev" ]]; then
  tauri_dev=true
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
      physical_arch="$(bash "$repo_root/scripts/detect-windows-os-architecture.sh")"
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

  if [[ "$physical_os_family" == "linux" ]]; then
    physical_arch="$(
      node "$repo_root/scripts/verify-linux-host-architecture.mjs" \
        "$host_triple" "$physical_arch"
    )"
  fi

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

  target_validation_mode="cargo"
  if [[ "$tauri_build" == true ]]; then
    target_validation_mode="tauri-build"
  elif [[ "$tauri_dev" == true ]]; then
    target_validation_mode="tauri-dev"
  fi
  node "$repo_root/scripts/validate-native-cargo-target.mjs" \
    "$host_triple" "$target_validation_mode" "$@"

  after_separator=false
  while [[ $# -gt 0 ]]; do
    if [[ ( "$tauri_build" == true || "$tauri_dev" == true ) && "$after_separator" == false ]]; then
      case "$1" in
        --runner|-r)
          runner_option="$1"
          shift
          if [[ $# -eq 0 || -z "$1" ]]; then
            printf 'Missing value for %s.\n' "$runner_option" >&2
            exit 2
          fi
          if [[ "$1" != "cargo" ]]; then
            printf 'Custom Tauri runner %s is not allowed for native-only builds.\n' "$1" >&2
            exit 1
          fi
          ;;
        --runner=*|-r=*)
          runner="${1#*=}"
          if [[ -z "$runner" ]]; then
            printf 'Missing value for runner option %s.\n' "${1%%=*}" >&2
            exit 2
          fi
          if [[ "$runner" != "cargo" ]]; then
            printf 'Custom Tauri runner %s is not allowed for native-only builds.\n' "$runner" >&2
            exit 1
          fi
          ;;
        -r?*)
          runner="${1#-r}"
          if [[ "$runner" != "cargo" ]]; then
            printf 'Custom Tauri runner %s is not allowed for native-only builds.\n' "$runner" >&2
            exit 1
          fi
          ;;
        -*)
          if [[ "$1" != --* ]]; then
            short_options="${1#-}"
            while [[ -n "$short_options" ]]; do
              short_option="${short_options:0:1}"
              short_options="${short_options:1}"
              case "$short_option" in
                r)
                  if [[ -n "$short_options" ]]; then
                    runner="$short_options"
                    if [[ "$runner" == =* ]]; then
                      runner="${runner#=}"
                    fi
                  else
                    runner_option="$1"
                    shift
                    if [[ $# -eq 0 || -z "$1" ]]; then
                      printf 'Missing value for %s.\n' "$runner_option" >&2
                      exit 2
                    fi
                    runner="$1"
                  fi
                  if [[ "$runner" != "cargo" ]]; then
                    printf 'Custom Tauri runner %s is not allowed for native-only builds.\n' "$runner" >&2
                    exit 1
                  fi
                  break
                  ;;
                v)
                  ;;
                c|f|t)
                  break
                  ;;
                *)
                  break
                  ;;
              esac
            done
          fi
          ;;
      esac
    fi

    if [[ "$1" == "--" && "$after_separator" == false ]]; then
      if [[ "$tauri_build" == true || "$tauri_dev" == true ]]; then
        after_separator=true
        shift
        continue
      fi
      break
    elif [[ "$1" == "--" && "$tauri_dev" == true ]]; then
      break
    fi

    shift
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