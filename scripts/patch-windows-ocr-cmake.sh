#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 2 || ! -d "$1" || ! -d "$2" ]]; then
  printf 'Usage: %s <zlib-source-directory> <tesseract-source-directory>\n' "$0" >&2
  exit 2
fi

patch_condition() {
  local cmake_file="$1"
  local original_condition="$2"
  local patched_condition="$3"
  local dependency="$4"

  if [[ ! -f "$cmake_file" ]]; then
    printf '%s CMakeLists.txt was not found at %s.\n' "$dependency" "$cmake_file" >&2
    exit 1
  fi

  local original_count
  local patched_count
  original_count="$(grep -Fxc "$original_condition" "$cmake_file" || true)"
  patched_count="$(grep -Fxc "$patched_condition" "$cmake_file" || true)"

  if [[ "$original_count" == "1" && "$patched_count" == "0" ]]; then
    sed -i "s|^${original_condition}$|${patched_condition}|" "$cmake_file"
  elif [[ "$original_count" != "0" || "$patched_count" != "1" ]]; then
    printf 'Unexpected %s CMake platform condition in %s.\n' \
      "$dependency" "$cmake_file" >&2
    exit 1
  fi
}

patch_condition \
  "$1/CMakeLists.txt" \
  'if(UNIX)' \
  'if(UNIX AND NOT CMAKE_SYSTEM_NAME STREQUAL "Windows")' \
  zlib
patch_condition \
  "$2/CMakeLists.txt" \
  'elseif(UNIX)' \
  'elseif(UNIX AND NOT WIN32)' \
  Tesseract
