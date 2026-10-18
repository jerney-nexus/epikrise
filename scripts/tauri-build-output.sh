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
after_separator=false
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--" && "$after_separator" == false ]]; then
    after_separator=true
    shift
    continue
  fi

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
    --profile)
      shift
      if [[ $# -eq 0 || -z "$1" ]]; then
        printf 'Missing value for --profile.\n' >&2
        exit 2
      fi
      build_profile="$1"
      ;;
    --profile=*)
      build_profile="${1#--profile=}"
      if [[ -z "$build_profile" ]]; then
        printf 'Missing value for --profile.\n' >&2
        exit 2
      fi
      ;;
    --release)
      build_profile="release"
      ;;
    -r)
      if [[ "$after_separator" == true ]]; then
        build_profile="release"
      else
        shift
        if [[ $# -eq 0 || -z "$1" ]]; then
          printf 'Missing value for --runner.\n' >&2
          exit 2
        fi
      fi
      ;;
  esac
  shift
done

if [[ "$build_profile" == "dev" ]]; then
  build_profile="debug"
fi

target_dir="$repo_root/src-tauri/target/host-$host_target"
if [[ -n "$build_target" ]]; then
  target_dir+="/$build_target"
fi

app_name="epikrise"
if [[ "$host_target" == *-pc-windows-msvc ]]; then
  app_name+=".exe"
fi

printf '%s/%s/%s' "$target_dir" "$build_profile" "$app_name"
