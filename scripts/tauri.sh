#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tauri_command="$(bash "$repo_root/scripts/tauri-command.sh" "$@")"

bash "$repo_root/scripts/with-cargo-host-target.sh" --native-only --validate-only tauri "$@"
bash "$repo_root/scripts/prepare-ocr.sh"
bash "$repo_root/scripts/with-cargo-host-target.sh" --native-only tauri "$@"

if [[ "$tauri_command" == "build" ]]; then
	host_target="$(rustc -vV | sed -n 's/^host: //p')"
	app_binary="$(bash "$repo_root/scripts/tauri-build-output.sh" "$host_target" "$@")"
	if [[ ! -f "$app_binary" ]]; then
		printf 'Tauri build did not produce the expected native executable: %s\n' "$app_binary" >&2
		exit 1
	fi
	node "$repo_root/scripts/verify-binary-architecture.mjs" "$host_target" "$app_binary"
	if [[ "$host_target" == *-unknown-linux-gnu || "$host_target" == *-apple-darwin ]]; then
		pdfium_path="$repo_root/src-tauri/resources/ocr/pdfium/libpdfium.so"
		if [[ "$host_target" == *-apple-darwin ]]; then
			pdfium_path="$repo_root/src-tauri/resources/ocr/pdfium/libpdfium.dylib"
		fi
		node "$repo_root/scripts/verify-runtime-dependencies.mjs" "$host_target" \
			"$pdfium_path" \
			"$repo_root/src-tauri/binaries/tesseract-$host_target" \
			"$app_binary"
	elif [[ "$host_target" == *-pc-windows-msvc ]]; then
		node "$repo_root/scripts/verify-runtime-dependencies.mjs" "$host_target" \
			"$repo_root/src-tauri/resources/ocr/pdfium/pdfium.dll" \
			"$repo_root/src-tauri/binaries/tesseract-$host_target.exe" \
			"$app_binary"
	fi
fi
