#!/usr/bin/env bash
# Gives the Copilot CLI and Claude Code writable homes in the container while
# keeping host configuration and skills read-only.
#
# The host ~/.copilot and ~/.claude directories are bind-mounted read-only at
# ~/.copilot-host and ~/.claude-host (see devcontainer.json). Named volumes
# provide writable ~/.copilot and ~/.claude roots for runtime/session state;
# selected config files are copied into the writable homes, while static skills
# and instruction directories are symlinked so the CLIs cannot modify the host.
set -euo pipefail

sudo install -d -o vscode -g vscode -m 0700 /home/vscode/.copilot /home/vscode/.claude

link_host_entries() {
  local host_dir="$1"
  local target_dir="$2"
  shift 2
  local name
  for name in "$@"; do
    if [[ -e "$host_dir/$name" && ! -e "$target_dir/$name" ]]; then
      ln -sfn "$host_dir/$name" "$target_dir/$name"
    fi
  done
}

copy_host_files() {
  local host_dir="$1"
  local target_dir="$2"
  shift 2
  local name
  for name in "$@"; do
    if [[ -f "$host_dir/$name" && ! -e "$target_dir/$name" ]]; then
      install -m 0600 "$host_dir/$name" "$target_dir/$name"
    fi
  done
}

# Copilot config is seeded as writable copies; skills and instructions remain
# read-only host links. Runtime state is writable in the volume.
copy_host_files /home/vscode/.copilot-host /home/vscode/.copilot \
  config.json mcp-config.json
link_host_entries /home/vscode/.copilot-host /home/vscode/.copilot \
  skills agents instructions prompts

# Claude settings are seeded as a writable copy; skills and instructions remain
# read-only host links. Projects, todos, sessions, and other state are writable.
copy_host_files /home/vscode/.claude-host /home/vscode/.claude settings.json
link_host_entries /home/vscode/.claude-host /home/vscode/.claude \
  CLAUDE.md skills agents commands
