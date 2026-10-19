#!/usr/bin/env bash
set -euo pipefail

tauri_command=""
skip_next=false
for argument in "$@"; do
  if [[ "$skip_next" == true ]]; then
    skip_next=false
    continue
  fi

  if [[ "$argument" == "--" ]]; then
    break
  fi

  case "$argument" in
    --runner|-r)
      skip_next=true
      continue
      ;;
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
