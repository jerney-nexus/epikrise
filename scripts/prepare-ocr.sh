#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

host_target="$(rustc -vV | sed -n 's/^host: //p')"
case "$host_target" in
  aarch64-apple-darwin)
    pdfium_asset="pdfium-mac-arm64.tgz"
    pdfium_library="libpdfium.dylib"
    pdfium_sha256="336219e80580b93c6523f44db7dc1de59cc497b13a7390ddac84223f68ca162b"
    ;;
  x86_64-apple-darwin)
    pdfium_asset="pdfium-mac-x64.tgz"
    pdfium_library="libpdfium.dylib"
    pdfium_sha256="841ecac278cdd46288dd065873522cf72f3996560d8978f473d336f01d59942c"
    ;;
  x86_64-unknown-linux-gnu)
    pdfium_asset="pdfium-linux-x64.tgz"
    pdfium_library="libpdfium.so"
    pdfium_sha256="0b43f405477cf2cfc4dbff06905093c3309756c6bca1fb9da99234a2ca97fed2"
    ;;
  aarch64-unknown-linux-gnu)
    pdfium_asset="pdfium-linux-arm64.tgz"
    pdfium_library="libpdfium.so"
    pdfium_sha256="0e6f90dccbc6b81fd5d7106abaf164c4222178f024c204d00d526b60fd2ad535"
    ;;
  *)
    printf 'OCR asset preparation is not configured for target %s.\n' "$host_target" >&2
    exit 1
    ;;
esac

tesseract_path="$(command -v tesseract || true)"
if [[ -z "$tesseract_path" ]]; then
  printf 'Tesseract was not found. Install it and the deu/eng language data before building.\n' >&2
  exit 1
fi

tessdata_dir="$(tesseract --list-langs 2>&1 | sed -n 's/.* in "\(.*\)".*/\1/p' | head -n 1)"
if [[ -z "$tessdata_dir" || ! -f "$tessdata_dir/deu.traineddata" || ! -f "$tessdata_dir/eng.traineddata" ]]; then
  printf 'Tesseract must have both deu and eng language data installed.\n' >&2
  if [[ "$host_target" == *-apple-darwin ]]; then
    printf 'Install them with: brew install tesseract tesseract-lang\n' >&2
  fi
  exit 1
fi

resource_dir="src-tauri/resources/ocr"
pdfium_path="$resource_dir/pdfium/$pdfium_library"
sidecar_path="src-tauri/binaries/tesseract-$host_target"
mkdir -p "$resource_dir/pdfium" "$resource_dir/tessdata" "$(dirname "$sidecar_path")"

if [[ ! -f "$pdfium_path" ]]; then
  temp_dir="$(mktemp -d)"
  trap 'rm -rf "$temp_dir"' EXIT
  archive_path="$temp_dir/$pdfium_asset"
  pdfium_url="https://github.com/bblanchon/pdfium-binaries/releases/download/chromium/8066/$pdfium_asset"
  curl --fail --location --silent --show-error "$pdfium_url" -o "$archive_path"
  actual_sha256="$(shasum -a 256 "$archive_path" | awk '{print $1}')"
  if [[ "$actual_sha256" != "$pdfium_sha256" ]]; then
    printf 'PDFium checksum mismatch for %s.\n' "$pdfium_asset" >&2
    exit 1
  fi
  tar -xzf "$archive_path" -C "$temp_dir" "lib/$pdfium_library"
  install -m 0644 "$temp_dir/lib/$pdfium_library" "$pdfium_path"
fi

install -m 0644 "$tessdata_dir/deu.traineddata" "$resource_dir/tessdata/deu.traineddata"
install -m 0644 "$tessdata_dir/eng.traineddata" "$resource_dir/tessdata/eng.traineddata"
ln -sfn "$(cd "$(dirname "$tesseract_path")" && pwd)/$(basename "$tesseract_path")" "$sidecar_path"