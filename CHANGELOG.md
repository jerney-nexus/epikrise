# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Machine-wide administrator egress policy, Rust-enforced local-only/provider
  restrictions, URL-ingestion control, and first-send confirmation for remote
  generation. Added redacted debug output for clinical payload types, a strict
  webview CSP, production devtools/context-menu hardening, dependency audit
  checks in CI, and administrator controls for template operations, model
  allowlists, output-token ceilings, reasoning effort, fixed provider endpoints,
  and credential-management controls.
- ARM64 Linux cross-compilation for separate Windows x64 and ARM64 NSIS
  installers, with static bundled OCR and offline WebView2 installation.
- Fluent-based German (Switzerland) and English interface localization, OS
  language detection, a persisted language selector, and a development-only
  pseudo-localization preview.
- Responsive fit-to-window layout, separate provider/model/template settings
  dialogs, keychain-backed credential selection, and connection checks that
  populate available models.
- Three-pane clinical drafting workspace with responsive input and output panes,
  provider/template controls, connection settings dialog, and a live-preview
  template editor.
- Template editor controls for managing sections and editing output rules.
- Per-input extraction-method provenance, plain/formatted output previews, and
  review-gated HTML clipboard output with a plain-text fallback.
- Tauri v2 + SvelteKit project scaffold with `adapter-static` in SPA mode.
- Cargo workspace splitting the backend into `epikrise-core`, `epikrise-ingest`
  and `epikrise-llm`, each free of Tauri dependencies so they can be tested
  standalone.
- Workspace-wide lint gates denying `unsafe`, `unwrap`, `expect`, `panic`,
  `dbg!` and stdout/stderr printing outside of tests.
- Dev container definition with the Rust, Node and Linux GUI toolchain
  preinstalled.
- Project documentation: README, contributing guide, changelog and license.
- Provider profiles for OpenAI, Anthropic, Gemini, Ollama, OpenAI-compatible
  endpoints, OpenRouter, xAI and Groq, with model discovery, OS-keychain
  credentials, connection checks, streamed generation and cancellation.
- Configurable generation output limits and reasoning-effort settings.
- Versioned TOML `.epitpl` templates with JSON IPC, validation, preview, local
  `templates.toml` storage and one-time migration from the earlier JSON store,
  import/export, variables, toggleable sections and output rules. Added a
  generic starter and a local plain-text prompt converter.
- In-memory cumulative case sessions with provenance-tagged inputs, output
  lint warnings, corrective regeneration and a Rust-enforced review gate before
  copying.
- Text, PDF, DOCX, XLSX, RTF and HTML extraction, plus PNG/JPEG OCR and
  capability-gated model vision support.
- URL ingestion with DNS-pinned requests, private/reserved address rejection,
  bounded redirects, response size limits, timeouts and article readability
  extraction.
- Scanned-PDF OCR and bounded page-vision fallback, file drop, and clipboard
  text/image input.
- Private temporary OCR directories with stale-directory cleanup and
  overwrite-before-removal handling for temporary image files.
- Native text clipboard access with the Tauri clipboard-manager plugin; image
  paste remains handled by the webview and is sent over IPC.
- ESLint for TypeScript and Svelte, Prettier formatting, and Cargo Nextest for
  Rust tests.

### Changed

- Kept URL entry usable beside its submit control, moved draft generation
  below the clinical-material field, and matched the Tauri app icon to the
  workspace E mark.

### Fixed

- Spaced the active-template picker away from configuration and allowed the
  template editor to clone reactive Svelte state safely.

[Unreleased]: https://github.com/pascaljerney/epikrise/compare/HEAD
