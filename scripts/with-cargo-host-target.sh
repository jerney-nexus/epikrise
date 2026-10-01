#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
host_triple="$(rustc -vV | sed -n 's/^host: //p')"

if [[ -z "$host_triple" ]]; then
  printf 'Could not determine the Rust host triple.\n' >&2
  exit 1
fi

export CARGO_TARGET_DIR="$repo_root/src-tauri/target/host-$host_triple"
exec "$@"