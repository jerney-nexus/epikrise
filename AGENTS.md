# AGENTS.md

## Project

Epikrise is a local-only desktop assistant for anonymized clinical material. Node.js 22 + Rust 2024 + Tauri v2.

## Architecture

Epikrise follows a modular architecture with a clear separation of concerns:

- `src/`: SvelteKit-based UI and TypeScript code.
- `src-tauri/src/`: Tauri desktop commands.
- `src-tauri/crates/epikrise-core/`: Core domain logic.
- `src-tauri/crates/epikrise-ingest/`: Data extraction and ingestion.
- `src-tauri/crates/epikrise-llm/`: Model integrations and language processing.
- `build/`: Generated files.
- `src-tauri/target/`: Rust build artifacts.

## Global Rules

- Never commit secrets or API keys.
- Do not add telemetry or commit real patient data, prompts, or generated clinical output.
- All PRs require passing tests before merge.
- When working in the dev container, use `/workspaces/epikrise` as the project root.
- Follow nearby patterns and keep changes focused.
- Do not hand-edit generated files in `build/`, `src-tauri/target/`, or generated bindings.
- Report checks that cannot run.
- See `README.md` and `CONTRIBUTING.md` for setup and project conventions, and `TODO.md` for project ideas and unfinished work.
- Update the `CHANGELOG.md` when changes are notable to users.

## Code Style

- TypeScript, JavaScript, and Svelte: follow Prettier (2-space indentation, double quotes, trailing commas, 88-character print width) and ESLint; follow nearby Svelte component patterns.
- Rust: use edition 2024 conventions and `rustfmt`; use `snake_case` for functions and fields, `PascalCase` for types, and handle errors without panicking.
- Bash: use `#!/usr/bin/env bash`, `set -euo pipefail`, quoted expansions, and `snake_case` names, as in the existing scripts.

## Commands

- `pnpm install --frozen-lockfile`: Install dependencies.
- `pnpm dev`: Start the server and frontend development environment.
- `pnpm build`: Production build.
- `pnpm check`: Check after UI changes.
- `pnpm test`: Test after UI changes.
- `pnpm check:rust:fmt` and `pnpm check:rust:clippy`: Check after Rust changes.
- `pnpm test:rust`: Test after Rust changes.
- `pnpm format:check`: Check formatting for all files.
- `pnpm format:check:file <filename>`: Check formatting for a specific file.
- `pnpm format`: Format all files in the project.
- `pnpm format:file <filename>`: Format a specific file.
- `pnpm lint`: Lint all files in the project.
