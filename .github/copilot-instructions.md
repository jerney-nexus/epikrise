# GitHub Copilot Instructions

Read and follow [AGENTS.md](../AGENTS.md) before working in this repository. It is the source of truth for shared project rules, architecture, code style, and commands.

## Critical Boundaries

- Never commit secrets or API keys.
- Do not add telemetry or commit real patient data, prompts, or generated clinical output.
- Do not hand-edit generated files in `build/`, `src-tauri/target/`, or generated bindings.

## VS Code Testing

- Run Rust and UI/internationalization tests via the VS Code Test Explorer.
- If the Test Explorer is unavailable or fails to discover tests, run `pnpm test:ui` and `pnpm test:rust` from the integrated terminal instead; use `pnpm test:i18n` for a targeted internationalization run.
- Outside VS Code, use the test scripts listed in `AGENTS.md`.
