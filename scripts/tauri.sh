#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

bash "$repo_root/scripts/with-cargo-host-target.sh" --native-only --validate-only tauri "$@"
bash "$repo_root/scripts/prepare-ocr.sh"
bash "$repo_root/scripts/with-cargo-host-target.sh" --native-only tauri "$@"