# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

[Unreleased]: https://github.com/pascaljerney/epikrise/compare/HEAD
