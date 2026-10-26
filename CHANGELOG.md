# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [CalVer](https://calver.org) in `YYYY.MM.PATCH` format.

## [Unreleased]

### Added

- RTF ingestion now decodes declared Windows code pages and Unicode surrogate
  pairs, including emoji.
- Native desktop Settings and Help menus on macOS, Windows, and Linux open the
  existing localized dialogs and retain the in-app buttons as a fallback.
- Native menu titles and standard action labels now follow the selected English,
  de-CH, or pseudo locale.
- Additional predefined macOS menu actions use the selected locale when present,
  without assuming system-managed menu items have fixed positions.
- The macOS app bundle now advertises English and Swiss German localizations,
  allowing AppKit-generated menu items to follow the macOS language.
- Gemini profiles now use the Gemini Interactions API through `genai` 0.7.1,
  retaining existing provider credentials, request settings, streaming, and
  cancellation behavior.
- Native Windows x64 and ARM64 desktop builds now produce separate unsigned
  MSIX artifacts for manual Partner Center submission, with the reserved Store
  identity, validated architecture-specific OCR payloads, and bounded
  CalVer-derived package versions. NSIS remains the local installer; Store
  signing and updates remain managed by Microsoft.
- Successful tagged signed releases now trigger a separate Windows-only Store
  build that attaches x64 and ARM64 unsigned MSIX packages and SHA-256/build
  provenance manifests to the matching GitHub Release, without running the
  six-target diagnostic workflow.
- Native-host Tauri builds verify the bundled app executable and OCR dependencies
  across Linux, macOS, and Windows. Windows x64/ARM64 desktop and signed-release
  workflows compile on matching native runners, and native Windows setup
  requirements are documented. Generic Windows `pnpm tauri build` and
  `pnpm tauri dev` commands initialize MSVC from regular shells. Linux
  native-host checks reject architecture mismatches under QEMU user-mode
  emulation, cross-target Cargo configuration (including forwarded `--config`
  overrides), and custom Tauri runners in native build/dev commands. Clustered
  short target options are validated and reflected in build-output verification.
  Local PowerShell setup and troubleshooting are documented. All six native
  Desktop jobs passed in
  [Actions run 40110573454](https://github.com/jerney-nexus/epikrise/actions/runs/40110573454)
  for commit `66a76e720ea32308d6721580a5b37b2af4a9a1aa`; `pnpm build:all`
  verified the downloaded manifests and hashes, including both Windows
  package families. User-reported install, launch, and uninstall checks cover
  Windows ARM64 and macOS Apple Silicon; remaining native runtime and Store
  certification gates are documented in README and CONTRIBUTING. Live testing
  on the other platform targets is deferred.
- `pnpm build:all` now downloads and verifies Windows NSIS and Store MSIX as
  separate package families. Artifact manifests bind each package to its
  request, commit, version, native runner, Rust target, and SHA-256.
- Localized in-app help for the workflow, settings, case-data handling, and
  privacy boundaries.
- Linux setup documentation now explains the Secret Service keyring requirement
  and how to install GNOME Keyring and Seahorse on Debian or Ubuntu.
- Templates can format ISO `YYYY-MM-DD` values with the MiniJinja expression
  `{{ case.visit_date | format_date }}`; German locales use `DD.MM.YYYY`,
  English locales use `Month D, YYYY`, other locales retain ISO output, and
  unformatted dates retain their original value.
- Template prompts can reference declared values as `case.<variable_name>` while
  retaining flat placeholders and strict missing-value errors.
- Prompt conversion rejects template names that are blank after trimming.
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
- Human-only Linux x64 and ARM64 cross-compilation for separate unsigned
  diagnostic Windows x64 and ARM64 NSIS installers, with explicit opt-in,
  interactive SDK/CRT license acceptance, host-matched LLVM-MinGW, isolated
  OCR caches, static bundled OCR, and offline WebView2 installation. CI,
  release, MSI, MSIX, and non-NSIS requests are rejected.
- Added a manual six-target GitHub Actions desktop build workflow and
  `pnpm build:all` dispatch/download command with exact-commit and artifact
  manifest/hash verification. Windows builds use native Windows runners;
  packages remain unsigned and unpublished.
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

### Fixed

- Linux OCR builds and runtime checks now parse `ldd` output consistently,
  regardless of the developer's locale.
- Updated vulnerable frontend dependencies to patched releases, including
  DOMPurify, markdown-it, Vite, happy-dom, undici, and Vitest; standardized
  the project, container, and CI on pnpm 12.15.0.
- Updated `tauri-plugin-updater` to 2.14.1, removing its vulnerable Windows
  `zip 4.6.1` dependency in favor of the patched `zip 9` line.
- Windows image OCR now opens the image and tessdata paths correctly in native
  and Linux cross-built apps. Invalid OCR output can also use vision fallback
  when enabled.
- Linux desktop launches now resolve the active D-Bus session before listing
  keyring credentials, including when session-bus socket paths contain escaped
  characters. Credential-list failures provide keyring and session-bus
  troubleshooting guidance.
- Windows ARM64 now lists stored provider credentials correctly, enabling
  connection checks, model-list refresh, and report drafting. These flows were
  validated in a native Windows ARM64 app run.

[Unreleased]: https://github.com/jerney-nexus/epikrise/compare/HEAD
