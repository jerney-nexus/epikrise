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
    --runner|--config|--target|--features|-r|-c|-t|-f)
      skip_next=true
      continue
      ;;
    --verbose)
      continue
      ;;
    -h|--help|-V|--version)
      exit 0
      ;;
    -* )
      if [[ "$argument" != --* ]]; then
        short_options="${argument#-}"
        while [[ -n "$short_options" ]]; do
          short_option="${short_options:0:1}"
          short_options="${short_options:1}"
          case "$short_option" in
            h|V)
              exit 0
              ;;
            v|d)
              ;;
            r|c|t|f)
              if [[ -z "$short_options" ]]; then
                skip_next=true
              fi
              break
              ;;
            *)
              break
              ;;
          esac
        done
      fi
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
