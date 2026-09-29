# Project guidance

- When working in the dev container, use `/workspaces/epikrise` as the project root.
- Epikrise is a local-only desktop assistant for anonymized clinical material. Do not add telemetry or commit real patient data, prompts, or generated clinical output.
- The UI lives in `src/` (SvelteKit, TypeScript); desktop commands live in `src-tauri/src/` (Tauri). Keep domain logic in `src-tauri/crates/epikrise-core/`, extraction in `epikrise-ingest/`, and model integrations in `epikrise-llm/`.
- Follow nearby patterns and keep changes focused. Do not hand-edit generated files in `build/`, `src-tauri/target/`, or generated bindings.
- Report checks that cannot run.
- See `README.md` and `CONTRIBUTING.md` for setup and project conventions, and `TODO.md` for project ideas and unfinished work.
- Update the `CHANGELOG.md` when changes are notable to users.

## Code Style

- TypeScript, JavaScript, and Svelte: follow Prettier (2-space indentation, double quotes, trailing commas, 88-character print width) and ESLint; follow nearby Svelte component patterns.
- Rust: use edition 2024 conventions and `rustfmt`; use `snake_case` for functions and fields, `PascalCase` for types, and handle errors without panicking.
- Bash: use `#!/usr/bin/env bash`, `set -euo pipefail`, quoted expansions, and `snake_case` names, as in the existing scripts.

## Commands

- Install: `pnpm install --frozen-lockfile`
- Dev server: `pnpm dev`
- Build project: `pnpm build`
- Check (UI changes): `pnpm check`
- Test (UI changes): `pnpm test`
- Check (Rust changes): `pnpm check:rust:fmt` and `pnpm check:rust:clippy`
- Test (Rust changes): `pnpm test:rust`
- Check formatting: `pnpm format:check`
- Format code: `pnpm format`
- Lint code: `pnpm lint`
