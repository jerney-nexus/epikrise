#!/usr/bin/env bash
# Prepare repository-mounted OCR resources for epikrise-ingest.
set -euo pipefail

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
