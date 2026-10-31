# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [CalVer](https://calver.org) in `YYYY.M.MICRO` format.

## [Unreleased]

## [2026.10.4] - 2026-10-31

### Added

- Added `pnpm release:prepare:workflow [version]` and a matching VS Code task to
  start the Release preparation workflow on `main` with the GitHub CLI, without
  using the GitHub web UI.

### Fixed

- Local release preparation now checks for the `git-cliff` version pinned by
  the release workflow (2.10.1) before changing any file, and reports how to
  install it instead of failing with a raw `spawn git-cliff ENOENT`.
- Release preparation no longer re-serializes `src-tauri/Cargo.lock`. Only the
  `version` lines of workspace packages change, so tagging no longer leaves the
  worktree dirty from formatting-only lockfile rewrites.

### 🚀 Features

- Add release preparation workflow shortcut (#168)

### 🐛 Bug Fixes

- _(release)_ Sign Windows updater artifacts in release builds (#165)
- Check pinned git-cliff before release preparation (#167)
- Keep Cargo.lock formatting during release preparation (#169)

## [2026.10.3] - 2026-10-31

### Added

- Added guarded `pnpm` and VS Code tasks for release preflight and explicitly
  confirmed annotated-tag creation and push; revalidate the release context
  afterward, enforce bounded release versions, refresh `origin/main`, and push
  only the confirmed tag. Recheck local and remote tag availability immediately
  before creating the tag. The VS Code tag task now describes its current-version
  default correctly, and integration tests verify tag creation and pushing
  against a disposable Git remote. The final `origin/main` refresh no longer
  imports concurrent remote tags into the local checkout.

### Changed

- Release preparation now formats generated release metadata and uses a GitHub
  release link for the first release instead of comparing against a missing tag.
  Its formatting test now checks against the repository's Prettier configuration.

### Fixed

- Windows release workflows now prepare source workspaces through Git worktrees
  instead of platform-dependent tar extraction, with a native x64/ARM64 smoke
  check available before a tagged release. Added regression tests for commit
  validation, workspace guards, Git marker removal, and failure cleanup.

- macOS signed releases now request Tauri's updater-enabled app bundle alongside
  the disk image, and a native smoke workflow verifies updater archive creation
  when its native target guard scripts change.

## [2026.10.2] - 2026-10-30

### Fixed

- Fixed Windows release workflows failing to extract source archives from
  Windows drive paths.
- Fixed signed Linux AppImage and macOS updater builds to generate required
  signatures, and prevented macOS Bash 3.2 staging from failing on an empty
  argument array.

## [2026.10.1] - 2026-10-30

### Added

- Documented the unresolved Catalina/macOS Intel compatibility limitation and
  deferred macOS x64 runtime testing as non-blocking for ongoing development.
- RTF ingestion now decodes declared Windows code pages and Unicode surrogate
  pairs, including emoji.
- Native desktop Settings and Help menus on macOS, Windows, and Linux open the
  existing localized dialogs and retain the in-app buttons as a fallback.
  Linux places Settings between Window and Help and enables the standard
  Minimize, Maximize, and Close Window actions.
  On Windows, Settings appears between Window and Help.
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
  Windows ARM64 and macOS Apple Silicon. Current platform acceptance and Store
  certification evidence is tracked in related issues and PRs; reusable native
  runtime validation steps are documented in CONTRIBUTING.
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
  its updater public key. Release-asset verification and native two-version
  update/tamper acceptance are documented in CONTRIBUTING; current evidence is
  tracked in related issues and PRs.
- Added a padded-CalVer-tag release workflow for signed Linux AppImage, macOS,
  and Windows x64/ARM64 NSIS updater bundles, signatures, generated
  `latest.json`, and GitHub release publication. Linux deb/rpm packages are
  built without updater support, and signing jobs use the protected `release`
  environment. The workflow stages and verifies a draft before a protected
  publication approval; package and runtime acceptance can be completed against
  the draft. Publication verifies updater signatures and uploaded bytes,
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

- Removed the source file picker's file-type filter so Linux native choosers do
  not hide supported document files; unsupported selections remain rejected by
  the importer.
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
- Administrator-managed provider restrictions now select the first allowed
  provider on startup, and changing providers selects the first model allowed
  for the selected provider.

### 🚀 Features

- Initialize Tauri project with SvelteKit integration
- Add GitHub CLI feature to devcontainer configuration
- Add devcontainer configuration, Prettier setup, and Vitest testing framework
- Integrate Specta for TypeScript bindings and add greet command
- Add specta integration and create_case_session command with TypeScript bindings
- Update devcontainer configuration to enable GitHub Copilot and add config mounts
- Integrate specta and uuid for input extraction and add extract_raw_text command
- Add extract_text_file command and enhance error handling in ingest pipeline
- Add PDF extraction capabilities and enhance error handling in ingest pipeline
- Add DOCX extraction support and enhance error handling in ingest pipeline
- Add XLSX extraction support and enhance error handling in ingest pipeline
- Add HTML and RTF extraction support with enhanced error handling in ingest pipeline
- Add GitHub Copilot CLI feature to devcontainer configuration
- Enhance PDF extraction with OCR requirement handling and update IngestError type
- Add ripgrep feature to devcontainer configuration
- Add src-tauri/resources/ocr/ to .gitignore
- Implement OCR support for PDF extraction and enhance error handling
- Add src-tauri/src-tauri/resources/ocr/ to .gitignore
- Implement LLM generation commands and events, update UI for draft workspace
- Add ripgrep feature to devcontainer configuration
- Add ClinicalTemplate validation and integrate with Tauri commands
- Integrate template management and rendering functionality
- Implement template section rendering and validation, enhance user interface for template management
- Enhance case session management and output review features
- Add model listing functionality and UI integration
- Enhance OCR setup with Tesseract installation instructions and PDFium asset preparation
- Improve error handling by refactoring HTTP error mapping and adding webc error handling
- Refactor model adapter selection and add support for OpenAI responses API
- Enhance error handling for provider rejections with detailed status messages
- Add TODO for Gemini Interactions API support upon genai v0.7.0 release
- Add template values and generation state to CaseSession and update related components
- Add rules to forbid bullet characters and parenthesized dates in output linter
- Add date formatting feature via template strings/localization to TODO
- Add reasoning effort configuration and output token limit to generation parameters
- Add project guidance documentation to AGENTS.md
- Add image extraction and URL handling capabilities
- Update Node.js feature to version 2 and add Prettier feature with integrity
- Enhance project guidance and add Rust check commands in package.json
- Enhance PDF vision processing and credential management
- Enhance model request handling for Groq adapter and add unit test
- Add eslint-config-prettier and update bindings for consistent formatting
- Add support for OpenRouter provider and refactor test for model endpoint resolution
- Migrate template storage from JSON to TOML format
- Enhance formatting scripts for specific file checks and formatting
- Implement clipboard prevention for unreviewed output copying
- Add Rust formatting script to package.json
- Complete Phase 6 clinical drafting workspace
- Add keyring-search and async-fs dependencies, enhance credential management, and update UI styles
- Enhance provider credential management with dialogs and state handling
- Add confirmation dialog for provider credential removal with state management
- Add styles for credential action buttons in the template editor
- Add margin to empty template in provider rail for improved spacing
- Update icons and add epikrise-mark.svg for improved branding and UI consistency
- Fix spacing for active-template picker and ensure safe cloning of reactive Svelte state
- Restructure AGENTS.md for clarity and improved project guidance
- Enhance template editor with section management features
- Add output rules management to template editor
- Add responsive layout and styling for template discard action in editor
- Add internationalization test script to package.json and AGENTS.md
- Add general settings dialog and localization options in Svelte component
- Add vitest explorer extension to devcontainer configuration
- Implement Windows cross-compilation setup with NSIS installers and OCR support
- Add NSIS Restart Manager include provisioning and update setup instructions
- Add clang-xwin script for improved Clang integration and error handling
- Update TODO with tasks for institutional template and MiniJinja integration
- Update VSCode settings and extensions for improved formatting support
- Add ESLint configuration and validation settings to VSCode
- Add .editorconfig for consistent coding style and formatting
- Update README and localization tests for improved clarity and structure
- Enhance AGENTS.md and package.json with detailed testing and command instructions
- Implement egress policy management and provider authorization
- Add VSCode tasks for development, testing, and linting
- Add Rust and pnpm audit tasks to improve dependency security checks
- Enhance Rust and pnpm audit tasks for improved security checks and clarity
- Update TODO.md to include handling of formatted text in UI
- Add margin to button for improved spacing in UI
- Implement administrator policy restrictions for template actions and model usage
- Implement administrator policy controls for credential management and fixed endpoints
- Update and reorganize TODO.md to categorize bugs and enhancements by urgency
- Update TODO.md to remove high urgency bugs and improve error handling for policy loading
- Add UI coverage testing command and update documentation for coverage reports
- Update TODO.md to refine changelog entry and add cookie version override in pnpm files
- Enhance error handling for generation configuration and update localization strings
- Implement CalVer versioning and automate release preparation with changelog generation
- Update project identifiers and enhance release preparation scripts
- Add Rust formatting task and update contributing guidelines
- Enhance template editing and importing based on policy status
- Add host-triple-specific directory for Rust artifacts and update build scripts
- Update rust-analyzer test command to include host target script
- Update pnpm version and enhance post-create command for Vite integration
- Add Rust code coverage implementation to high urgency tasks in TODO
- Implement Rust code coverage with cargo-llvm-cov and update identifiers to jerney-nexus
- Add llvm-tools-preview to Rust components and install cargo-llvm-cov
- Add cargo-deny installation to dependencies
- Update CONTRIBUTING.md and README.md with Rust tool installation instructions
- Add installation instructions for macOS and Linux in README.md
- Add support for native Windows build to TODO.md
- Add .gitignore entry for root-level plan prompts
- Update TODO.md to include Linux x64 host build support
- Add GitHub Copilot and Claude code instructions for testing
- Enhance accessibility tests for general settings dialog and update checks
- Enhance template settings dialog behavior and add related test
- Implement template export functionality with native save dialog and related tests
- Update template export/import button labels for clarity and consistency
- Reorder template settings controls to place import before export and add related tests
- Enhance template section handling and styling in settings dialog
- Update Playwright config to include type definitions and process import
- Add Dev Container section with environment details and usage instructions
- Add files.watcherExclude setting to ignore target directory
- Add high urgency bug fix for viewport layout issues on medium-sized windows
- Enhance Playwright setup with CI configuration and cache exclusions
- Update devcontainer configuration with additional features and dependencies
- Enhance Playwright setup with cross-browser support and reporting features
- Update template settings layout for better visibility on medium screens
- Refactor Playwright reporter configuration and improve accessibility tests with reduced motion setting
- Improve template settings layout for better responsiveness and alignment
- Enhance responsiveness of settings dialogs and template editor across various viewport widths
- Update testing instructions and scripts to include Playwright tests in the full test suite
- Add skills for full suite execution and issue investigation
- Add investigation note for Playwright Test Explorer E2E run cleanup
- Implement signed release workflow and validation for updater artifacts
- Add changelog update skill for documenting recent changes
- Update changelog with new release workflow and public key configuration
- Split template creation and deletion policies
- Add issue-worker and parallel-investigate workflows for focused bug resolution
- Enhance signed release workflow with environment and bundle configurations
- Add approved_redirect_chain function for secure URL redirection validation
- Update portable package implementation details and verification process
- _(release)_ Verify signed artifact integrity
- Add native host builds for Tauri and OCR (#97)
- Enable manual Linux NSIS cross-builds (#111)
- Add safe image OCR diagnostics (#113)
- Standardize unpadded CalVer (#130)
- Add task issue template (#133)

### 🐛 Bug Fixes

- Correct argument usage in Pdfium library binding
- Enable debug assertions for TypeScript generation
- Set temperature to null in generation configuration for improved model behavior
- Correct JSON formatting in settings and ensure newline at end of TODO.md
- Update commands from npm to pnpm in scripts and configuration
- Downgrade windows-sys version to 0.60.2 and update tauri-plugin-opener to 2.6.0, remove CI flag (probably not necessary)
- Update max_tokens in provider profile to improve output budget handling
- Ensure consistent formatting in AGENTS.md and TODO.md
- Correct spelling and formatting in German localization strings
- Rename generationMessage to copyReviewMessage for clarity in clipboard operations
- Update pnpm version to 12.8.1 in package.json and pnpm-lock.yaml
- Refactor template editor layout to use flexbox and improve responsiveness
- Update SDK and CRT versions in setup scripts and add validation test
- Update dependency versions in Cargo.lock and refine advisory reasons in deny.toml
- Prevent template settings horizontal overflow
- Improve TODO.md entry organization for actionable issues in full suite and investigate skills
- Include identifier in release config overlay
- Update pubkey in release config for updater plugin
- Honor updater key from release config
- Clarify blocker for native install and two-version update acceptance
- _(release)_ Enforce version and updater target contracts
- _(ci)_ Summarize cargo deny output
- _(ci)_ Use supported git-cliff version input
- _(devcontainer)_ Create optional bind sources
- _(devcontainer)_ Keep CLI runtime state writable
- _(devcontainer)_ Add protected SSH volume
- _(TODO)_ Mark blocked tasks for Playwright Test Explorer and portable package implementation
- _(release)_ Recover verified draft releases
- _(release)_ Keep latest promotion monotonic
- _(release)_ Verify uploaded draft assets
- _(release)_ Satisfy artifact validation types
- _(release)_ Enhance Windows setup script for noninteractive CI mode and retain interactive acceptance
- _(release)_ Fail closed on latest lookup errors
- _(updater)_ Require signed artifact version
- _(release)_ Send make_latest as string
- _(ci)_ Install NSIS package for desktop builds
- _(security)_ Strip remote images from clipboard HTML
- _(vscode)_ Use correct Rust format task script
- _(release)_ Accept already-normalized versions
- _(output)_ Annotate standalone code block lines
- _(release)_ Update source Cargo lock versions
- _(release)_ Generate notes from unreleased commits
- _(updater)_ Align Windows NSIS manifest targets
- _(ci)_ Remove invalid makensis package
- Use supported gh workflow listing
- _(deps)_ Resolve source-map-js audit finding
- Make release lock test cache-independent (#50)
- _(template)_ Reject blank template names (#63)
- Resolve Linux credential listing in desktop sessions (#110)
- Update provider order and add tests for restricted policies (#137)
- Allow document selection in Linux file picker (#140)

### 💼 Other

- Add workflow for version bumping and changelog generation
- _(devcontainer)_ Isolate GitHub CLI auth

### 🚜 Refactor

- Streamline output token limit validation and enhance error messaging
- Reorganize TODO entries for clarity and prioritize high urgency tasks

### 📚 Documentation

- Update local setup instructions for macOS regarding Cargo and Rust
- Update changelog and contributing guidelines for clarity and detail
- Close updater key backup follow-up
- Finalize initial changelog categories
- Remove resolved Rustup warning TODO
- Add security section for SSH key volume mounting in TODO
- Update release integrity changelog
- Clarify native acceptance blockers
- _(todo)_ Track signed release NSIS dependency issue
- _(todo)_ Track blocked items as issues
- _(todo)_ Keep PR scope focused
- _(workflows)_ Improve GitHub issue tracking
- _(skills)_ Update allowed-tools and clarify issue handling in agent skills
- _(skills)_ Address review feedback
- _(skills)_ Safeguard GitHub issue reports
- _(skills)_ Keep full-suite issues open until delivery
- Remove completed TODO ledger
- Add private vulnerability reporting policy (#64)
- Correct Windows installer output paths (#65)
- Add macOS OCR build prerequisites (#66)
- Update changelog and contributing guidelines for macOS Intel compatibility (#136)
- Streamline build and release guidance (#141)
- Refine Copilot instructions and contributing guidelines for tool discovery and session management (#143)

### 🧪 Testing

- Cover updater service races and failures
- Align artifact action version assertion
- Guard updater feature isolation
- Allow cold release compile to finish
- Use synthetic template fixtures
- Avoid duplicate i18n suite
- Include i18n in coverage
- Exercise updater feature paths

### ⚙️ Miscellaneous Tasks

- Implement cross-platform desktop builds and native OCR support
- Update action versions in workflow files to v7 and v6
- Separate UI, browser, and Rust tests
- Containerize UI and i18n tests
- Avoid duplicate cargo deny check
- Recommend GitHub Actions extension
- Containerize security audit workflow
- Add cargo-audit installation to dependencies
- Allow skill workflow tools
- Add Rust audit commands to development setup
- Gate signed releases on exact-commit checks
- Extract release quality checks
- Align reusable workflow triggers
- Rename Playwright workflow
- Install Rust tools in test workflows
- Fetch Rust dependencies before UI tests
- Stage native app dependencies in test jobs
- Create sidecar directory in test jobs
- Add placeholder OCR resources for checks
- Keep pnpm store on workspace mount
- Pin Playwright runner to Ubuntu 24.04
- Speed up rust cache compression
- Migrate to pnpm setup action
- Use pnpm setup v2
- Align rust job home with container user
- Silence git init default branch hint
- Scope rustup home override to setup
- Remove explicit HOME override from Rust toolchain setup
- Update actionlint feature version and integrity in devcontainer configuration
- Add actionlint workflow check
- Use rust image for UI workflow
- Update TODO with new VS Code issues and confirm Rustup home mismatch resolution
- Install dependencies in release prep workflow
- Run actionlint in quality checks
- Install actionlint from pinned release

[2026.10.1]: https://github.com/jerney-nexus/epikrise/releases/tag/v2026.10.1
[2026.10.2]: https://github.com/jerney-nexus/epikrise/compare/v2026.10.1...v2026.10.2
[2026.10.3]: https://github.com/jerney-nexus/epikrise/compare/v2026.10.2...v2026.10.3
[2026.10.4]: https://github.com/jerney-nexus/epikrise/compare/v2026.10.3...v2026.10.4
[Unreleased]: https://github.com/jerney-nexus/epikrise/compare/v2026.10.4...HEAD
