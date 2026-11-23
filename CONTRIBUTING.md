# Contributing

Thanks for your interest. This document covers the development setup, the project layout and the rules that keep the codebase safe for clinical use.

## Ground rules

Epikrise handles clinical text. Two constraints override normal convenience:

1. **Clinical content must never be persisted or logged.** Temporary OCR image files may be written only to private temporary directories; overwrite them before removal and clean up abandoned directories on the next launch. Never include clinical content in debug output or error messages.
2. **No panicking code paths.** `unwrap`, `expect`, `panic!` and friends are denied by clippy outside of tests. Return a typed error instead.

Both rules are enforced mechanically; see [Quality gates](#quality-gates).

## Development setup

Use the [dev container](.devcontainer/devcontainer.json), which has everything preinstalled. For a native setup, follow the [Development setup](https://github.com/jerney-nexus/epikrise/wiki/Development-Setup) wiki page for your operating system, including OCR language data. Native builds need Rust 1.90+ and Node.js 22+.

From the repository root:

```sh
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm tauri dev
```

## Project layout

```
src/                      SvelteKit frontend (SPA, no SSR)
src-tauri/                Tauri application crate — commands and wiring only
src-tauri/crates/
  epikrise-core/          domain types, template engine, case session
  epikrise-ingest/        extraction pipeline for files, images, clipboard, URLs
  epikrise-llm/           provider profiles and the LlmClient abstraction
templates/                local-only, git-ignored clinical templates
```

The three library crates deliberately have no Tauri dependency. Business logic belongs there, not in `src-tauri/src/`, so it can be unit-tested without spinning up a webview.

## Quality gates

Before opening a pull request, run at least:

```sh
pnpm check
pnpm test
pnpm build
```

The full gate list, including formatting, linting, and audit commands, is on the [Testing wiki page](https://github.com/jerney-nexus/epikrise/wiki/Testing).

## Commits and changelog

Use Conventional Commit subjects (`feat: add template importer`, `fix: handle formatted output`) and keep each commit focused on one change. User-visible changes get an entry under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md).

Release preparation, the release gates, and the updater and Store rules are documented in the [Releasing](https://github.com/jerney-nexus/epikrise/wiki/Releasing) wiki page.

## Localization

User-facing strings live in Fluent catalogs under `locales/`. Rust code returns translation keys and arguments, never localized text — the frontend resolves them. Adding a language means adding a folder; do not hardcode strings in command return paths.

English literals that are intentionally not translated are not hardcoded UI strings and should not be flagged in review:

- Brand and provider names, such as Epikrise, Ollama, OpenAI, Anthropic, Gemini, OpenRouter, Groq, and xAI.
- Text sent to the model, such as the correction prompt built in `regenerateWithCorrections` in `src/routes/+page.svelte`.
- Persisted template data, such as the default section heading and `labels` written by `addTemplateEditorSection`. Stored data must not follow the UI language.
- Fluent source strings passed to `t()` or assigned to status state, such as `generationMessage = "Draft ready"`. `t()` resolves them through the catalogs, and missing keys fall back to the English source, so keys must be added to every catalog.
- CSS font names and placeholder URL examples.

Startup dialogs, the window title, and the Crowdin translation review are described in the [Localization wiki page](https://github.com/jerney-nexus/epikrise/wiki/Localization).

## Templates and test data

Never commit real or realistic clinical material, not even as a test fixture. The `templates/` and `fixtures/clinical/` directories are git-ignored for this reason. Fixtures used by tests must be synthetic.

## Reporting security issues

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Do not open a public issue, especially for anything that could expose clinical content.
