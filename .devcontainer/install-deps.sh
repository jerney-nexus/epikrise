#!/usr/bin/env bash
# Linux build dependencies for Tauri v2, plus the OCR toolchain used by epikrise-ingest.
# See https://v2.tauri.app/start/prerequisites/
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  build-essential \
  clang \
  file \
  lld \
  llvm \
  ninja-build \
  nsis \
  libssl-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libwebkit2gtk-4.1-dev \
  libxdo-dev \
  pkg-config \
  patchelf \
  tesseract-ocr \
  tesseract-ocr-deu \
  tesseract-ocr-eng

restart_manager_version="v312"
restart_manager_sha256="67149978412da9b283e2e1abe48a360093df9caf6363373e2cabe463978b7c0e"
restart_manager_temp="$(mktemp)"
trap 'rm -f "$restart_manager_temp"' EXIT
curl --fail --location --silent --show-error \
  "https://raw.githubusercontent.com/NSIS-Dev/NSIS/$restart_manager_version/Include/Win/RestartManager.nsh" \
  -o "$restart_manager_temp"
printf '%s  %s\n' "$restart_manager_sha256" "$restart_manager_temp" | sha256sum --check --status || {
  printf 'SHA-256 mismatch for NSIS RestartManager.nsh.\n' >&2
  exit 1
}
sudo install -D -m 0644 "$restart_manager_temp" \
  /usr/share/nsis/Include/Win/RestartManager.nsh
rm -f "$restart_manager_temp"
trap - EXIT

sudo apt-get clean
sudo rm -rf /var/lib/apt/lists/*

rustup component add clippy rustfmt llvm-tools-preview
cargo install cargo-nextest --locked
cargo install cargo-llvm-cov --locked
cargo install cargo-deny --locked
cargo install cargo-xwin --version 0.23.1 --locked

host_target="$(rustc -vV | sed -n 's/^host: //p')"
case "$(uname -m)" in
  x86_64)
    pdfium_url="https://github.com/bblanchon/pdfium-binaries/releases/download/chromium/8066/pdfium-linux-x64.tgz"
    pdfium_sha256="0b43f405477cf2cfc4dbff06905093c3309756c6bca1fb9da99234a2ca97fed2"
    ;;
  aarch64)
    pdfium_url="https://github.com/bblanchon/pdfium-binaries/releases/download/chromium/8066/pdfium-linux-arm64.tgz"
    pdfium_sha256="0e6f90dccbc6b81fd5d7106abaf164c4222178f024c204d00d526b60fd2ad535"
    ;;
  *)
    printf 'Unsupported devcontainer architecture for PDFium: %s\n' "$(uname -m)" >&2
    exit 1
    ;;
esac

resource_dir="src-tauri/resources/ocr"
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT
curl --fail --location --silent --show-error "$pdfium_url" -o "$temp_dir/pdfium.tgz"
printf '%s  %s\n' "$pdfium_sha256" "$temp_dir/pdfium.tgz" | sha256sum --check --status
tar -xzf "$temp_dir/pdfium.tgz" -C "$temp_dir" lib/libpdfium.so
install -D -m 0644 "$temp_dir/lib/libpdfium.so" "$resource_dir/pdfium/libpdfium.so"

tessdata_dir="$(tesseract --list-langs 2>&1 | sed -n 's/^List of available languages in "\(.*\)".*/\1/p')"
install -D -m 0644 "$tessdata_dir/deu.traineddata" "$resource_dir/tessdata/deu.traineddata"
install -m 0644 "$tessdata_dir/eng.traineddata" "$resource_dir/tessdata/eng.traineddata"

mkdir -p src-tauri/binaries
ln -sfn "$(command -v tesseract)" "src-tauri/binaries/tesseract-$host_target"
