#!/usr/bin/env bash
# Adds Linux packages to static apt and dnf trees and regenerates signed metadata.
# Existing files under the repository root are kept, so callers sync the
# previously published repository down before running this script.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: EPIKRISE_GPG_KEY_ID=<key-id> build-linux-repositories.sh --repo-root <dir> <package>...

Adds each .deb or .rpm package to <dir>/apt and <dir>/rpm, regenerates the
repository metadata, and signs it with the GPG key named by EPIKRISE_GPG_KEY_ID.
The key must be available in the active GNUPGHOME without a passphrase prompt.
USAGE
}

repo_root=""
packages=()
while (($#)); do
  case "$1" in
    --repo-root)
      repo_root="${2:?--repo-root requires a value}"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    --*)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      packages+=("$1")
      shift
      ;;
  esac
done

: "${EPIKRISE_GPG_KEY_ID:?EPIKRISE_GPG_KEY_ID must name the repository signing key}"
if [[ -z "$repo_root" ]] || ((${#packages[@]} == 0)); then
  usage >&2
  exit 2
fi

for tool in apt-ftparchive createrepo_c dpkg-deb gpg rpm; do
  command -v "$tool" >/dev/null || {
    echo "Missing required tool: $tool" >&2
    exit 1
  }
done

apt_root="$repo_root/apt"
dnf_root="$repo_root/rpm"
pool_dir="$apt_root/pool/main/e/epikrise"
suite_dir="$apt_root/dists/stable"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

# Maps Debian architectures to the matching RPM architecture directory names.
rpm_arch_for_deb() {
  case "$1" in
    amd64) echo x86_64 ;;
    arm64) echo aarch64 ;;
    *) return 1 ;;
  esac
}

add_package() {
  local package="$1"
  local name arch rpm_arch
  name="$(basename "$package")"
  case "$name" in
    *.deb)
      arch="$(dpkg-deb -f "$package" Architecture)"
      rpm_arch="$(rpm_arch_for_deb "$arch")" || {
        echo "Unsupported Debian architecture in $name: $arch" >&2
        exit 1
      }
      mkdir -p "$pool_dir"
      cp -f "$package" "$pool_dir/$name"
      ;;
    *.rpm)
      arch="$(rpm -qp --qf '%{ARCH}' "$package")"
      case "$arch" in
        x86_64 | aarch64) ;;
        *)
          echo "Unsupported RPM architecture in $name: $arch" >&2
          exit 1
          ;;
      esac
      mkdir -p "$dnf_root/$arch"
      cp -f "$package" "$dnf_root/$arch/$name"
      # Signing runs on the copy so the caller's artifact is left untouched.
      rpm --addsign \
        --define "_gpg_name $EPIKRISE_GPG_KEY_ID" \
        "$dnf_root/$arch/$name"
      ;;
    *)
      echo "Not a .deb or .rpm package: $package" >&2
      exit 1
      ;;
  esac
}

# Splits the combined Packages index into one index per Debian architecture.
write_apt_indexes() {
  local all_packages="$work_dir/Packages"
  (cd "$apt_root" && apt-ftparchive packages pool) >"$all_packages"

  local apt_arch index_dir
  for apt_arch in amd64 arm64; do
    index_dir="$suite_dir/main/binary-$apt_arch"
    mkdir -p "$index_dir"
    awk -v arch="$apt_arch" '
      BEGIN { RS = ""; FS = "\n"; ORS = "\n\n" }
      {
        for (i = 1; i <= NF; i++) {
          if ($i == "Architecture: " arch) { print; break }
        }
      }
    ' "$all_packages" >"$index_dir/Packages"
    gzip -9 -n -c "$index_dir/Packages" >"$index_dir/Packages.gz"
  done
}

write_apt_release() {
  (
    cd "$suite_dir"
    apt-ftparchive release \
      -o APT::FTPArchive::Release::Origin=Epikrise \
      -o APT::FTPArchive::Release::Label=Epikrise \
      -o APT::FTPArchive::Release::Suite=stable \
      -o APT::FTPArchive::Release::Codename=stable \
      -o APT::FTPArchive::Release::Components=main \
      -o APT::FTPArchive::Release::Architectures="amd64 arm64" \
      . >Release
    gpg --batch --yes --local-user "$EPIKRISE_GPG_KEY_ID" \
      --clearsign --output InRelease Release
    gpg --batch --yes --local-user "$EPIKRISE_GPG_KEY_ID" \
      --detach-sign --armor --output Release.gpg Release
  )
}

write_dnf_metadata() {
  local rpm_arch arch_dir
  for rpm_arch in x86_64 aarch64; do
    arch_dir="$dnf_root/$rpm_arch"
    [[ -d "$arch_dir" ]] || continue
    createrepo_c --quiet "$arch_dir"
    gpg --batch --yes --local-user "$EPIKRISE_GPG_KEY_ID" \
      --detach-sign --armor \
      --output "$arch_dir/repodata/repomd.xml.asc" \
      "$arch_dir/repodata/repomd.xml"
  done
}

for package in "${packages[@]}"; do
  [[ -f "$package" ]] || {
    echo "Package not found: $package" >&2
    exit 1
  }
done
for package in "${packages[@]}"; do
  add_package "$package"
done

if [[ -d "$pool_dir" ]]; then
  write_apt_indexes
  write_apt_release
fi
if [[ -d "$dnf_root" ]]; then
  write_dnf_metadata
fi
gpg --batch --armor --export "$EPIKRISE_GPG_KEY_ID" \
  >"$repo_root/epikrise-archive-keyring.asc"

echo "Linux repositories updated under $repo_root"
