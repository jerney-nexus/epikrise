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

Choose the build path that matches where you are working:

- **Native Windows build:** builds only for the current Windows host
  architecture. Use this to verify a Windows build without the Dev Container.
- **Manual Linux cross-build:** builds diagnostic Windows x64 and ARM64 NSIS
  installers from a native x64 or ARM64 Linux Dev Container. This is not a
  native Windows build and is not available in CI or under CPU emulation.

#### Native build from Windows

Use this path on Windows x64 to build x64, or on Windows ARM64 to build ARM64.
The native wrapper deliberately rejects a target that does not match the host;
cross-building from Windows is not supported by this command.

Install these prerequisites before building:

- Node.js 22 and Corepack. The repository pins pnpm `12.10.1`.
- Rust for the Windows host architecture with the MSVC toolchain. On ARM64,
  `rustc -vV` must report `host: aarch64-pc-windows-msvc`; on x64 it must
  report `host: x86_64-pc-windows-msvc`.
- Windows ARM64 builds also need `clang.exe` for the locked `ring` dependency.
  In Visual Studio Installer, select **C++ Clang tools for Windows** under
  **Desktop development with C++**. The build wrapper searches Visual Studio's
  LLVM tools and adds the compiler to `PATH`.
- Visual Studio or Visual Studio Build Tools. In Visual Studio Installer,
  select **Desktop development with C++**, the Windows SDK, and the MSVC C++
  compiler, headers, and libraries for the host architecture. On ARM64, make
  sure the native ARM64 C++ tools are selected; x64-emulated tools are not
  sufficient. The Visual Studio Installer's `vswhere.exe` and
  `VC\Auxiliary\Build\vcvarsall.bat` must be present. See the
  [Tauri Windows prerequisites](https://v2.tauri.app/start/prerequisites/#windows)
  and [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/).
- Git for Windows, which provides Git Bash. The wrapper locates and verifies
  Git Bash itself, then starts it after initializing Visual Studio; you do not
  need to open a Git Bash window or add Bash to `PATH` for a standard
  installation. If Git for Windows is installed in a custom location and the
  wrapper cannot find it, add its `cmd` or `bin` folder to this PowerShell
  session's `PATH`. CMake, Ninja, `curl`, `tar`, and `grep` must also be
  available to the build shell. To install CMake with Visual Studio, open **Visual Studio
  Installer**, select
  **Modify** for the installed Visual Studio or Build Tools instance, ensure
  **Desktop development with C++** is selected, then open **Individual
  components** and select **C++ CMake tools for Windows**. If the build still
  reports CMake missing, install the standalone version from the WinGet
  community repository so `cmake.exe` is added to `PATH`. Ninja is also a
  separate tool:

  ```powershell
  winget show --id Kitware.CMake --exact --source winget
  winget install --id Kitware.CMake --exact --source winget
  winget show --id Ninja-build.Ninja --exact --source winget
  winget install --id Ninja-build.Ninja --exact --source winget
  ```

  After installation, open a new PowerShell window and confirm that
  `cmake --version` and `ninja --version` print versions. Visual Studio's
  bundled CMake may not be added to the regular PATH; the wrapper adds its
  standard bundled-tools directory to the build-shell PATH automatically. It
  then checks that both tools are available before building.

- Tesseract language data containing both `deu.traineddata` and
  `eng.traineddata`. You do not need an installed Tesseract executable if you
  set `EPIKRISE_TESSDATA_DIR` to that data directory.

Run the following in **PowerShell** from the repository root. A regular
PowerShell or Command Prompt is sufficient; the wrapper locates Visual Studio
and initializes its developer environment itself. Do not use WSL or run these
commands inside the Dev Container. Do not run `pnpm windows:setup` here; that
command provisions the separate Linux Dev Container cross-build.

```powershell
$pnpmShimDir = Join-Path $env:LOCALAPPDATA 'Epikrise\corepack'
New-Item -ItemType Directory -Path $pnpmShimDir -Force | Out-Null
corepack.cmd enable --install-directory $pnpmShimDir pnpm
$env:Path = "$pnpmShimDir;$env:Path"

node --version
pnpm.cmd --version
rustc -vV
pnpm.cmd install --frozen-lockfile
```

The user-local Corepack shim avoids writing under `C:\Program Files`. Use
`pnpm.cmd` in PowerShell to avoid a blocked `pnpm.ps1`; the wrapper inherits
this session's `PATH` and can find the same pnpm command.

The version commands should report Node 22 and pnpm 12.10.1; `rustc -vV`
must report the native host triple listed above.

Set `EPIKRISE_TESSDATA_DIR` to a folder containing both
`deu.traineddata` and `eng.traineddata`. If Tesseract is installed with both
languages, point it to that installation's `tessdata` folder. Otherwise,
download the project-pinned language files into a user-local folder and verify
their checksums:

```powershell
$tessdataDir = Join-Path $env:LOCALAPPDATA 'Epikrise\tessdata'
New-Item -ItemType Directory -Path $tessdataDir -Force | Out-Null
$tessdataCommit = '65727574dfcd264acbb0c3e07860e4e9e9b22185'
$expectedSha256 = @{
  deu = '19d219bbb6672c869d20a9636c6816a81eb9a71796cb93ebe0cb1530e2cdb22d'
  eng = '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2'
}
foreach ($language in @('deu', 'eng')) {
  $file = Join-Path $tessdataDir "$language.traineddata"
  $url = "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/$tessdataCommit/$language.traineddata"
  Invoke-WebRequest -Uri $url -OutFile $file
  $actualSha256 = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualSha256 -ne $expectedSha256[$language]) {
    throw "$language.traineddata SHA-256 mismatch."
  }
}
$env:EPIKRISE_TESSDATA_DIR = $tessdataDir
```

The data is stored under your local application data directory, not in the
repository. Keep using the same PowerShell session so the environment variable
and user-local pnpm shim remain available during the build.

For local OCR troubleshooting, set `$env:EPIKRISE_DEBUG_OCR_STDERR = '1'`
before launching the app to include Tesseract's raw stderr in image OCR errors.
It is off by default and is not persisted or logged. Stderr may contain
machine-local paths; use synthetic test images and sanitize it before sharing.

Run **one** build command, matching the Windows host.

On Windows ARM64:

```powershell
.\scripts\build-native-windows.cmd arm64 diagnostic
```

On Windows x64:

```powershell
.\scripts\build-native-windows.cmd x64 diagnostic
```

The wrapper locates Git Bash and checks that the Rust host, MSVC host, MSVC
target, and requested target architecture all match.

The generic `pnpm tauri build` and `pnpm tauri dev` commands also initialize
Visual Studio automatically when launched from a regular PowerShell, Command
Prompt, or Git Bash session. They select the current Windows architecture and
preserve the Tauri arguments; the explicit wrapper commands above remain the
recommended path for diagnostic native builds. Native-only Tauri `build` and
`dev` commands reject custom runners such as `cargo-xwin`; the default `cargo`
runner remains available. They also validate cross-target Cargo configuration
from Cargo config files, `CARGO_BUILD_TARGET`, and forwarded Cargo `--config`
overrides against the effective command target before OCR preparation.

The first build needs network access to download and checksum-verify the OCR
source archives and PDFium. The unsigned diagnostic installer is written under
`src-tauri/target/host-<host-triple>/<target>/release/bundle/`. The wrapper
returns a non-zero exit code if setup, compilation, bundling, or architecture
verification fails.
Diagnostic builds disable release LTO, use 16 codegen units, and compile at
optimization level 2 to reduce peak memory use. Signed release builds retain
the optimized release profile configured in `src-tauri/Cargo.toml`.

Build caches are kept between runs: Cargo artifacts live under
`src-tauri/target/host-<host-triple>/`, and the native OCR CMake/Ninja build
cache lives under `%USERPROFILE%\.cache\epikrise\windows-ocr-native-msvc\`.
Cargo reuses outputs that are still up to date; changes to Rust sources,
toolchain/profile settings, or build inputs may require affected crates to
compile again. The diagnostic profile has just changed to reduce memory, so
its first run rebuilds artifacts for the new profile. Avoid `cargo clean` or
deleting these cache directories unless you intentionally want a full rebuild.

If compilation reports that `vcruntime.h` cannot be found, the installed MSVC
toolset or its C++ headers are missing or inconsistent. Use Visual Studio
Installer to add or repair the C++ build tools and Windows SDK for the host
architecture, open a new PowerShell window, and rerun the native wrapper.

#### Manual cross-build from Linux x64 or ARM64

Use this path only from a native Linux x64 or ARM64 Dev Container. It requires
LLVM, CMake, Ninja, NSIS, `cargo-xwin`, and Tauri's NSIS Restart Manager
include. Do not use CPU emulation or CI/GitHub Actions. Run setup in an
interactive terminal; it displays the Microsoft SDK/CRT license link and
downloads the pinned Windows SDK package `10.0.26100` and Visual C++ toolset
component `14.44.17.14` only after you review the license and type `ACCEPT`:

```sh
pnpm windows:setup
```

Then explicitly opt in to the manual, unsigned diagnostic NSIS cross-build in
the current shell. Build one architecture or both:

```sh
export EPIKRISE_ALLOW_LINUX_WINDOWS_CROSS_BUILD=true
pnpm windows:build:x64
pnpm windows:build:arm64
pnpm windows:build
```

The build scripts reject CI, unsupported hosts, release mode, MSI/MSIX, and
other non-NSIS package selections before downloading assets or compiling.
Generic `pnpm tauri build` stays native; signed Windows release builds also
remain on their native Windows runner.

Installers are written to
`src-tauri/target/host-<host-triple>/<target>/release/bundle/nsis/`. Each
includes the offline WebView2 installer, adding about 127 MB. The first
cross-build downloads and verifies the host-matched LLVM-MinGW archive,
Tesseract, its dependencies, and PDFium after the setup license gate;
subsequent builds use isolated host/target caches. Tesseract's CMake TIFF
capability probe is given an explicit cross-build result, so no Windows
executable is run in Linux. TIFF input is not needed by the app's OCR path,
which passes PNG images to Tesseract.

Cross-build success does not replace runtime acceptance testing. Test
installation without WebView2, launch, OCR with German and English synthetic
images, clipboard and credentials, and uninstall on native Windows x64 and
ARM64 systems.

For uninstall testing, use **Settings > Apps > Installed apps > Epikrise >
Uninstall**. The NSIS setup executable's same-version maintenance page runs the
uninstaller and then continues into setup when its Uninstall option is chosen;
that upstream behavior is not a completed uninstall flow.

## Cross-platform Actions builds

The manual **Desktop builds** workflow produces six native/target-matched
packages: Linux x64 and ARM64 (`.deb`, `.rpm`, AppImage), macOS x64 and ARM64
(`.dmg`), and Windows x64 and ARM64 (NSIS `.exe` with offline WebView2). Linux
and macOS use native GitHub-hosted runners. Windows jobs run on Windows
GitHub-hosted runners and use the native Windows build wrapper above; they do
not use the Dev Container or `cargo-xwin`. OCR sidecars are built from pinned
source archives, and downloaded source/PDFium files are checksum-verified.
Native Linux OCR is statically linked; macOS OCR links its third-party
dependencies statically and checks that remaining dynamic libraries are
provided by macOS.

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

Windows jobs in this workflow use native Windows runners; the manual Linux
cross-build setup is not available in Actions and never accepts the SDK/CRT
license on a user's behalf.

Build artifacts are unsigned and macOS packages are not notarized. Expect
SmartScreen/Gatekeeper warnings or installation restrictions; do not distribute
them into a clinical environment as trusted installers. The workflow does not
publish releases or configure updates. Inspect package contents and test
PDFium, German/English synthetic OCR, credentials, clipboard and uninstall on
native Linux, macOS and Windows systems for every architecture. Cross-build
success alone does not prove runtime support.

Validation evidence as of 2026-10-18:

- All six native Desktop builds succeeded in
  [Actions run 39154332435](https://github.com/jerney-nexus/epikrise/actions/runs/39154332435)
  for commit `3016dfe78a67a8074ffc280f1a4664271e94d989`.
- Native install, launch, and uninstall were confirmed on Windows ARM64 and
  macOS Apple Silicon.
- Live installation and runtime testing on Windows x64, macOS Intel, and Linux
  x64/ARM64 is deferred. These lifecycle checks do not complete the separate
  PDFium, synthetic OCR, credentials, or clipboard acceptance checks.

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
