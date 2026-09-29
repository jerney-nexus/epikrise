# Project guidance

- When working in the dev container, use `/workspaces/epikrise` as the project root.
- Epikrise is a local-only desktop assistant for anonymized clinical material. Do not add telemetry or commit real patient data, prompts, or generated clinical output.
- The UI lives in `src/` (SvelteKit, TypeScript); desktop commands live in `src-tauri/src/` (Tauri). Keep domain logic in `src-tauri/crates/epikrise-core/`, extraction in `epikrise-ingest/`, and model integrations in `epikrise-llm/`.
- Follow nearby patterns and keep changes focused. Do not hand-edit generated files in `build/`, `src-tauri/target/`, or generated bindings.
- For UI changes, run `pnpm check` and `pnpm test`; for Rust changes, run `cargo fmt --all --check`, `cargo clippy --workspace --all-targets`, and `cargo test --workspace` from `src-tauri/`. Report checks that cannot run.
- See `README.md` and `CONTRIBUTING.md` for setup and project conventions, and `TODO.md` for project ideas and unfinished work.
- Update the `CHANGELOG.md` when changes are notable to users.
