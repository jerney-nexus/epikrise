# AGENTS.md

## Project

Epikrise is a local-only desktop assistant for anonymized clinical material. Node.js 22 + Rust 2024 + Tauri v2.

This file is the shared foundation for all coding assistants. Keep tool-specific guidance in `.github/copilot-instructions.md` and `CLAUDE.md`.

## Architecture

Epikrise follows a modular architecture with a clear separation of concerns:

- `src/`: SvelteKit-based UI and TypeScript code.
- `src-tauri/src/`: Tauri desktop commands.
- `src-tauri/crates/epikrise-core/`: Core domain logic.
- `src-tauri/crates/epikrise-ingest/`: Data extraction and ingestion.
- `src-tauri/crates/epikrise-llm/`: Model integrations and language processing.
- `build/`: Generated files.
- `src-tauri/target/`: Rust build artifacts, isolated by host triple.

## Global Rules

- Never commit secrets or API keys.
- Do not add telemetry or commit real patient data, prompts, or generated clinical output.
- All PRs require passing tests before merge.
- Use the commands listed in the "Commands" section below for development, testing, and formatting tasks.
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

- Install dependencies with `pnpm install --frozen-lockfile`.
- Run the app with `pnpm dev`; build or preview it with `pnpm build` and `pnpm preview`. Use `pnpm tauri dev` or `pnpm tauri build` for desktop runs and bundles.
- Run checks with `pnpm check` (UI and Rust), `pnpm check:ui`, or `pnpm check:rust`. Rust checks can also be run individually with `pnpm check:rust:fmt`, `pnpm check:rust:clippy` (warnings denied), and `pnpm check:rust:deny`.
- Run tests with `pnpm test` (UI, i18n, and Rust), or use `pnpm test:ui`, `pnpm test:i18n`, `pnpm test:rust`, and `pnpm test:rust:package <package> [<args>]`. Run browser tests with `pnpm test:e2e` and accessibility-only browser tests with `pnpm test:a11y`. `pnpm test:coverage` runs UI and Rust tests with coverage, writing reports to `coverage/` and `lcov.info`; use `pnpm test:ui:coverage` or `pnpm test:rust:coverage` for a targeted coverage run.
- Check or apply formatting with `pnpm format:check`, `pnpm format`, `pnpm format:check:file <file>`, `pnpm format:file <file>`, and `pnpm format:rust:fmt`. Run ESLint with `pnpm lint`.
- Audit dependencies with `pnpm audit:rust` and `pnpm audit:pnpm`.
- Prepare a CalVer release with `pnpm release:prepare [YYYY.MM.PATCH]`; convert a prompt with `pnpm template:convert`.
- Set up and build Windows installers with `pnpm windows:setup`, `pnpm windows:build:x64`, `pnpm windows:build:arm64`, or `pnpm windows:build`.
