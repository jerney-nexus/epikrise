#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

bash "$repo_root/scripts/with-cargo-host-target.sh" --native-only --validate-only tauri "$@"
bash "$repo_root/scripts/prepare-ocr.sh"
bash "$repo_root/scripts/with-cargo-host-target.sh" --native-only tauri "$@"

if [[ "${1:-}" == "build" ]]; then
	host_target="$(rustc -vV | sed -n 's/^host: //p')"
	app_name="epikrise"
	if [[ "$host_target" == *-pc-windows-msvc ]]; then
		app_name+=".exe"
	fi
	app_binary="$repo_root/src-tauri/target/host-$host_target/release/$app_name"
	if [[ ! -f "$app_binary" ]]; then
		printf 'Tauri build did not produce the expected native executable: %s\n' "$app_binary" >&2
		exit 1
	fi
	node "$repo_root/scripts/verify-binary-architecture.mjs" "$host_target" "$app_binary"
fi