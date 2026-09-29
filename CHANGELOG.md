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
- OpenRouter, xAI and Groq provider profiles.
- URL ingestion with DNS-pinned requests, private/reserved address rejection,
  bounded redirects, response size limits, timeouts and article readability
  extraction.
- PNG/JPEG screenshot input with local OCR and an explicit, capability-gated
  vision fallback, scanned-PDF page vision fallback after OCR failure, plus
  file drop and clipboard-image workflows.
- Private, launch-scoped OCR temporary directories with stale-session cleanup
  on startup and per-file buffer overwriting on exit.
- Project-local ESLint support for Svelte and TypeScript, and Prettier support
  for Svelte files, plus a Cargo Nextest workflow for Rust tests.

[Unreleased]: https://github.com/pascaljerney/epikrise/compare/HEAD
