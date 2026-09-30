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
- Run Rust and UI/internationalization tests via the VS Code Test Explorer. If the Test Explorer is unavailable or fails to discover tests, run `pnpm test:ui` and `pnpm test:rust` from the integrated terminal instead.
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

- `pnpm install --frozen-lockfile`: Install project dependencies without modifying the lockfile.
- `pnpm dev`: Start the development server and frontend environment.
- `pnpm build`: Build the project for production.
- `pnpm audit:rust`: Audit dependencies in `src-tauri/Cargo.lock`.
- `pnpm audit:pnpm`: Audit pnpm dependencies; fail on high-severity findings, matching CI.
- `pnpm check`: Run all checks for the project, including UI and Rust code.
- `pnpm check:ui`: Run UI-specific checks.
- `pnpm check:rust`: Run Rust formatting, Clippy, and cargo-deny policy checks.
- `pnpm check:rust:fmt`: Check Rust code formatting.
- `pnpm check:rust:clippy`: Lint Rust code with Clippy.
- `pnpm check:rust:deny`: Check Rust dependency, license, and source policies with cargo-deny.
- `pnpm test`: Run all test suites, including UI, internationalization, and Rust tests (fallback when Test Explorer is unavailable).
- `pnpm test:ui`: Run UI tests (fallback when Test Explorer is unavailable).
- `pnpm test:i18n`: Test internationalization (fallback when Test Explorer is unavailable).
- `pnpm test:rust`: Run all Rust tests (fallback when Test Explorer is unavailable).
- `pnpm test:rust:package <package> [<args>]`: Test a specific Rust package with optional arguments (fallback when Test Explorer is unavailable).
- `pnpm format:check`: Check formatting for all files with Prettier.
- `pnpm format:check:file <filename>`: Check formatting for a specific file with Prettier.
- `pnpm format`: Format all files in the project with Prettier.
- `pnpm format:file <filename>`: Format a specific file with Prettier.
- `pnpm lint`: Lint all files in the project with ESLint.
