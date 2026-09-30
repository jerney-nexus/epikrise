#!/usr/bin/env bash
set -euo pipefail

clang_args=()
while (($#)); do
  if [[ "$1" == "/imsvc" ]]; then
    if (($# < 2)); then
      printf 'Missing include path after /imsvc.\n' >&2
      exit 2
    fi
    clang_args+=(-isystem "$2")
    shift 2
  else
    clang_args+=("$1")
    shift
  fi
done

exec "${EPIKRISE_WINDOWS_CLANG:?EPIKRISE_WINDOWS_CLANG is not set}" "${clang_args[@]}"