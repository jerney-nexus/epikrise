#!/usr/bin/env bash
set -euo pipefail

test_home="$(mktemp -d "${TMPDIR:-/tmp}/epikrise-session-bus-test.XXXXXX")"
xdg_data_home="$test_home/.local/share"
mkdir -p "$xdg_data_home"
cleanup() {
  rm -rf -- "$test_home"
}
trap cleanup EXIT

dbus-run-session -- bash -c '
set -euo pipefail
printf "%s\n" "epikrise-integration-test" |
  HOME="$1" XDG_DATA_HOME="$2" gnome-keyring-daemon --unlock --components=secrets >/dev/null
pnpm test:rust:package epikrise --run-ignored ignored-only \
  linux_session_bus::tests::linux_startup_reexec_resolves_autolaunch_and_lists_credentials
' epikrise "$test_home" "$xdg_data_home"
