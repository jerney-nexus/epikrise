#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "aarch64" ]]; then
  printf 'Windows OCR cross-compilation requires the Linux ARM64 dev container.\n' >&2
  exit 1
fi

target="${1:-}"
case "$target" in
  x86_64-pc-windows-msvc)
    mingw_target="x86_64-w64-mingw32"
    expected_machine="IMAGE_FILE_MACHINE_AMD64"
    ;;
  aarch64-pc-windows-msvc)
    mingw_target="aarch64-w64-mingw32"
    expected_machine="IMAGE_FILE_MACHINE_ARM64"
    ;;
  *)
    printf 'Usage: %s <x86_64-pc-windows-msvc|aarch64-pc-windows-msvc>\n' "$0" >&2
    exit 2
    ;;
esac

cache_root="${EPIKRISE_WINDOWS_OCR_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/epikrise/windows-ocr}"
binary_dir="${EPIKRISE_OCR_BINARY_DIR:-$repo_root/src-tauri/binaries}"
download_dir="$cache_root/downloads"
source_dir="$cache_root/sources"
build_dir="$cache_root/build/$target"
prefix="$cache_root/install/$target"
mkdir -p "$download_dir" "$source_dir" "$build_dir" "$prefix"

llvm_version="20260922"
llvm_archive="llvm-mingw-$llvm_version-ucrt-ubuntu-22.04-aarch64.tar.xz"
llvm_sha256="07d21263c56bfe9a713db6fdb3f7434bf4c121a005e40397d3b4c0170fb06769"
llvm_url="https://github.com/mstorsjo/llvm-mingw/releases/download/$llvm_version/$llvm_archive"
zlib_archive="zlib-1.3.1.tar.gz"
zlib_sha256="9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23"
png_archive="libpng-v1.6.50.tar.gz"
png_sha256="71158e53cfdf2877bc99bcab33641d78df3f48e6e0daad030afe9cb8c031aa46"
lept_archive="leptonica-1.85.0.tar.gz"
lept_sha256="c01376bce0379d4ea4bc2ec5d5cbddaa49e2f06f88242619ab8c059e21adf233"
tesseract_archive="tesseract-5.5.0.tar.gz"
tesseract_sha256="f2fb34ca035b6d087a42875a35a7a5c4155fa9979c6132365b1e5a28ebc3fc11"

download_verified() {
  local url="$1"
  local filename="$2"
  local expected_sha256="$3"
  local archive_path="$download_dir/$filename"

  if [[ ! -f "$archive_path" ]] || ! printf '%s  %s\n' "$expected_sha256" "$archive_path" | sha256sum --check --status; then
    rm -f "$archive_path" "$archive_path.part"
    curl --fail --location --silent --show-error "$url" -o "$archive_path.part"
    printf '%s  %s\n' "$expected_sha256" "$archive_path.part" | sha256sum --check --status || {
      printf 'SHA-256 mismatch for %s.\n' "$filename" >&2
      exit 1
    }
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

llvm_archive_path="$(download_verified "$llvm_url" "$llvm_archive" "$llvm_sha256")"
llvm_root="$cache_root/toolchains/llvm-mingw-$llvm_version"
llvm_bin="$llvm_root/bin"
if [[ ! -x "$llvm_bin/$mingw_target-clang++" ]]; then
  mkdir -p "$llvm_root"
  tar -xJf "$llvm_archive_path" --strip-components=1 -C "$llvm_root"
fi
export PATH="$llvm_bin:$PATH"
sysroot="$llvm_root/$mingw_target"
compiler="$llvm_bin/$mingw_target-clang"
cxx_compiler="$llvm_bin/$mingw_target-clang++"
llvm_readobj="$llvm_bin/llvm-readobj"
mkdir -p "$prefix/lib"
ln -sfn "$sysroot/lib/libws2_32.a" "$prefix/lib/libWs2_32.a"

zlib_archive_path="$(download_verified 'https://zlib.net/fossils/zlib-1.3.1.tar.gz' "$zlib_archive" "$zlib_sha256")"
png_archive_path="$(download_verified 'https://github.com/glennrp/libpng/archive/refs/tags/v1.6.50.tar.gz' "$png_archive" "$png_sha256")"
lept_archive_path="$(download_verified 'https://github.com/DanBloomberg/leptonica/archive/refs/tags/1.85.0.tar.gz' "$lept_archive" "$lept_sha256")"
tesseract_archive_path="$(download_verified 'https://github.com/tesseract-ocr/tesseract/archive/refs/tags/5.5.0.tar.gz' "$tesseract_archive" "$tesseract_sha256")"

zlib_source="$(extract_source "$zlib_archive_path" "zlib-1.3.1")"
png_source="$(extract_source "$png_archive_path" "libpng-1.6.50")"
lept_source="$(extract_source "$lept_archive_path" "leptonica-1.85.0")"
tesseract_source="$(extract_source "$tesseract_archive_path" "tesseract-5.5.0")"

cross_args=(
  -G Ninja
  -DCMAKE_SYSTEM_NAME=Windows
  -DCMAKE_SYSTEM_PROCESSOR="$mingw_target"
  -DCMAKE_C_COMPILER="$compiler"
  -DCMAKE_CXX_COMPILER="$cxx_compiler"
  -DCMAKE_FIND_ROOT_PATH="$prefix;$sysroot"
  -DCMAKE_FIND_ROOT_PATH_MODE_PROGRAM=NEVER
  -DCMAKE_FIND_ROOT_PATH_MODE_LIBRARY=ONLY
  -DCMAKE_FIND_ROOT_PATH_MODE_INCLUDE=ONLY
  -DCMAKE_FIND_ROOT_PATH_MODE_PACKAGE=ONLY
  -DCMAKE_PREFIX_PATH="$prefix"
  -DCMAKE_BUILD_TYPE=Release
  -DCMAKE_INSTALL_PREFIX="$prefix"
  -DCMAKE_INSTALL_LIBDIR=lib
  "-DCMAKE_CXX_FLAGS=-include cstdlib"
  "-DCMAKE_EXE_LINKER_FLAGS=-static -L$prefix/lib"
)

build_and_install() {
  local name="$1"
  local source="$2"
  shift 2
  cmake -S "$source" -B "$build_dir/$name" "${cross_args[@]}" "$@"
  cmake --build "$build_dir/$name" --parallel
  cmake --install "$build_dir/$name"
}

build_and_install zlib "$zlib_source" \
  -DBUILD_SHARED_LIBS=OFF \
  -DZLIB_BUILD_EXAMPLES=OFF
build_and_install libpng "$png_source" \
  -DBUILD_SHARED_LIBS=OFF \
  -DPNG_SHARED=OFF \
  -DPNG_STATIC=ON \
  -DPNG_TESTS=OFF \
  -DPNG_TOOLS=OFF \
  -DZLIB_ROOT="$prefix" \
  -DZLIB_USE_STATIC_LIBS=ON
build_and_install leptonica "$lept_source" \
  -DBUILD_SHARED_LIBS=OFF \
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
  -DBUILD_SHARED_LIBS=OFF \
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

sidecar="$binary_dir/tesseract-$target.exe"
install -D -m 0755 "$prefix/bin/tesseract.exe" "$sidecar"
node "$repo_root/scripts/verify-binary-architecture.mjs" "$target" "$sidecar"
headers="$("$llvm_readobj" --file-headers "$sidecar")"
if ! printf '%s\n' "$headers" | rg -q "$expected_machine"; then
  printf 'Tesseract sidecar has the wrong machine type for %s.\n' "$target" >&2
  exit 1
fi

imports="$("$llvm_readobj" --coff-imports "$sidecar")"
non_system_imports="$(printf '%s\n' "$imports" | sed -n 's/^[[:space:]]*Name: //p' | rg -iv '^(api-ms-win-|ext-ms-win-|kernel32\.dll$|user32\.dll$|advapi32\.dll$|bcrypt\.dll$|comctl32\.dll$|comdlg32\.dll$|gdi32\.dll$|msvcrt\.dll$|ole32\.dll$|oleaut32\.dll$|shell32\.dll$|shlwapi\.dll$|ucrtbase\.dll$|version\.dll$|winmm\.dll$|ws2_32\.dll$)' || true)"
if [[ -n "$non_system_imports" ]]; then
  printf 'Tesseract sidecar has non-system DLL imports that must be bundled:\n%s\n' "$non_system_imports" >&2
  exit 1
fi

printf 'Built static Tesseract sidecar: %s\n' "$sidecar"