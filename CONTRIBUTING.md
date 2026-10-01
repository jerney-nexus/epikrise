# Contributing

Thanks for your interest. This document covers the development setup, the
project layout and the rules that keep the codebase safe for clinical use.

## Ground rules

Epikrise handles clinical text. Two constraints override normal convenience:

1. **Clinical content must never be persisted or logged.** Temporary OCR image
   files may be written only to private temporary directories; overwrite them
   before removal and clean up abandoned directories on the next launch. Never
   include clinical content in debug output or error messages.
2. **No panicking code paths.** `unwrap`, `expect`, `panic!` and friends are
   denied by clippy outside of tests. Return a typed error instead.

Both rules are enforced mechanically; see [Quality gates](#quality-gates).

## Development setup

### Dev container (recommended)

Open the repository in VS Code and choose **Reopen in Container**. The image
ships Rust, Node, the Tauri Linux dependencies and a lightweight desktop
accessible through noVNC on port `6080`, so the app window can be viewed from
a browser.

### Local setup

Install the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
for your platform, plus Rust 1.98+ and Node 22+. macOS builds also require
Homebrew Tesseract and German language data:

```sh
brew install tesseract tesseract-lang
```

`pnpm tauri` prepares the ignored, target-specific OCR files before
invoking the Tauri CLI. It downloads the matching PDFium library from the
upstream release and verifies its SHA-256 digest. Tesseract itself and its
language data are taken from the host installation.

Then:

```sh
corepack enable pnpm
pnpm install
pnpm tauri dev
```

On macOS, `cargo` must be on `PATH` in the terminal that runs pnpm. With
Homebrew's keg-only `rustup`, add both the rustup executable and its Cargo
shims. For Apple Silicon, run:

```sh
export PATH="$HOME/.cargo/bin:/opt/homebrew/opt/rustup/bin:$PATH"
```

For Intel Macs, use `/usr/local/opt/rustup/bin` instead of
`/opt/homebrew/opt/rustup/bin`. Put the matching line in `~/.zprofile` to keep
it for new Terminal sessions. Verify the shell can find Cargo before building:

```sh
command -v cargo
cargo --version
```

If `command -v cargo` prints nothing, install Rust with [rustup](https://rustup.rs/)
and open a new terminal. Then retry `pnpm tauri build`.

### Building Windows installers

Windows cross-compilation is configured for the ARM64 Linux dev container. Its
setup installs LLVM, CMake, Ninja, NSIS and `cargo-xwin`; OCR sidecars and their
static dependencies are compiled separately for x64 and ARM64. Provisioning
also installs Tauri's required NSIS Restart Manager include. The pinned Windows
PDFium and language resources are staged per target. If setup reports that the
include is missing, rebuild the dev container to apply the updated provisioning.

Run setup interactively once. It displays the Microsoft SDK/CRT license link
and downloads the pinned Windows SDK package `10.0.26100` and Visual C++
toolset component `14.44.17.14` only
after you type `ACCEPT`:

```sh
pnpm windows:setup
```

Then run an architecture-specific build or build both installers
sequentially:

```sh
pnpm windows:build:x64
pnpm windows:build:arm64
pnpm windows:build
```

Installers are written to
`src-tauri/target/<target>/release/bundle/nsis/`. Each includes the offline
WebView2 installer, adding about 127 MB. The first build downloads and verifies
LLVM-MinGW, Tesseract, its dependencies, and PDFium; subsequent builds use
target-specific caches. Tesseract's CMake TIFF capability probe is given an
explicit cross-build result, so no Windows executable is run in Linux. TIFF
input is not needed by the app's OCR path, which passes PNG images to Tesseract.

A successful cross-build does not replace runtime acceptance testing. Test
installation without WebView2, launch, OCR with German and English synthetic
images, clipboard and credentials, and uninstall on native Windows x64 and
ARM64 systems.

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

The three library crates deliberately have no Tauri dependency. Business logic
belongs there, not in `src-tauri/src/`, so it can be unit-tested without
spinning up a webview.

## Quality gates

Run before opening a pull request:

```sh
pnpm format:rust:fmt
pnpm check
pnpm test
pnpm build
```

The dev container installs the required Rust tools during setup. For a local
setup, install them once:

```sh
rustup component add clippy rustfmt llvm-tools-preview
cargo install cargo-deny --locked
cargo install cargo-nextest --locked
cargo install cargo-llvm-cov --locked
```

`cargo-deny` is required by `pnpm check`; `cargo-nextest` is required by
`pnpm test:rust`, and `cargo-llvm-cov` plus `llvm-tools-preview` are required
for Rust coverage.

Lint levels live in `[workspace.lints]` in src-tauri/Cargo.toml. Tests are
exempted from the panic and printing rules via `src-tauri/clippy.toml`.

## Commits and changelog

Use Conventional Commit subjects (`feat: add template importer`, `fix: handle
formatted output`) and keep each commit focused on one change. User-visible
changes get an entry under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md).

To prepare a release, run the **Release preparation** workflow from the GitHub
Actions tab. Enter a `YYYY.MM.PATCH` version or leave it blank to select the
next CalVer version. The workflow updates npm, Cargo, and Tauri metadata,
generates release notes, and opens a pull request for review.

## Localization

User-facing strings live in Fluent catalogs under `locales/`. Rust code returns
translation keys and arguments, never localized text — the frontend resolves
them. Adding a language means adding a folder; do not hardcode strings in
command return paths.

## Templates and test data

Never commit real or realistic clinical material, not even as a test fixture.
The `templates/` and `fixtures/clinical/` directories are git-ignored for this
reason. Fixtures used by tests must be synthetic.

## Reporting security issues

Do not open a public issue for a vulnerability, in particular anything that
could cause clinical content to leak. Contact the maintainer directly.
