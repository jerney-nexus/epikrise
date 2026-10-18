#!/usr/bin/env bash
set -euo pipefail

tauri_command=""
for argument in "$@"; do
  if [[ "$argument" == "--" ]]; then
    break
  fi

  case "$argument" in
    -v*|--verbose)
      continue
      ;;
    -h|--help|-V|--version)
      exit 0
      ;;
    -* )
      continue
      ;;
    *)
      if [[ -z "$tauri_command" ]]; then
        tauri_command="$argument"
      fi
      ;;
  esac
done

printf '%s' "$tauri_command"
