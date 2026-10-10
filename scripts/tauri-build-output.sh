#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
host_target="${1:-}"
if [[ -z "$host_target" ]]; then
  printf 'Usage: %s <host-target> [Tauri build options...]\n' "$0" >&2
  exit 2
fi
shift

build_target="${CARGO_BUILD_TARGET:-}"
build_profile="release"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target|-t)
      shift
      if [[ $# -eq 0 || -z "$1" ]]; then
        printf 'Missing value for --target.\n' >&2
        exit 2
      fi
      build_target="$1"
      ;;
    --target=*)
      build_target="${1#--target=}"
      ;;
    -t=*)
      build_target="${1#-t=}"
      ;;
    -t?*)
      build_target="${1#-t}"
      ;;
    --debug|-d)
      build_profile="debug"
      ;;
    --)
      break
      ;;
  esac
  shift
done

target_dir="$repo_root/src-tauri/target/host-$host_target"
if [[ -n "$build_target" ]]; then
  target_dir+="/$build_target"
fi

app_name="epikrise"
if [[ "$host_target" == *-pc-windows-msvc ]]; then
  app_name+=".exe"
fi

printf '%s/%s/%s' "$target_dir" "$build_profile" "$app_name"
