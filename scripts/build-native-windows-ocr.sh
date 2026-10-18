#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="${1:-}"
host_os="$(uname -s)"
case "$host_os" in
  MINGW*|MSYS*|CYGWIN*) ;;
  *)
    printf 'Native MSVC OCR builds require a physical Windows host.\n' >&2
    exit 1
    ;;
esac

physical_arch="$(bash "$repo_root/scripts/detect-windows-os-architecture.sh")"

case "$target" in
  x86_64-pc-windows-msvc)
    expected_rust_arch="x86_64"
    expected_arch="x64"
    expected_machine="8664 machine (x64)"
    ;;
  aarch64-pc-windows-msvc)
    expected_rust_arch="aarch64"
    expected_arch="arm64"
    expected_machine="AA64 machine (ARM64)"
    ;;
  *)
    printf 'Unsupported native Windows OCR target: %s\n' "$target" >&2
    exit 2
    ;;
esac

if [[ "$physical_arch" != "$expected_rust_arch" ]]; then
  printf 'Native MSVC OCR target %s does not match detected physical Windows architecture %s.\n' \
    "$target" "$physical_arch" >&2
  exit 1
fi

host_target="$(rustc -vV | sed -n 's/^host: //p')"
if [[ "$target" != "$host_target" ]]; then
  printf 'Native MSVC OCR builds require target %s to match Rust host %s.\n' "$target" "$host_target" >&2
  exit 1
fi

if [[ "${VSCMD_ARG_TGT_ARCH:-}" != "$expected_arch" ]]; then
  printf 'Open a Visual Studio developer shell targeting %s (VSCMD_ARG_TGT_ARCH=%s).\n' "$expected_arch" "$expected_arch" >&2
  exit 1
fi

host_arch="${VSCMD_ARG_HOST_ARCH:-}"
host_arch="${host_arch,,}"
if [[ "$host_arch" != "$expected_arch" ]]; then
  printf 'Open a Visual Studio developer shell hosted on %s (VSCMD_ARG_HOST_ARCH=%s).\n' "$expected_arch" "$expected_arch" >&2
  exit 1
fi

msvc_cl_exe=""
msvc_cl_cmake=""
msvc_toolset_dir=""
if [[ -n "${EPIKRISE_MSVC_CL_EXE:-}" ]]; then
  msvc_cl_cmake="$EPIKRISE_MSVC_CL_EXE"
  msvc_cl_exe="$(cygpath -u "$EPIKRISE_MSVC_CL_EXE")"
  msvc_tools_bin="$(dirname "$msvc_cl_exe")"
  msvc_toolset_dir="$(dirname "$(dirname "$(dirname "$(dirname "$msvc_cl_exe")")")")"
  msvc_include_dir="$msvc_toolset_dir/include"
  msvc_lib_dir="$msvc_toolset_dir/lib/$expected_arch"
  if [[ ! -f "$msvc_include_dir/vcruntime.h" ]]; then
    printf 'MSVC C++ runtime header was not found: %s/vcruntime.h.\n' "$msvc_include_dir" >&2
    printf 'Repair the Visual Studio C++ workload and install its MSVC headers for this toolset.\n' >&2
    exit 1
  fi
  if [[ ! -f "$msvc_lib_dir/libcmt.lib" ]]; then
    printf 'MSVC runtime library was not found: %s/libcmt.lib.\n' "$msvc_lib_dir" >&2
    exit 1
  fi
  msvc_include_dir_windows="$(cygpath -w "$msvc_include_dir")"
  msvc_lib_dir_windows="$(cygpath -w "$msvc_lib_dir")"
  PATH="$msvc_tools_bin:$PATH"
  INCLUDE="$msvc_include_dir_windows${INCLUDE:+;$INCLUDE}"
  LIB="$msvc_lib_dir_windows${LIB:+;$LIB}"
  export PATH
  export INCLUDE
  export LIB
else
  msvc_cl_exe="$(command -v cl.exe || command -v cl || true)"
  if [[ -n "$msvc_cl_exe" ]]; then
    msvc_cl_cmake="$(cygpath -w "$msvc_cl_exe")"
  fi
fi
if [[ -z "$msvc_cl_exe" || -z "$msvc_cl_cmake" ]]; then
  printf 'Could not locate the selected MSVC compiler executable.\n' >&2
  exit 1
fi

msys2_env_conv_excl="${MSYS2_ENV_CONV_EXCL:-}"
for variable in INCLUDE LIB LIBPATH; do
  case ";$msys2_env_conv_excl;" in
    *";$variable=;"*) ;;
    *) msys2_env_conv_excl="${msys2_env_conv_excl:+$msys2_env_conv_excl;}$variable=" ;;
  esac
done
export MSYS2_ENV_CONV_EXCL="$msys2_env_conv_excl"

for tool in cmake ninja cl dumpbin curl tar grep; do
  if ! command -v "$tool" >/dev/null 2>&1 \
    && ! command -v "$tool.exe" >/dev/null 2>&1; then
    printf 'Required native Windows OCR build tool is missing: %s.\n' "$tool" >&2
    exit 1
  fi
done

cache_root="${EPIKRISE_NATIVE_WINDOWS_OCR_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/epikrise/windows-ocr-native-msvc}"
download_dir="$cache_root/downloads"
source_dir="$cache_root/sources"
compiler_version="${VCToolsVersion:-}"
if [[ -z "$compiler_version" ]]; then
  if [[ -n "$msvc_toolset_dir" ]]; then
    compiler_version="$(basename "$msvc_toolset_dir")"
  fi
  if [[ -z "$compiler_version" ]]; then
    printf 'Could not determine the MSVC toolset version from VCToolsVersion or the resolved compiler path.\n' >&2
    exit 1
  fi
fi
toolchain_id="msvc-$compiler_version-$host_arch"
build_dir="$cache_root/build/$toolchain_id/$target"
prefix="$cache_root/install/$toolchain_id/$target"
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
  -DCMAKE_C_COMPILER="$msvc_cl_cmake"
  -DCMAKE_CXX_COMPILER="$msvc_cl_cmake"
  -DCMAKE_POLICY_DEFAULT_CMP0091=NEW
  -DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded
  -DBUILD_SHARED_LIBS=OFF
  -DZLIB_USE_STATIC_LIBS=ON
)

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

sidecar="$binary_dir/tesseract-$target.exe"
install -D -m 0755 "$prefix/bin/tesseract.exe" "$sidecar"
node "$repo_root/scripts/verify-binary-architecture.mjs" "$target" "$sidecar"
headers="$(
  MSYS2_ARG_CONV_EXCL="${MSYS2_ARG_CONV_EXCL:+$MSYS2_ARG_CONV_EXCL;}/headers" \
    dumpbin /headers "$sidecar"
)"
if ! printf '%s\n' "$headers" | grep -Fqi "$expected_machine"; then
  printf 'Tesseract sidecar has the wrong machine type for %s.\n' "$target" >&2
  exit 1
fi

node "$repo_root/scripts/verify-runtime-dependencies.mjs" "$target" "$sidecar"

printf 'Built native MSVC Tesseract sidecar: %s\n' "$sidecar"
