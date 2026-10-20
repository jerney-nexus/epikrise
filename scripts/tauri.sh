#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
signing_private_key="${TAURI_SIGNING_PRIVATE_KEY-}"
signing_private_key_password="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD-}"
signing_private_key_was_set="${TAURI_SIGNING_PRIVATE_KEY+x}"
signing_private_key_password_was_set="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD+x}"
unset TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD

tauri_command="$(bash "$repo_root/scripts/tauri-command.sh" "$@")"
native_guard_args=(--native-only --tauri-cli)
if [[ "$tauri_command" == "build" ]]; then
	native_guard_args=(--native-only --tauri-build)
elif [[ "$tauri_command" == "dev" ]]; then
	native_guard_args=(--native-only --tauri-dev)
fi

bash "$repo_root/scripts/with-cargo-host-target.sh" \
	"${native_guard_args[@]}" --validate-only tauri "$@"
(
	unset TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD
	bash "$repo_root/scripts/prepare-ocr.sh"
)

if [[ -n "$signing_private_key_was_set" ]]; then
	export TAURI_SIGNING_PRIVATE_KEY="$signing_private_key"
fi
if [[ -n "$signing_private_key_password_was_set" ]]; then
	export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$signing_private_key_password"
fi
if bash "$repo_root/scripts/with-cargo-host-target.sh" \
	"${native_guard_args[@]}" tauri "$@"; then
	tauri_status=0
else
	tauri_status=$?
fi
unset TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD
if [[ "$tauri_status" -ne 0 ]]; then
	exit "$tauri_status"
fi

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
