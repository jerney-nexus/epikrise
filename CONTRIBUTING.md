# Contributing

Thanks for your interest. This document covers the development setup, the project layout and the rules that keep the codebase safe for clinical use.

## Ground rules

Epikrise handles clinical text. Two constraints override normal convenience:

1. **Clinical content must never be persisted or logged.** Temporary OCR image files may be written only to private temporary directories; overwrite them before removal and clean up abandoned directories on the next launch. Never include clinical content in debug output or error messages.
2. **No panicking code paths.** `unwrap`, `expect`, `panic!` and friends are denied by clippy outside of tests. Return a typed error instead.

Both rules are enforced mechanically; see [Quality gates](#quality-gates).

## Development setup

### Dev container (recommended)

Open the repository in VS Code and choose **Reopen in Container**. The image ships Rust, Node, the Tauri Linux dependencies and a lightweight desktop accessible through noVNC on port `6080`, so the app window can be viewed from a browser.

### Local native setup

Follow the steps for your operating system, then run the common commands below. Builds are native-only: use a machine and Rust toolchain for the same operating system and architecture. For the full system requirements, see the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

All platforms need Rust 1.90+ and Node.js 22+. Install Rust with [rustup](https://rustup.rs/) and install Node.js for your operating system. Open a new terminal after installing them. Check that `rustc -vV` reports the host triple for this machine and that `node --version` reports v22.

#### Linux (Debian or Ubuntu)

Install Tauri, OCR, and native sidecar build dependencies:

```sh
sudo apt-get update
sudo apt-get install -y \
  build-essential cmake curl file libayatana-appindicator3-dev libssl-dev \
  libwebkit2gtk-4.1-dev librsvg2-dev libxdo-dev ninja-build pkg-config \
  tesseract-ocr tesseract-ocr-deu tesseract-ocr-eng tesseract-ocr-fra tesseract-ocr-ita tesseract-ocr-spa
```

For another Linux distribution, install the equivalent packages listed in the [Tauri Linux prerequisites](https://v2.tauri.app/start/prerequisites/#linux) and install Tesseract with German (`deu`), English (`eng`), French (`fra`), Italian (`ita`), and Spanish (`spa`) language data.

#### macOS

Install Xcode Command Line Tools if they are not already installed, then install the native OCR build tools and language data with Homebrew:

```sh
xcode-select --install
brew install cmake ninja tesseract tesseract-lang
```

#### Windows x64 or ARM64

Use the [native Windows setup](https://github.com/jerney-nexus/epikrise/wiki/Installers#windows-installers) guide. It covers Visual Studio's C++ tools, Git for Windows, OCR language data, and the architecture-specific build commands. Do not use WSL for a native Windows build.

#### Install dependencies and run

`pnpm tauri dev` first prepares local OCR and PDFium resources. The build uses the installed Tesseract command to find its language-data folder, and requires `deu.traineddata`, `eng.traineddata`, `fra.traineddata`, `ita.traineddata`, and `spa.traineddata`. It then builds the app's own Tesseract sidecar from pinned, checksum-verified sources. If the language data is in a custom folder, set `EPIKRISE_TESSDATA_DIR` to that folder before building.

From the repository root:

```sh
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm tauri dev
```

On Linux and macOS, verify that `tesseract --list-langs` lists `deu`, `eng`, `fra`, `ita`, and `spa`. If it does not, install the missing language data or set `EPIKRISE_TESSDATA_DIR` to a folder containing all five `.traineddata` files. Keep that environment variable set in the same terminal where you run pnpm.

### Windows native development, installers, and Store packages

Windows native builds, diagnostic installers, the Linux ARM64 cross-build, the cross-platform Actions builds, and the Store `.msixbundle` steps are documented in the wiki:

- [Windows native build](https://github.com/jerney-nexus/epikrise/wiki/Installers#windows-installers)
- [Cross-platform builds](https://github.com/jerney-nexus/epikrise/wiki/Cross-Platform-Builds)
- [Installers](https://github.com/jerney-nexus/epikrise/wiki/Installers)

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

Run before opening a pull request:

```sh
pnpm format:rust:fmt
pnpm check
pnpm test
pnpm build
pnpm lint:actions
pnpm lint:shell
pnpm audit:rust
pnpm audit:pnpm
```

Tool installation, the individual suites, coverage, and CI details are in the [Testing wiki page](https://github.com/jerney-nexus/epikrise/wiki/Testing).

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
