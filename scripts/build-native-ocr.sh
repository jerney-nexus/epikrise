#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="${1:-}"
host_target="$(rustc -vV | sed -n 's/^host: //p')"
if [[ "$target" != "$host_target" ]]; then
  printf 'Native OCR builds require target %s to match host %s.\n' "$target" "$host_target" >&2
  exit 1
fi

case "$target" in
  x86_64-unknown-linux-gnu|aarch64-unknown-linux-gnu)
    platform="linux"
    ;;
  x86_64-apple-darwin|aarch64-apple-darwin)
    platform="macos"
    ;;
  *)
    printf 'Unsupported native OCR target: %s\n' "$target" >&2
    exit 2
    ;;
esac

for tool in cmake ninja curl tar; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'Required native OCR build tool is missing: %s\n' "$tool" >&2
    exit 1
  fi
done

cache_root="${EPIKRISE_NATIVE_OCR_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/epikrise/native-ocr}"
download_dir="$cache_root/downloads"
source_dir="$cache_root/sources"
build_dir="$cache_root/build/$target"
prefix="$cache_root/install/$target"
binary_dir="${EPIKRISE_OCR_BINARY_DIR:-$repo_root/src-tauri/binaries}"
mkdir -p "$download_dir" "$source_dir" "$build_dir" "$prefix"

file_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

download_verified() {
  local url="$1"
  local filename="$2"
  local expected_sha256="$3"
  local archive_path="$download_dir/$filename"

  if [[ ! -f "$archive_path" ]] || [[ "$(file_sha256 "$archive_path")" != "$expected_sha256" ]]; then
    rm -f "$archive_path" "$archive_path.part"
    curl --fail --location --silent --show-error "$url" -o "$archive_path.part"
    if [[ "$(file_sha256 "$archive_path.part")" != "$expected_sha256" ]]; then
      printf 'SHA-256 mismatch for %s.\n' "$filename" >&2
      exit 1
    fi
    mv "$archive_path.part" "$archive_path"
  fi
  printf '%s\n' "$archive_path"
}

extract_source() {
  local archive_path="$1"
  local directory_name="$2"
  local destination="$source_dir/$directory_name"

  if [[ ! -f "$destination/CMakeLists.txt" ]]; then
    rm -rf "$destination"
    mkdir -p "$destination"
    tar -xf "$archive_path" --strip-components=1 -C "$destination"
  fi
  printf '%s\n' "$destination"
}

zlib_archive="zlib-1.3.1.tar.gz"
zlib_sha256="9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23"
png_archive="libpng-v1.6.50.tar.gz"
png_sha256="71158e53cfdf2877bc99bcab33641d78df3f48e6e0daad030afe9cb8c031aa46"
lept_archive="leptonica-1.85.0.tar.gz"
lept_sha256="c01376bce0379d4ea4bc2ec5d5cbddaa49e2f06f88242619ab8c059e21adf233"
tesseract_archive="tesseract-5.5.0.tar.gz"
tesseract_sha256="f2fb34ca035b6d087a42875a35a7a5c4155fa9979c6132365b1e5a28ebc3fc11"

zlib_archive_path="$(download_verified 'https://zlib.net/fossils/zlib-1.3.1.tar.gz' "$zlib_archive" "$zlib_sha256")"
png_archive_path="$(download_verified 'https://github.com/glennrp/libpng/archive/refs/tags/v1.6.50.tar.gz' "$png_archive" "$png_sha256")"
lept_archive_path="$(download_verified 'https://github.com/DanBloomberg/leptonica/archive/refs/tags/1.85.0.tar.gz' "$lept_archive" "$lept_sha256")"
tesseract_archive_path="$(download_verified 'https://github.com/tesseract-ocr/tesseract/archive/refs/tags/5.5.0.tar.gz' "$tesseract_archive" "$tesseract_sha256")"

zlib_source="$(extract_source "$zlib_archive_path" "zlib-1.3.1")"
png_source="$(extract_source "$png_archive_path" "libpng-1.6.50")"
lept_source="$(extract_source "$lept_archive_path" "leptonica-1.85.0")"
tesseract_source="$(extract_source "$tesseract_archive_path" "tesseract-5.5.0")"

cmake_args=(
  -G Ninja
  -DCMAKE_BUILD_TYPE=Release
  -DCMAKE_INSTALL_PREFIX="$prefix"
  -DCMAKE_INSTALL_LIBDIR=lib
  -DCMAKE_PREFIX_PATH="$prefix"
  -DBUILD_SHARED_LIBS=OFF
  -DZLIB_USE_STATIC_LIBS=ON
)
if [[ "$platform" == "linux" ]]; then
  cmake_args+=("-DCMAKE_EXE_LINKER_FLAGS=-static")
else
  cmake_args+=("-DCMAKE_FIND_LIBRARY_SUFFIXES=.a")
fi

build_and_install() {
  local name="$1"
  local source="$2"
  shift 2
  cmake -S "$source" -B "$build_dir/$name" "${cmake_args[@]}" "$@"
  cmake --build "$build_dir/$name" --parallel
  cmake --install "$build_dir/$name"
}

build_and_install zlib "$zlib_source" \
  -DZLIB_BUILD_EXAMPLES=OFF
build_and_install libpng "$png_source" \
  -DPNG_SHARED=OFF \
  -DPNG_STATIC=ON \
  -DPNG_TESTS=OFF \
  -DPNG_TOOLS=OFF \
  -DZLIB_ROOT="$prefix"
build_and_install leptonica "$lept_source" \
  -DBUILD_PROG=OFF \
  -DSW_BUILD=OFF \
  -DENABLE_ZLIB=ON \
  -DENABLE_PNG=ON \
  -DENABLE_GIF=OFF \
  -DENABLE_JPEG=OFF \
  -DENABLE_TIFF=OFF \
  -DENABLE_WEBP=OFF \
  -DENABLE_OPENJPEG=OFF \
  -DZLIB_USE_STATIC_LIBS=ON
build_and_install tesseract "$tesseract_source" \
  -DBUILD_TRAINING_TOOLS=OFF \
  -DBUILD_TESTS=OFF \
  -DDISABLE_ARCHIVE=ON \
  -DDISABLE_CURL=ON \
  -DDISABLE_TIFF=ON \
  -DOPENMP_BUILD=OFF \
  -DSW_BUILD=OFF \
  -DLEPT_TIFF_RESULT:STRING=1 \
  -DLEPT_TIFF_COMPILE_SUCCESS:BOOL=TRUE \
  -DLeptonica_DIR="$prefix/lib/cmake/leptonica"

mkdir -p "$binary_dir"
sidecar="$binary_dir/tesseract-$target"
if [[ -L "$sidecar" ]]; then
  rm -f "$sidecar"
fi
install -m 0755 "$prefix/bin/tesseract" "$sidecar"
if [[ "$platform" == "linux" ]]; then
  ldd_output="$(ldd "$sidecar" 2>&1 || true)"
  if [[ "$ldd_output" != *"not a dynamic executable"* && "$ldd_output" != *"statically linked"* ]]; then
    printf 'Linux Tesseract sidecar is not statically linked.\n' >&2
    exit 1
  fi
else
  non_system_dependencies="$(otool -L "$sidecar" | tail -n +2 | grep -Ev '^[[:space:]]+(/usr/lib/|/System/Library/|/Library/Apple/)' || true)"
  if [[ -n "$non_system_dependencies" ]]; then
    printf 'macOS Tesseract sidecar depends on a non-system dynamic library.\n' >&2
    otool -L "$sidecar" >&2
    exit 1
  fi
fi

printf 'Built portable Tesseract sidecar: %s\n' "$sidecar"