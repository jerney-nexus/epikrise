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
brew install cmake ninja tesseract tesseract-lang
```

`pnpm tauri` prepares the ignored, target-specific OCR files before
invoking the Tauri CLI. It downloads the matching PDFium library from the
upstream release and verifies its SHA-256 digest. It builds a portable native
Tesseract sidecar from pinned, checksum-verified sources; German and English
language data are copied from the host installation.

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

Outside the Linux Dev Container, native build commands compile the application
and OCR for the host OS and architecture.

On a native Windows host, `pnpm tauri build` builds Epikrise and OCR for that
host's Windows architecture. Use a matching MSVC Rust toolchain, Visual Studio
C++ build tools, CMake, LLVM (`llvm-readobj`), and Tesseract with German and
English language data. Do not use the Linux cross-build setup on Windows.

A human can manually cross-compile the Windows application and OCR inside the
Linux ARM64 Dev Container. The local commands package those outputs as a
diagnostic NSIS installer; local cross-builds do not produce MSI or MSIX
packages and are never an Actions path. The container setup installs LLVM,
CMake, Ninja, NSIS, and `cargo-xwin`, and stages pinned Windows PDFium and
language resources per target. Review and accept the Microsoft SDK/CRT license
interactively before using this local option:

```sh
pnpm windows:setup
```

Then build the requested NSIS target:

```sh
pnpm windows:build:x64
pnpm windows:build:arm64
pnpm windows:build
```

Local cross-build NSIS installers are written to
`src-tauri/target/host-<host-triple>/<target>/release/bundle/nsis/` and include
the offline WebView2 installer. The first build downloads and verifies
LLVM-MinGW, Tesseract, its dependencies, and PDFium; subsequent builds use
target-specific caches. Tesseract's CMake TIFF capability probe is given an
explicit cross-build result, so no Windows executable is run in Linux. TIFF
input is not needed by the app's OCR path, which passes PNG images to Tesseract.

A successful cross-build does not replace runtime acceptance testing. Test
installation without WebView2, launch, OCR with German and English synthetic
images, clipboard and credentials, and uninstall on native Windows x64 and
ARM64 systems.

## Cross-platform Actions builds

The manual **Desktop builds** workflow produces six native/target-matched
packages: Linux x64 and ARM64 (`.deb`, `.rpm`, AppImage), macOS x64 and ARM64
(`.dmg`), and Windows x64 and ARM64 (NSIS `.exe` and MSIX). Windows Actions
jobs use native Windows runners and toolchains; Actions never cross-compile.
OCR sidecars are built from pinned source archives, and downloaded
source/PDFium files are checksum-verified. Native Linux OCR is statically
linked; macOS OCR links its third-party dependencies statically and checks
that remaining dynamic libraries are provided by macOS.

Run `pnpm build:all` only after the workflow is present and enabled on GitHub.
The worktree must be clean, and `HEAD` must be the exact commit pushed to the
current `origin` branch or tag. The command does not commit or push. `gh`
authentication must permit workflow dispatch and artifact download; the
container and Actions runners need network access. Six isolated jobs can run in
parallel. Completed outputs and their manifests are downloaded to
`.artifacts/desktop-builds/<request-id>/`, which is Git-ignored; the command
rejects missing jobs, wrong SHAs/versions/targets, incomplete packages, and
manifest or SHA-256 mismatches. GitHub retains the uploaded artifacts for 14
days.

The Actions workflows do not cross-compile Windows targets or download a
cross-build SDK/CRT. The diagnostic workflow is unsigned, read-only, and does not
publish a release. The signed release workflow builds Windows MSI and NSIS
variants on matching native Windows runners.

Build artifacts are unsigned and macOS packages are not notarized. Expect
SmartScreen/Gatekeeper warnings or installation restrictions; do not distribute
them into a clinical environment as trusted installers. The workflow does not
publish releases or configure updates. Inspect package contents and test
installation, launch, PDFium, German/English synthetic OCR, credentials,
clipboard and uninstall on native Linux, macOS and Windows systems for every
architecture. Cross-build success alone does not prove runtime support.

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
pnpm lint:actions
pnpm audit:rust
pnpm audit:pnpm
```

The dev container installs the required Rust tools during setup. For a local
setup, install them once:

```sh
rustup component add clippy rustfmt llvm-tools-preview
cargo install cargo-deny --locked
cargo install cargo-nextest --locked
cargo install cargo-llvm-cov --locked
cargo install cargo-audit --locked
```

`cargo-deny` is required by `pnpm check`; `cargo-nextest` is required by
`pnpm test:rust`; `cargo-audit` is required by `pnpm audit:rust`; and
`cargo-llvm-cov` plus `llvm-tools-preview` are required for Rust coverage.
`pnpm lint:actions` requires `actionlint`, which is installed in the dev
container. For local setup, follow the [actionlint installation
instructions](https://github.com/rhysd/actionlint#installation).

`pnpm test` includes the full Playwright browser suite in addition to UI, i18n,
and Rust tests.

### Browser tests

Run only the Playwright suite with `pnpm test:e2e`, or its focused
accessibility selection with `pnpm test:a11y`:

```sh
pnpm test:e2e
pnpm test:a11y
```

The tests use synthetic IPC, event, and clipboard fixtures and reject
unexpected external requests. Never add real or realistic clinical data to a
browser fixture. If Chromium is not installed locally, run
`pnpm exec playwright install chromium`. Browser mocks verify UI behavior, not
native Rust policy enforcement, updater signatures, or platform installation.

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

### Release and update readiness

Keep the padded `YYYY.MM.PATCH` release identity unchanged. If Cargo, Tauri, an
installer, or updater protocol requires another representation, derive it only
for that build or package input; do not migrate committed versions or release
tags. The six-target Desktop builds workflow remains an unsigned diagnostic
contract and does not publish releases.

The default Tauri configuration leaves updater support disabled. The separate
**Signed updater release** workflow runs when a padded `vYYYY.MM.PATCH` tag is
pushed: it builds target-specific signed bundles, stages the expected assets
and signatures, generates `latest.json`, and publishes a GitHub release. It
uses the public key configured in `src-tauri/tauri.release.conf.json` and
requires the matching `TAURI_SIGNING_PRIVATE_KEY` GitHub Actions secret (and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if the key is encrypted).

This workflow is implemented, but the updater is not yet accepted for
production use. The checked-in public key does not prove matching private-key
ownership or backup; an authorized key holder must verify a synthetic signature
locally before signing is accepted. Then verify the first release's six target
assets, signatures, manifest and URLs, and complete native installation and
two-version update acceptance on each supported target. Never generate or
replace a production key in CI, commit private signing material, or treat a
Tauri update signature as platform publisher signing. Store delivery is a
separate Microsoft-certified channel.

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

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
Do not open a public issue, especially for anything that could expose clinical
content.
