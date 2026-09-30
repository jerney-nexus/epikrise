#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

host_target="$(rustc -vV | sed -n 's/^host: //p')"
if [[ "${1:-}" == "--help" ]]; then
  printf 'Usage: %s [--target] <target-triple>\n' "$0"
  exit 0
fi
if [[ "${1:-}" == "--target" ]]; then
  target="${2:-}"
  if [[ -z "$target" || $# -ne 2 ]]; then
    printf 'Usage: %s [--target] <target-triple>\n' "$0" >&2
    exit 2
  fi
elif [[ $# -eq 0 ]]; then
  target="$host_target"
elif [[ $# -eq 1 ]]; then
  target="$1"
else
  printf 'Usage: %s [--target] <target-triple>\n' "$0" >&2
  exit 2
fi

file_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

has_expected_sha256() {
  [[ "$(file_sha256 "$2")" == "$1" ]]
}

case "$target" in
  aarch64-apple-darwin)
    pdfium_asset="pdfium-mac-arm64.tgz"
    pdfium_library="libpdfium.dylib"
    pdfium_member="lib/$pdfium_library"
    pdfium_sha256="336219e80580b93c6523f44db7dc1de59cc497b13a7390ddac84223f68ca162b"
    ;;
  x86_64-apple-darwin)
    pdfium_asset="pdfium-mac-x64.tgz"
    pdfium_library="libpdfium.dylib"
    pdfium_member="lib/$pdfium_library"
    pdfium_sha256="841ecac278cdd46288dd065873522cf72f3996560d8978f473d336f01d59942c"
    ;;
  x86_64-unknown-linux-gnu)
    pdfium_asset="pdfium-linux-x64.tgz"
    pdfium_library="libpdfium.so"
    pdfium_member="lib/$pdfium_library"
    pdfium_sha256="0b43f405477cf2cfc4dbff06905093c3309756c6bca1fb9da99234a2ca97fed2"
    ;;
  aarch64-unknown-linux-gnu)
    pdfium_asset="pdfium-linux-arm64.tgz"
    pdfium_library="libpdfium.so"
    pdfium_member="lib/$pdfium_library"
    pdfium_sha256="0e6f90dccbc6b81fd5d7106abaf164c4222178f024c204d00d526b60fd2ad535"
    ;;
  x86_64-pc-windows-msvc)
    pdfium_asset="pdfium-win-x64.tgz"
    pdfium_library="pdfium.dll"
    pdfium_member="bin/$pdfium_library"
    pdfium_sha256="739a57d597d864297909cc40a2411eba728490c76a0fa25e3ea299c7f6b07020"
    ;;
  aarch64-pc-windows-msvc)
    pdfium_asset="pdfium-win-arm64.tgz"
    pdfium_library="pdfium.dll"
    pdfium_member="bin/$pdfium_library"
    pdfium_sha256="5d04b6d0281e78613ef836dea2e0fefe6831f3ae92b3573e8fdf55330de67d3d"
    ;;
  *)
    printf 'OCR asset preparation is not configured for target %s.\n' "$target" >&2
    exit 1
    ;;
esac

if [[ "$target" != "$host_target" && "$target" != *-pc-windows-msvc ]]; then
  printf 'Host Tesseract cannot be staged for non-host target %s.\n' "$target" >&2
  exit 1
fi

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

resource_dir="${EPIKRISE_OCR_RESOURCE_DIR:-src-tauri/resources/ocr}"
binary_dir="${EPIKRISE_OCR_BINARY_DIR:-src-tauri/binaries}"
cache_root="${EPIKRISE_WINDOWS_OCR_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/epikrise/windows-ocr}"
pdfium_cache_dir="$cache_root/pdfium/$target"
pdfium_cache_path="$pdfium_cache_dir/$pdfium_asset"
pdfium_path="$resource_dir/pdfium/$pdfium_library"
mkdir -p "$resource_dir/pdfium" "$resource_dir/tessdata" "$binary_dir" "$pdfium_cache_dir"

if [[ ! -f "$pdfium_cache_path" ]] || ! has_expected_sha256 "$pdfium_sha256" "$pdfium_cache_path"; then
  rm -f "$pdfium_cache_path" "$pdfium_cache_path.part"
  pdfium_url="https://github.com/bblanchon/pdfium-binaries/releases/download/chromium/8066/$pdfium_asset"
  curl --fail --location --silent --show-error "$pdfium_url" -o "$pdfium_cache_path.part"
  if ! has_expected_sha256 "$pdfium_sha256" "$pdfium_cache_path.part"; then
    printf 'PDFium checksum mismatch for %s.\n' "$pdfium_asset" >&2
    rm -f "$pdfium_cache_path.part"
    exit 1
  fi
  mv "$pdfium_cache_path.part" "$pdfium_cache_path"
fi

temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT
tar -xzf "$pdfium_cache_path" -C "$temp_dir" "$pdfium_member"
install -m 0644 "$temp_dir/$pdfium_member" "$pdfium_path"

install -m 0644 "$tessdata_dir/deu.traineddata" "$resource_dir/tessdata/deu.traineddata"
install -m 0644 "$tessdata_dir/eng.traineddata" "$resource_dir/tessdata/eng.traineddata"

if [[ "$target" == *-pc-windows-msvc ]]; then
  builder="${EPIKRISE_WINDOWS_OCR_BUILDER:-$repo_root/scripts/build-windows-ocr.sh}"
  EPIKRISE_OCR_BINARY_DIR="$binary_dir" bash "$builder" "$target"
else
  sidecar_path="$binary_dir/tesseract-$target"
  ln -sfn "$(cd "$(dirname "$tesseract_path")" && pwd)/$(basename "$tesseract_path")" "$sidecar_path"
fi

if [[ ! -f "$binary_dir/tesseract-$target" && ! -f "$binary_dir/tesseract-$target.exe" ]]; then
  printf 'Tesseract sidecar was not produced for target %s.\n' "$target" >&2
  exit 1
fi