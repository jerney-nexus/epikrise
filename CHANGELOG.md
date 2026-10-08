# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [CalVer](https://calver.org) in `YYYY.MM.PATCH` format.

## [Unreleased]

### Added

- Documented how to remove download quarantine from trusted unsigned macOS builds
  when Gatekeeper blocks launch.
- Markdown-formatted output previews and sanitized rich clipboard output that
  excludes remote images to prevent data leakage when pasted, with plain-text
  preview and reviewed-output copy safeguards retained. Switched to CalVer and
  added a GitHub Actions workflow that prepares version and changelog updates
  for review.
- Machine-wide administrator egress policy, Rust-enforced local-only/provider
  restrictions, URL-ingestion control, and first-send confirmation for remote
  generation. Added redacted debug output for clinical payload types, a strict
  webview CSP, production devtools/context-menu hardening, dependency audit
  checks in CI, and administrator controls for template operations, model
  allowlists, output-token ceilings, reasoning effort, fixed provider endpoints,
  and credential-management controls. Policy restrictions provide clear
  feedback when they block a generation configuration, while an unset reasoning
  effort remains provider-defined.
- ARM64 Linux cross-compilation for separate Windows x64 and ARM64 NSIS
  installers, with static bundled OCR and offline WebView2 installation.
- Added a manual six-target GitHub Actions desktop build workflow and
  `pnpm build:all` dispatch/download command with exact-commit and artifact
  manifest/hash verification. Windows CI SDK downloads require explicit
  administrator license approval and skip interactive acceptance only in
  approved CI mode; packages remain unsigned and unpublished.
- Added default-off, policy-enforced direct-release updater plumbing with
  explicit checks and install confirmation, target/version/URL validation,
  approved HTTPS host checks for every redirect, progress reporting, and
  exclusion during active case work. The release configuration now supplies
  its updater public key; native installation and update acceptance remain
  outstanding.
- Added a padded-CalVer-tag release workflow for signed Linux AppImage, macOS,
  and Windows x64/ARM64 NSIS updater bundles, signatures, generated
  `latest.json`, and GitHub release publication. Linux deb/rpm packages are
  built without updater support, and signing jobs use the protected `release`
  environment. Publication verifies updater signatures and uploaded bytes,
  recovers only matching drafts, and prevents retries from promoting an older
  version as latest.
- Added synthetic Playwright and axe browser tests, `pnpm test:e2e` and
  `pnpm test:a11y` scripts, and a browser-test CI workflow.
- Fluent-based German (Switzerland) and English interface localization, OS
  language detection, a persisted language selector, and a development-only
  pseudo-localization preview.
- Responsive fit-to-window layout with viewport-adaptive settings and template
  dialogs, keychain-backed credential selection, and connection checks that
  populate available models.
- Three-pane clinical drafting workspace with responsive input and output panes,
  provider/template controls, connection settings dialog, and a live-preview
  template editor.
- Template editor controls for managing sections and editing output rules.
- Direct template creation and deletion from settings, each controlled by its
  own administrator policy.
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
- Rust workspace LCOV coverage via `cargo-llvm-cov` and Coverage Gutters, and
  updated Tauri and keyring identifiers for `jerney-nexus`.
- Kept URL entry usable beside its submit control, moved draft generation
  below the clinical-material field, and matched the Tauri app icon to the
  workspace E mark.
- Spaced the active-template picker away from configuration and allowed the
  template editor to clone reactive Svelte state safely.

[Unreleased]: https://github.com/jerney-nexus/epikrise/compare/HEAD
