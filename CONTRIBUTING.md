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

The Dev Container uses a private Docker volume for VS Code Server data so
Agent Host session indexes and per-session data survive container rebuilds.
This volume is specific to the dev container and is not shared with the host's
VS Code data. It can contain prompts, tool output, attachments, extension
state, or credentials: do not put patient data, clinical text, or secrets in
agent chats, and protect the Docker host and its backups accordingly. A Docker
volume is not encryption or a backup.

The volume mount does not migrate data from an existing container. Before
adding the mount to a container with sessions to keep, export important chats
using VS Code's **Chat: Export Chat...** command, or stop VS Code Server and
back up and explicitly migrate the old data into the named volume. Do not copy
live session databases. Verify that sessions reopen after a rebuild before
removing any old copy.

### Local native setup

Follow the steps for your operating system, then run the common commands below.
Builds are native-only: use a machine and Rust toolchain for the same operating
system and architecture. For the full system requirements, see the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

All platforms need Rust 1.98+ and Node.js 22+. Install Rust with
[rustup](https://rustup.rs/) and install Node.js for your operating system.
Open a new terminal after installing them. Check that `rustc -vV` reports the
host triple for this machine and that `node --version` reports v22.

#### Linux (Debian or Ubuntu)

Install Tauri, OCR, and native sidecar build dependencies:

```sh
sudo apt-get update
sudo apt-get install -y \
  build-essential cmake curl file libayatana-appindicator3-dev libssl-dev \
  libwebkit2gtk-4.1-dev librsvg2-dev libxdo-dev ninja-build pkg-config \
  tesseract-ocr tesseract-ocr-deu tesseract-ocr-eng
```

For another Linux distribution, install the equivalent packages listed in the
[Tauri Linux prerequisites](https://v2.tauri.app/start/prerequisites/#linux)
and install Tesseract with German (`deu`) and English (`eng`) language data.

#### macOS

Install Xcode Command Line Tools if they are not already installed, then
install the native OCR build tools and language data with Homebrew:

```sh
xcode-select --install
brew install cmake ninja tesseract tesseract-lang
```

#### Windows x64 or ARM64

Use the [native Windows setup](#native-build-from-windows) below. It covers
Visual Studio's C++ tools, Git for Windows, OCR language data, and the
architecture-specific build commands. Do not use WSL for a native Windows
build.

#### Install dependencies and run

`pnpm tauri dev` first prepares local OCR and PDFium resources. The build uses
the installed Tesseract command to find its language-data folder, and requires
both `deu.traineddata` and `eng.traineddata`. It then builds the app's own
Tesseract sidecar from pinned, checksum-verified sources. If the language data
is in a custom folder, set `EPIKRISE_TESSDATA_DIR` to that folder before
building.

From the repository root:

```sh
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm tauri dev
```

On Linux and macOS, verify that `tesseract --list-langs` lists both `deu` and
`eng`. If it does not, install the missing language data or set
`EPIKRISE_TESSDATA_DIR` to a folder containing both `.traineddata` files.
Keep that environment variable set in the same terminal where you run pnpm.

### Windows native development and installers

Native Windows builds run on matching Windows x64 or ARM64 hosts. Windows
cross-builds are not supported here. The separate Linux ARM64 Dev Container
cross-build is for diagnostic NSIS installers only.

#### Native build from Windows

Use PowerShell on Windows x64 to build x64, or on Windows ARM64 to build
ARM64. The wrapper initializes Visual Studio for you. Do not use WSL or the
Dev Container for a native Windows build.

Install these prerequisites before building:

- Node.js 22 and Corepack. The repository pins pnpm `12.15.0`.
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
  session's `PATH`. CMake, Ninja, `cl`, `dumpbin`, `curl`, `tar`, and `rg` must
  also be available to the build shell. To install CMake with Visual Studio,
  open **Visual Studio Installer**, select **Modify** for the installed Visual
  Studio or Build Tools instance, ensure
  **Desktop development with C++** is selected, then open **Individual
  components** and select **C++ CMake tools for Windows**. If the build still
  reports CMake missing, install the standalone version from the WinGet
  community repository so `cmake.exe` is added to `PATH`. Ninja is also a
  separate tool. Visual Studio Installer can provide both **C++ CMake tools for
  Windows** and **Ninja: build system** under **Individual components**; if
  either is unavailable on `PATH`, use the WinGet commands below.

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
  then checks that CMake and Ninja are available before building.

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

The version commands should report Node 22 and pnpm 12.15.0; `rustc -vV`
must report the native host triple listed above. The wrapper locates and
verifies Git Bash for standard installations. For a custom installation, add
its `cmd` or `bin` folder to this PowerShell session's `PATH` and retry the
wrapper. Install Git for Windows if it is not installed.

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

To start the app for development, run:

```powershell
pnpm.cmd tauri dev
```

To build an unsigned diagnostic installer, run **one** command matching the
Windows host:

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

Native-only Tauri `build` and `dev` commands reject custom runners such as
`cargo-xwin`; the default `cargo` runner remains available. They also validate
cross-target Cargo configuration from Cargo config files, `CARGO_BUILD_TARGET`,
and forwarded Cargo `--config` overrides against the effective command target
before OCR preparation.

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

#### Manual Linux ARM64 cross-build

This path builds diagnostic Windows installers, not a native Windows app. Use
it only from the native Linux ARM64 Dev Container. It requires
LLVM, CMake, Ninja, NSIS, `cargo-xwin`, and Tauri's NSIS Restart Manager
include. Do not use CPU emulation. Run setup in an interactive terminal; it
installs `cargo-xwin` if needed before displaying the Microsoft SDK/CRT license
link. Review the license and type `ACCEPT` to allow downloading the pinned
Windows SDK package `10.0.26100` and Visual C++ toolset component `14.44.17.14`.
This acceptance gates the SDK/CRT download, not installation of `cargo-xwin`.
The interactive path is for local setup; GitHub Actions uses the separate
`--ci` path only when `EPIKRISE_WINDOWS_SDK_LICENSE_APPROVED=true`.

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

For runtime validation, use a native host for each target whose support you
intend to claim: install and launch the package, verify PDFium loading, run
synthetic German and English OCR, check credentials and clipboard, then
uninstall. A successful cross-build alone does not verify installation or
runtime behavior. The NSIS installer is configured for offline WebView2
installation in `src-tauri/tauri.windows.conf.json`; a separate install test
starting without WebView2 is not required. macOS Intel runtime support remains
explicitly unverified and deferred.

For uninstall testing, use **Settings > Apps > Installed apps > Epikrise >
Uninstall**. The NSIS setup executable's same-version maintenance page runs the
uninstaller and then continues into setup when its Uninstall option is chosen;
that upstream behavior is not a completed uninstall flow.

## Cross-platform Actions builds

The manual **Desktop builds** workflow produces six target-specific
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
manifest or SHA-256 mismatches. Windows NSIS and Store MSIX packages are
downloaded and verified separately; their manifests bind the request, commit,
version, runner architecture, and Rust target. GitHub retains the uploaded
artifacts for 14 days.

Windows jobs in this workflow use native Windows runners; the manual Linux
cross-build setup is not available in Actions and never accepts the SDK/CRT
license on a user's behalf.

Each native Windows job also uploads an unsigned, architecture-specific MSIX
artifact separately from its NSIS installer. These MSIX files are for manual
Partner Center submission only: they use the reserved Store identity, are
versioned as `year.month.patch.0`, and are not the local installation path.
After a successful tagged signed release, the Store submission workflow builds
only Windows x64 and ARM64 Store variants and attaches each package and its
SHA-256/provenance manifest as separate assets to the matching GitHub Release.
This is independent of the six-target Desktop builds workflow. When dispatching
Desktop builds directly, provide `previous_store_version` if a prior Store
submission exists so the build rejects a non-advancing version. Microsoft signs
submitted Store packages and manages Store updates; this project does not
upload packages to Partner Center or configure Store updates automatically.
The Store package does not include the WebView2 Evergreen Runtime, which must
be available on the Windows device. Continue using the NSIS `.exe` for local
installation; it includes the offline WebView2 installer and remains separate
from the Store package and Store update model.

Build artifacts are unsigned and macOS packages are not notarized. Expect
SmartScreen/Gatekeeper warnings or installation restrictions; do not distribute
them into a clinical environment as trusted installers. The workflow creates
diagnostic artifacts; it does not publish releases or configure updates.

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
Actions tab. Enter a `YYYY.M.MICRO` version or leave it blank to select the
next CalVer version. The workflow updates npm, Cargo, and Tauri metadata,
generates release notes, and opens a pull request for review.

### Release and update workflow

Release identities use unpadded `YYYY.M.MICRO`. If Cargo, Tauri, an installer,
or updater protocol requires another representation, derive it only for that
build or package input. Existing published versions and tags remain immutable.
The six-target Desktop builds workflow remains an unsigned diagnostic contract
and does not publish releases.

The default Tauri configuration leaves updater support disabled. The separate
**Signed updater release** workflow runs when a `vYYYY.M.MICRO` tag is
pushed: it builds target-specific signed bundles, stages the expected assets
and signatures, generates `latest.json`, and publishes a GitHub release. It
uses the public key configured in `src-tauri/tauri.release.conf.json` and
requires the matching `TAURI_SIGNING_PRIVATE_KEY` GitHub Actions secret (and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if the key is encrypted).

Keep signing keys in the approved GitHub Actions secrets; never commit private
signing material or generate or replace a production key in CI. A Tauri updater
signature verifies the update payload and does not replace platform publisher
signing. Store delivery uses a separate Microsoft certification process.

The tag workflow creates and verifies a draft release before publication. Use
its signed assets to validate the assets, signatures, `latest.json`, target
URLs, and native installation/runtime behavior. The configured updater endpoint
serves only the latest published release, so installed clients cannot update
from a draft. A genuine two-version update and tampered-bundle rejection
therefore require a previously published signed version and must be tested on
each native target before claiming updater support; do not infer success across
targets. The six-target manifest may include macOS Intel, but its runtime and
updater support remain explicitly unverified and deferred.

The `Approve accepted draft release` job is protected by the GitHub Actions
`release` environment; the downstream `Publish accepted draft release` job
performs publication. After recording package and runtime acceptance evidence
in the related issues or PRs, approve `Approve accepted draft release` to
authorize publication of the draft to opted-in installations. If any target
being claimed as supported fails those checks, do not approve publication.
Since update checks require a published candidate, record their results
separately and do not claim updater support for a target until its two-version
and tamper-rejection checks pass. This approval is a post-merge release gate,
not a prerequisite to merging the stack.

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
