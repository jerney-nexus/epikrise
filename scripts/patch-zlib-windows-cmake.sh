#!/usr/bin/env bash
set -euo pipefail

zlib_source="${1:-}"
if [[ -z "$zlib_source" || ! -d "$zlib_source" ]]; then
  printf 'Usage: %s <zlib-source-directory>\n' "$0" >&2
  exit 2
fi

cmake_file="$zlib_source/CMakeLists.txt"
if [[ ! -f "$cmake_file" ]]; then
  printf 'zlib CMakeLists.txt was not found in %s.\n' "$zlib_source" >&2
  exit 1
fi

upstream_condition_count="$(grep -Fxc 'if(UNIX)' "$cmake_file" || true)"
patched_condition_count="$(
  grep -Fxc 'if(UNIX AND NOT CMAKE_SYSTEM_NAME STREQUAL "Windows")' "$cmake_file" ||
    true
)"

if [[ "$upstream_condition_count" == "1" && "$patched_condition_count" == "0" ]]; then
  sed -i \
    's/^if(UNIX)$/if(UNIX AND NOT CMAKE_SYSTEM_NAME STREQUAL "Windows")/' \
    "$cmake_file"
elif [[ "$upstream_condition_count" != "0" || "$patched_condition_count" != "1" ]]; then
  printf 'Unexpected zlib CMake platform condition in %s.\n' "$cmake_file" >&2
  exit 1
fi
