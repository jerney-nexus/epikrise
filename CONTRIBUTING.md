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

The Dev Container uses a private Docker volume for VS Code Server data so Agent Host session indexes and per-session data survive container rebuilds. This volume is specific to the dev container and is not shared with the host's VS Code data. It can contain prompts, tool output, attachments, extension state, or credentials: do not put patient data, clinical text, or secrets in agent chats, and protect the Docker host and its backups accordingly. A Docker volume is not encryption or a backup.

The volume mount does not migrate data from an existing container. Before adding the mount to a container with sessions to keep, export important chats using VS Code's **Chat: Export Chat...** command, or stop VS Code Server and back up and explicitly migrate the old data into the named volume. Do not copy live session databases. Verify that sessions reopen after a rebuild before removing any old copy.

#### GitHub CLI and Git credentials

`gh auth login` signs the GitHub CLI in to GitHub. If you accept its prompt to authenticate Git over HTTPS, it configures Git too. If you skipped that prompt, or Git's credential helper configuration was lost, a `git fetch` or `git push` over HTTPS can fail with `unable to get password from user` even when `gh auth status` reports a valid login.

To set up or repair Git's credential helper, run this in the dev container:

```bash
gh auth setup-git
```

The command registers GitHub CLI as Git's credential helper for each authenticated host. Run it again after logging in to a new host, or if the container's Git configuration has been reset.

To check the setup without printing tokens:

```bash
gh auth status
git config --get-all credential.https://github.com.helper
git ls-remote origin HEAD
```

`gh auth status` masks the token by default; do not add `--show-token`. The `git config` command should print the GitHub CLI helper. `git ls-remote` reads the remote without changing it, but this repository is public, so it succeeds without credentials and only shows that the remote is reachable. To confirm that Git can authenticate, run `git push --dry-run` on a branch you can push to, or run `git ls-remote` against a private repository you can access.

### Copilot tools, models, and session sync

The shared assistant rules, including GitHub routing and failure handling, are in [AGENTS.md](AGENTS.md). Copilot-specific session-history guidance is in [`.github/copilot-instructions.md`](.github/copilot-instructions.md). Repository instructions guide behavior, but cannot repair an MCP connection, override organization policy, or guarantee a particular model or price.

#### Tools and model cost

- A deferred MCP tool must first be loaded through the current host's tool search. Reuse its returned schema; tool names are not portable across clients. Do not disable tool search or load every MCP tool as a blanket workaround: that increases context and can make tool selection worse.
- For a failing MCP server, inspect its status and diagnostic output in the client that owns it. Separate discovery/schema errors from sign-in, authorization, connectivity, and rate limits. A successful read-only probe establishes only that operation's availability, not write permission.
- For routine work, use direct tools instead of spawning an agent for every lookup or command. Review actual model usage, not just the agent's role name. In Copilot CLI, `/model` selects the main model and `/subagents` configures subagent preferences. Where supported, Auto's efficiency profile is a cost-oriented option, not a guarantee of the cheapest model.
- Check the installed client's controls with `copilot --version`, `copilot --help`, and `copilot help config`. Supported Copilot CLI versions expose `autoTier` and `subagents.agents.<agent-name>` preferences. VS Code model selection and an embedded SDK host's routing may differ from standalone CLI settings. Do not pin model IDs in shared instructions or silently change a contributor's personal settings.

#### Missing sessions on GitHub

Local session persistence, cloud history sync, and remote session control are separate features. Docker volumes preserve local state, not cloud uploads. Session history may include prompts, responses, file changes, and tool output. Never put clinical material or secrets in chats, and do not upload diagnostic logs or enable sharing to troubleshoot sync.

1. Identify the client that created the missing session: VS Code's Copilot harness, standalone Copilot CLI, or an SDK host. Confirm the intended GitHub account and repository in that client; working `gh` or GitHub MCP access alone does not establish session-sync authentication.
2. In VS Code, inspect the Chat view's Copilot session-sync status. Sync needs both `chat.sessionSync.enabled` and `github.copilot.chat.localIndex.enabled`. Check effective settings, repository exclusions (`chat.sessionSync.excludeRepositories`), and policy, not only the checked-in workspace value. "Disabled by policy" requires an administrator; instructions cannot override it.
3. For standalone CLI, consult the installed help and the configuration reference below for `remoteExport`. Current CLI user preferences live in `$COPILOT_HOME/settings.json` (default `~/.copilot/settings.json`); `config.json` holds application state. This container seeds `config.json` and `mcp-config.json` from the host only when absent; it does not continuously mirror host preferences or seed `settings.json`. A host preference therefore need not apply inside the container.
4. Inspect only relevant, sanitized diagnostics: the session log for tool/model behavior and the owning client's runtime/output log for export errors. Request-send or batch-flush failures establish an upload failure, not whether its cause is network, authentication, or service availability. Check for exporter shutdown/drain errors as well. A reachable API hostname does not verify authenticated export or backlog delivery.
5. Before any user-approved change or restart, keep local state intact. Do not delete databases, copy live stores, export to a gist, enable remote control, or reauthenticate as an automatic fix. If policy and settings permit sync, verify recovery with a new non-sensitive session appearing in the intended GitHub account. Verify older missing sessions separately; do not assume they were backfilled.

References:

- [Copilot tool search](https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/tool-search)
- [VS Code custom agents and model/tool configuration](https://code.visualstudio.com/docs/agent-customization/custom-agents)
- [VS Code session history, sync status, and policy](https://code.visualstudio.com/docs/agents/run/sessions/session-history)
- [Copilot session data and CLI sync policy](https://docs.github.com/en/copilot/concepts/security-governance-and-network-settings/session-data)
- [Copilot CLI configuration directory and settings](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference)

### Local native setup

Follow the steps for your operating system, then run the common commands below. Builds are native-only: use a machine and Rust toolchain for the same operating system and architecture. For the full system requirements, see the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

All platforms need Rust 1.98+ and Node.js 22+. Install Rust with [rustup](https://rustup.rs/) and install Node.js for your operating system. Open a new terminal after installing them. Check that `rustc -vV` reports the host triple for this machine and that `node --version` reports v22.

#### Linux (Debian or Ubuntu)

Install Tauri, OCR, and native sidecar build dependencies:

```sh
sudo apt-get update
sudo apt-get install -y \
  build-essential cmake curl file libayatana-appindicator3-dev libssl-dev \
  libwebkit2gtk-4.1-dev librsvg2-dev libxdo-dev ninja-build pkg-config \
  tesseract-ocr tesseract-ocr-deu tesseract-ocr-eng
```

For another Linux distribution, install the equivalent packages listed in the [Tauri Linux prerequisites](https://v2.tauri.app/start/prerequisites/#linux) and install Tesseract with German (`deu`) and English (`eng`) language data.

#### macOS

Install Xcode Command Line Tools if they are not already installed, then install the native OCR build tools and language data with Homebrew:

```sh
xcode-select --install
brew install cmake ninja tesseract tesseract-lang
```

#### Windows x64 or ARM64

Use the [native Windows setup](#native-build-from-windows) below. It covers Visual Studio's C++ tools, Git for Windows, OCR language data, and the architecture-specific build commands. Do not use WSL for a native Windows build.

#### Install dependencies and run

`pnpm tauri dev` first prepares local OCR and PDFium resources. The build uses the installed Tesseract command to find its language-data folder, and requires both `deu.traineddata` and `eng.traineddata`. It then builds the app's own Tesseract sidecar from pinned, checksum-verified sources. If the language data is in a custom folder, set `EPIKRISE_TESSDATA_DIR` to that folder before building.

From the repository root:

```sh
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm tauri dev
```

On Linux and macOS, verify that `tesseract --list-langs` lists both `deu` and `eng`. If it does not, install the missing language data or set `EPIKRISE_TESSDATA_DIR` to a folder containing both `.traineddata` files. Keep that environment variable set in the same terminal where you run pnpm.

### Windows native development and installers

Native Windows builds run on matching Windows x64 or ARM64 hosts. Windows cross-builds are not supported here. The separate Linux ARM64 Dev Container cross-build is for diagnostic NSIS installers only.

#### Native build from Windows

Use PowerShell on Windows x64 to build x64, or on Windows ARM64 to build ARM64. The wrapper initializes Visual Studio for you. Do not use WSL or the Dev Container for a native Windows build.

Install these prerequisites before building:

- Node.js 22 and Corepack. The repository pins pnpm `12.15.0`.
- Rust for the Windows host architecture with the MSVC toolchain. On ARM64, `rustc -vV` must report `host: aarch64-pc-windows-msvc`; on x64 it must report `host: x86_64-pc-windows-msvc`.
- Windows ARM64 builds also need `clang.exe` for the locked `ring` dependency. In Visual Studio Installer, select **C++ Clang tools for Windows** under **Desktop development with C++**. The build wrapper searches Visual Studio's LLVM tools and adds the compiler to `PATH`.
- Visual Studio or Visual Studio Build Tools. In Visual Studio Installer, select **Desktop development with C++**, the Windows SDK, and the MSVC C++ compiler, headers, and libraries for the host architecture. On ARM64, make sure the native ARM64 C++ tools are selected; x64-emulated tools are not sufficient. The Visual Studio Installer's `vswhere.exe` and `VC\Auxiliary\Build\vcvarsall.bat` must be present. See the [Tauri Windows prerequisites](https://v2.tauri.app/start/prerequisites/#windows) and [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/).
- Git for Windows, which provides Git Bash. The wrapper locates and verifies Git Bash itself, then starts it after initializing Visual Studio; you do not need to open a Git Bash window or add Bash to `PATH` for a standard installation. If Git for Windows is installed in a custom location and the wrapper cannot find it, add its `cmd` or `bin` folder to this PowerShell session's `PATH`. CMake, Ninja, `cl`, `dumpbin`, `curl`, `tar`, and `rg` must also be available to the build shell. To install CMake with Visual Studio, open **Visual Studio Installer**, select **Modify** for the installed Visual Studio or Build Tools instance, ensure **Desktop development with C++** is selected, then open **Individual components** and select **C++ CMake tools for Windows**. If the build still reports CMake missing, install the standalone version from the WinGet community repository so `cmake.exe` is added to `PATH`. Ninja is also a separate tool. Visual Studio Installer can provide both **C++ CMake tools for Windows** and **Ninja: build system** under **Individual components**; if either is unavailable on `PATH`, use the WinGet commands below.

  ```powershell
  winget show --id Kitware.CMake --exact --source winget
  winget install --id Kitware.CMake --exact --source winget
  winget show --id Ninja-build.Ninja --exact --source winget
  winget install --id Ninja-build.Ninja --exact --source winget
  ```

  After installation, open a new PowerShell window and confirm that `cmake --version` and `ninja --version` print versions. Visual Studio's bundled CMake may not be added to the regular PATH; the wrapper adds its standard bundled-tools directory to the build-shell PATH automatically. It then checks that CMake and Ninja are available before building.

- Tesseract language data containing both `deu.traineddata` and `eng.traineddata`. You do not need an installed Tesseract executable if you set `EPIKRISE_TESSDATA_DIR` to that data directory.

Run the following in **PowerShell** from the repository root. A regular PowerShell or Command Prompt is sufficient; the wrapper locates Visual Studio and initializes its developer environment itself. Do not use WSL or run these commands inside the Dev Container. Do not run `pnpm windows:setup` here; that command provisions the separate Linux Dev Container cross-build.

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

The user-local Corepack shim avoids writing under `C:\Program Files`. Use `pnpm.cmd` in PowerShell to avoid a blocked `pnpm.ps1`; the wrapper inherits this session's `PATH` and can find the same pnpm command.

The version commands should report Node 22 and pnpm 12.15.0; `rustc -vV` must report the native host triple listed above. The wrapper locates and verifies Git Bash for standard installations. For a custom installation, add its `cmd` or `bin` folder to this PowerShell session's `PATH` and retry the wrapper. Install Git for Windows if it is not installed.

Set `EPIKRISE_TESSDATA_DIR` to a folder containing both `deu.traineddata` and `eng.traineddata`. If Tesseract is installed with both languages, point it to that installation's `tessdata` folder. Otherwise, download the project-pinned language files into a user-local folder and verify their checksums:

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

The data is stored under your local application data directory, not in the repository. Keep using the same PowerShell session so the environment variable and user-local pnpm shim remain available during the build.

To start the app for development, run:

```powershell
pnpm.cmd tauri dev
```

To build an unsigned diagnostic installer, run **one** command matching the Windows host:

On Windows ARM64:

```powershell
.\scripts\build-native-windows.cmd arm64 diagnostic
```

On Windows x64:

```powershell
.\scripts\build-native-windows.cmd x64 diagnostic
```

The wrapper locates Git Bash and checks that the Rust host, MSVC host, MSVC target, and requested target architecture all match.

Native-only Tauri `build` and `dev` commands reject custom runners such as `cargo-xwin`; the default `cargo` runner remains available. They also validate cross-target Cargo configuration from Cargo config files, `CARGO_BUILD_TARGET`, and forwarded Cargo `--config` overrides against the effective command target before OCR preparation.

The generic `pnpm tauri build` and `pnpm tauri dev` commands also initialize Visual Studio automatically when launched from a regular PowerShell, Command Prompt, or Git Bash session. They select the current Windows architecture and preserve the Tauri arguments; the explicit wrapper commands above remain the recommended path for diagnostic native builds. Native-only Tauri `build` and `dev` commands reject custom runners such as `cargo-xwin`; the default `cargo` runner remains available. They also validate cross-target Cargo configuration from Cargo config files, `CARGO_BUILD_TARGET`, and forwarded Cargo `--config` overrides against the effective command target before OCR preparation.

The first build needs network access to download and checksum-verify the OCR source archives and PDFium. The unsigned diagnostic installer is written under `src-tauri/target/host-<host-triple>/<target>/release/bundle/`. The wrapper returns a non-zero exit code if setup, compilation, bundling, or architecture verification fails. Diagnostic builds disable release LTO, use 16 codegen units, and compile at optimization level 2 to reduce peak memory use. Signed release builds retain the optimized release profile configured in `src-tauri/Cargo.toml`. Build caches are kept between runs: Cargo artifacts live under `src-tauri/target/host-<host-triple>/`, and the native OCR CMake/Ninja build cache lives under `%USERPROFILE%\.cache\epikrise\windows-ocr-native-msvc\`. Cargo reuses outputs that are still up to date; changes to Rust sources, toolchain/profile settings, or build inputs may require affected crates to compile again. The diagnostic profile has just changed to reduce memory, so its first run rebuilds artifacts for the new profile. Avoid `cargo clean` or deleting these cache directories unless you intentionally want a full rebuild.

Build caches are kept between runs: Cargo artifacts live under `src-tauri/target/host-<host-triple>/`, and the native OCR CMake/Ninja build cache lives under `%USERPROFILE%\.cache\epikrise\windows-ocr-native-msvc\`. Cargo reuses outputs that are still up to date; changes to Rust sources, toolchain/profile settings, or build inputs may require affected crates to compile again. The diagnostic profile has just changed to reduce memory, so its first run rebuilds artifacts for the new profile. Avoid `cargo clean` or deleting these cache directories unless you intentionally want a full rebuild.

If compilation reports that `vcruntime.h` cannot be found, the installed MSVC toolset or its C++ headers are missing or inconsistent. Use Visual Studio Installer to add or repair the C++ build tools and Windows SDK for the host architecture, open a new PowerShell window, and rerun the native wrapper.

#### Manual Linux ARM64 cross-build

This path builds diagnostic Windows installers, not a native Windows app. Use it only from the native Linux ARM64 Dev Container. It requires LLVM, CMake, Ninja, NSIS, `cargo-xwin`, and Tauri's NSIS Restart Manager include. Do not use CPU emulation. Run setup in an interactive terminal; it installs `cargo-xwin` if needed before displaying the Microsoft SDK/CRT license link. Review the license and type `ACCEPT` to allow downloading the pinned Windows SDK package `10.0.26100` and Visual C++ toolset component `14.44.17.14`. This acceptance gates the SDK/CRT download, not installation of `cargo-xwin`. The interactive path is for local setup; GitHub Actions uses the separate `--ci` path only when `EPIKRISE_WINDOWS_SDK_LICENSE_APPROVED=true`.

```sh
pnpm windows:setup
```

Then explicitly opt in to the manual, unsigned diagnostic NSIS cross-build in the current shell. Build one architecture or both:

```sh
export EPIKRISE_ALLOW_LINUX_WINDOWS_CROSS_BUILD=true
pnpm windows:build:x64
pnpm windows:build:arm64
pnpm windows:build
```

The build scripts reject CI, unsupported hosts, release mode, MSI/MSIX, and other non-NSIS package selections before downloading assets or compiling. Generic `pnpm tauri build` stays native; signed Windows release builds also remain on their native Windows runner.

Installers are written to `src-tauri/target/host-<host-triple>/<target>/release/bundle/nsis/`. Each includes the offline WebView2 installer, adding about 127 MB. The first cross-build downloads and verifies the host-matched LLVM-MinGW archive, Tesseract, its dependencies, and PDFium after the setup license gate; subsequent builds use isolated host/target caches. Tesseract's CMake TIFF capability probe is given an explicit cross-build result, so no Windows executable is run in Linux. TIFF input is not needed by the app's OCR path, which passes PNG images to Tesseract.

For runtime validation, use a native host for each target whose support you intend to claim: install and launch the package, verify PDFium loading, run synthetic German and English OCR, check credentials and clipboard, then uninstall. A successful cross-build alone does not verify installation or runtime behavior. The NSIS installer is configured for offline WebView2 installation in `src-tauri/tauri.windows.conf.json`; a separate install test starting without WebView2 is not required. macOS Intel runtime support remains explicitly unverified and deferred.

For uninstall testing, use **Settings > Apps > Installed apps > Epikrise > Uninstall**. The NSIS setup executable's same-version maintenance page runs the uninstaller and then continues into setup when its Uninstall option is chosen; that upstream behavior is not a completed uninstall flow.

## Cross-platform Actions builds

The manual **Desktop builds** workflow produces six target-specific packages: Linux x64 and ARM64 (`.deb`, `.rpm`, AppImage), macOS x64 and ARM64 (`.dmg`), and Windows x64 and ARM64 (NSIS `.exe` with offline WebView2). Linux and macOS use native GitHub-hosted runners. Windows jobs run on Windows GitHub-hosted runners and use the native Windows build wrapper above; they do not use the Dev Container or `cargo-xwin`. OCR sidecars are built from pinned source archives, and downloaded source/PDFium files are checksum-verified. Native Linux OCR is statically linked; macOS OCR links its third-party dependencies statically and checks that remaining dynamic libraries are provided by macOS.

Run `pnpm build:all` only after the workflow is present and enabled on GitHub. The worktree must be clean, and `HEAD` must be the exact commit pushed to the current `origin` branch or tag. The command does not commit or push. `gh` authentication must permit workflow dispatch and artifact download; the container and Actions runners need network access. Six isolated jobs can run in parallel. Completed outputs and their manifests are downloaded to `.artifacts/desktop-builds/<request-id>/`, which is Git-ignored; the command rejects missing jobs, wrong SHAs/versions/targets, incomplete packages, and manifest or SHA-256 mismatches. Windows NSIS and Store MSIX packages are downloaded and verified separately; their manifests bind the request, commit, version, runner architecture, and Rust target. GitHub retains the uploaded artifacts for 14 days.

Windows jobs in this workflow use native Windows runners; the manual Linux cross-build setup is not available in Actions and never accepts the SDK/CRT license on a user's behalf.

Separately from the NSIS installers, the reusable `store-msix` job (called by both Desktop builds and the signed release) builds an unsigned, architecture-specific MSIX artifact for each Windows architecture. These MSIX files are for Partner Center submission only: they use the reserved Store identity, are versioned as `year.month.patch.0`, and are not the local installation path. After a successful tagged signed release, the Store submission workflow attaches each package, the bundle, and the SHA-256/provenance manifests as separate assets to the matching GitHub Release. The signed release builds them once through the reusable `.github/workflows/store-msix.yml`, and the Store submission workflow downloads them from that run. It then uploads the bundle to Partner Center as a draft with `msstore publish --noCommit`, copies the listing text and images from `store-assets/base-metadata.json` into the draft and sends it with `msstore submission updateMetadata` (the listing images must already be uploaded for each locale), and commits with `msstore submission publish`. The upload job runs on `windows-latest` and fails if `STORE_PRODUCT_ID` is empty. It needs the `AZURE_AD_APPLICATION_CLIENT_ID`, `AZURE_AD_CERTIFICATE_PFX_BASE64`, `AZURE_AD_CERTIFICATE_PASSWORD`, `AZURE_AD_TENANT_ID`, and `SELLER_ID` secrets and the `STORE_PRODUCT_ID` variable, all in the `store-partner-center` environment; see [Microsoft Store setup in RELEASING.md](RELEASING.md#microsoft-store-setup). The Store upload does not depend on the six-target NSIS build matrix. When dispatching Desktop builds directly, provide `previous_store_version` if a prior Store submission exists so the build rejects a non-advancing version. Microsoft signs submitted Store packages and manages Store updates. The first submission and any manual resubmission are done in Partner Center by hand. Partner Center certification is a separate Microsoft process: creating the MSIX or `.msixbundle`, and passing the MSIX identity and content checks, do not establish certification. The Store package does not include the WebView2 Evergreen Runtime, which must be available on the Windows device. Continue using the NSIS `.exe` for local installation; it includes the offline WebView2 installer and remains separate from the Store package and Store update model. To package the x64 and ARM64 MSIX files for Partner Center, see [Building the Store `.msixbundle`](#building-the-store-msixbundle).

Build artifacts are unsigned and macOS packages are not notarized. Expect SmartScreen/Gatekeeper warnings or installation restrictions; do not distribute them into a clinical environment as trusted installers. The workflow creates diagnostic artifacts; it does not publish releases or configure updates.

### Building the Store `.msixbundle`

Partner Center accepts one `.msixbundle` that contains the x64 and ARM64 Store packages. The Store packages are built by the shared `store-msix.yml` workflow, which the signed release and manual Desktop builds call. It builds the bundle automatically with `scripts/package-store-msixbundle.ps1` on a Windows runner. The manual steps below are for reproducing or repairing a bundle on Windows after both architecture-specific MSIX packages for the same release are downloaded and verified. Use a Windows 10/11 machine with the Windows SDK installed, and run the commands in a Developer PowerShell (or call `makeappx.exe` by its full path).

1. Download the `Epikrise_<version>_x64.msix` and `Epikrise_<version>_arm64.msix` files, with their `.msix.manifest.json` files, from the GitHub Release for the tagged version. The Store submission workflow attaches them after a successful tagged signed release. Check each package against its manifest. If the release is not yet published, use the `epikrise-store-msix-x64` and `epikrise-store-msix-arm64` artifacts from the same Desktop builds run instead. Each contains the package under `files/` and a single root `manifest.json` with its SHA-256; there are no per-package `.msix.manifest.json` files in the artifacts.
2. Create an empty folder, for example `C:\StoreBundle`, and copy only the two `Epikrise_<version>_<arch>.msix` files into it. `makeappx` bundles only packages that share the same identity and version, so the folder must not contain anything else.
3. Run `makeappx` from the SDK, replacing the folder and output paths. `<version>` is the four-part version shared by both packages (`year.month.patch.0`). Pass it with `/bv`; without it, MakeAppx stamps the bundle with the current date-time instead.

   ```powershell
   makeappx.exe bundle /d C:\StoreBundle /p C:\StoreBundle\Epikrise_<version>.msixbundle /bv <version>
   ```

   If `makeappx.exe` is not on `PATH`, call it by its full SDK path with PowerShell's call operator, for example `& "C:\Program Files (x86)\Windows Kits\10\bin\<sdk-version>\x64\makeappx.exe" bundle /d C:\StoreBundle /p C:\StoreBundle\Epikrise_<version>.msixbundle /bv <version>`. The script `scripts/package-store-msix.ps1` searches the same SDK location and prefers the newest version.

4. Confirm the output file exists. The bundle is unsigned. Microsoft signs submitted Store packages, as described above.

The `store-msix.yml` bundle job attaches a GitHub build provenance attestation to the `.msixbundle`. The release's Store publish job verifies it with `gh attestation verify` before attaching the bundle. To verify a downloaded copy, run `gh attestation verify Epikrise_<version>_bundle.msixbundle --repo jerney-nexus/epikrise`.

Keep the bundle and its inputs out of the repository and out of any clinical environment. Upload the bundle to Partner Center manually.

The Store packages do not bundle the WebView2 Evergreen Runtime and do not include a WebView2 bootstrapper. Devices must already have the runtime installed. The NSIS installer is the offline-WebView2 path. Keep the Store listing's requirements consistent with this.

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

The dev container installs the required Rust tools during setup. For a local setup, install them once:

```sh
rustup component add clippy rustfmt llvm-tools-preview
cargo install cargo-deny --locked
cargo install cargo-nextest --locked
cargo install cargo-llvm-cov --locked
cargo install cargo-audit --locked
```

`cargo-deny` is required by `pnpm check`; `cargo-nextest` is required by `pnpm test:rust`; `cargo-audit` is required by `pnpm audit:rust`; and `cargo-llvm-cov` plus `llvm-tools-preview` are required for Rust coverage. `pnpm lint:actions` requires `actionlint`, and `pnpm lint:shell` requires `shellcheck`; both are installed in the dev container. For local setup, follow the [actionlint installation instructions](https://github.com/rhysd/actionlint#installation) and the [shellcheck installation instructions](https://github.com/koalaman/shellcheck#installing).

In CI, the workflow linting is done by the `raven-actions/actionlint` action in the `actionlint` job of `quality-checks.yml`, and shell scripts are linted by `pnpm lint:shell` in the `quality` job. `pnpm lint:actions` remains available for local use.

`pnpm test` includes the full Playwright browser suite in addition to UI, i18n, and Rust tests.

### Integration tests

`pnpm test:integration` runs `tests/**/*.integration.test.ts`, which need external tools that the unit suites do not require. It is excluded from `pnpm test:ui` and coverage. It currently needs PowerShell 7 (`pwsh`) to run the Windows WebView2 record round-trip. Install PowerShell before running it, then run:

```sh
pnpm test:integration
```

CI installs PowerShell and runs this command in the "UI and i18n" job of the "Frontend tests" workflow after the UI and i18n tests.

### Browser tests

Run only the Playwright suite with `pnpm test:e2e`, or its focused accessibility selection with `pnpm test:a11y`:

```sh
pnpm test:e2e
pnpm test:a11y
```

The tests use synthetic IPC, event, and clipboard fixtures and reject unexpected external requests. Never add real or realistic clinical data to a browser fixture. If Chromium is not installed locally, run `pnpm exec playwright install chromium`. Browser mocks verify UI behavior, not native Rust policy enforcement, updater signatures, or platform installation.

Lint levels live in `[workspace.lints]` in src-tauri/Cargo.toml. Tests are exempted from the panic and printing rules via `src-tauri/clippy.toml`.

## Commits and changelog

Use Conventional Commit subjects (`feat: add template importer`, `fix: handle formatted output`) and keep each commit focused on one change. User-visible changes get an entry under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md).

To prepare a release, run the **Release preparation** workflow from the GitHub Actions tab, or run `pnpm release:prepare:workflow [YYYY.M.MICRO]` (also the VS Code task **Epikrise: Dispatch Release Preparation Workflow**). The command needs an authenticated `gh` CLI and starts the workflow on `main`; it does not wait for the run. Enter a `YYYY.M.MICRO` version or leave it blank to select the next CalVer version. The workflow updates npm, Cargo, and Tauri metadata, generates release notes, and opens a pull request for review. Find that pull request with `gh pr list --repo=jerney-nexus/epikrise --state=open --search "head:release/"` (its branch is `release/<version>`, and its title is `Release <version>`). The workflow opens the pull request with a GitHub App token, not `GITHUB_TOKEN`, because pull requests opened with `GITHUB_TOKEN` do not reliably trigger the **Release PR macOS updater bundle gate**. It requires the `RELEASE_APP_CLIENT_ID` and `RELEASE_APP_PRIVATE_KEY` GitHub Actions secrets (`RELEASE_APP_CLIENT_ID` holds the App's Client ID, not its numeric App ID; the workflow passes it as `client-id` to `actions/create-github-app-token`): the App needs repository **Contents** and **Pull requests** read and write permissions, and must be installed on this repository.

Local `pnpm release:prepare` also requires `git-cliff` at the exact version the workflow pins (`2.10.1`). It checks this before writing any file. If it is missing or different, install it with `cargo install git-cliff --version 2.10.1 --locked`.

After merging that PR, run `pnpm release:preflight` from a clean worktree. It fetches tags, fast-forward updates `main` from `origin/main`, and reports the project version and whether its tag exists locally and remotely. If the preflight reports that the tag is absent, run `pnpm release:tag` (optionally with the version) from the clean, synchronized `main` branch. The tag command checks the version and local/remote tag state, asks for an interactive `PUSH` confirmation, then creates an annotated tag and pushes only that tag ref. It never force-updates a tag. Both commands are also available as VS Code tasks. The tag task has its own version prompt: leave it blank to use the current `package.json` version, not to select the next release version.

### Release and update workflow

Release identities use unpadded `YYYY.M.MICRO`. If Cargo, Tauri, an installer, or updater protocol requires another representation, derive it only for that build or package input. Existing published versions and tags remain immutable. The six-target Desktop builds workflow remains an unsigned diagnostic contract and does not publish releases.

The default Tauri configuration leaves updater support disabled. The separate **Signed updater release** workflow runs when a `vYYYY.M.MICRO` tag is pushed: it builds target-specific signed bundles, stages the expected assets and signatures, generates `latest.json`, and publishes a GitHub release. It uses the public key configured in `src-tauri/tauri.release.conf.json` and requires the matching `TAURI_SIGNING_PRIVATE_KEY` GitHub Actions secret (and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if the key is encrypted).

Only the Linux AppImage is an updater target. The `.deb` and `.rpm` packages are built separately with `features: []` and `--no-sign`, so the `direct-release-updater` feature is compiled out and they have no `.sig`. This is intentional: package-managed installs are owned by dpkg or rpm, and an in-place update would bypass the package database. Do not add `.deb` or `.rpm` to updater acceptance checks.

Changes to macOS updater bundle generation run the **macOS updater bundle smoke** workflow on native Intel and Apple Silicon runners. It builds the updater-enabled `.app.tar.gz` without production signing secrets and verifies that the archive is generated. This smoke check does not verify a production signature; keep signed-release acceptance pending until a native signed run confirms both the archive and its signature.

Every pull request targeting `main` receives the **Release PR macOS updater bundle smoke** status check. It passes immediately for non-release branches. For `release/*` branches, it waits up to 60 minutes for the macOS updater bundle smoke run for the same pull request number, head SHA, and base SHA, and requires both `Build x86_64-apple-darwin` and `Build aarch64-apple-darwin` to pass. The gate runs trusted code from the PR base and rejects changes to the smoke workflow and to the build inputs it executes or reads: every script the workflow runs, directly or through another script (cargo-target, OCR, native-environment, architecture, and runtime-dependency checks, including PowerShell `.ps1` scripts), `src-tauri/build.rs`, every other Rust source and Cargo manifest under `src-tauri/` (the only Rust workspace), including any build script a manifest names, `src-tauri/tauri.release.conf.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc`, `.pnpmfile.cjs`, `vite.config.js`, `tsconfig.json`, PostCSS config files (`postcss.config.*` and `.postcssrc*`, which Vite loads automatically), Vite env files (`.env`, `.env.local`, `.env.production`, `.env.production.local`), Rust toolchain pins (`rust-toolchain` and `rust-toolchain.toml`, at the root and in `src-tauri/`), and Cargo config files (`.cargo/config` and `.cargo/config.toml`, at the root and in `src-tauri/`), `src-tauri/tauri.macos.conf.json`, `src-tauri/Info.plist`, and every tracked file under `src/`, `static/`, `locales/`, `src-tauri/capabilities/`, `src-tauri/icons/`, and `src-tauri/resources/`, which the app bundles. Files in those directories, including files a PR adds, are compared by blob SHA and file mode at both refs, so any change fails the gate. Symlinks in that scope, and blobs at a trusted directory's own name (for example a file named `static`), also fail the gate. This scope is intentional: a release PR that changes those directories is blocked rather than re-verified, because the smoke run tested the bundled content before the change. The scope stays unchanged unless the gate is updated to rerun the smoke build on the exact head SHA for those changes. The OCR runtime assets under `src-tauri/resources/ocr/` are gitignored and fetched by `scripts/prepare-ocr.sh` against pinned SHA-256 values instead. The gate reads each `src-tauri/` Rust source and Cargo manifest at both refs. Rust sources under `src-tauri/` must be identical at both refs. Manifests there may change only their `version` under `[package]` and `[workspace.package]`, which release preparation sets, and a build script that a manifest names is trusted like the other build inputs. The gate reads the `build` key in its TOML forms (spaced or quoted headings, quoted or dotted keys, and inline `package` tables) and fails closed on any value it cannot parse. The repository has no Rust sources or manifests outside `src-tauri/`, so the gate does not enumerate them. The smoke workflow runs for every pull request without a path filter, so every trusted Rust input starts the smoke run for a release head. The gate follows script references from the `build` and `prepare` scripts in `package.json`, which are the only npm scripts the smoke run executes. A reached Rust file that uses `include!` or declares `mod x;` without a `#[path]` attribute fails the test suite, because the closure cannot follow it. If a required input (the smoke workflow or `src-tauri/build.rs`) is missing at either ref, or either commit SHA cannot be resolved, the gate fails rather than passing. `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.lock` may change only in their version fields, which release preparation sets. For the lockfile, that means the `version` of local (source-less) packages; registry and git entries must match the base exactly. Retargeting a release PR triggers both workflows. A missing run, a failed job, or a run that does not finish before the timeout fails the gate. The smoke workflow has no path filter and runs for every pull request, so a `release/*` head always gets a smoke run for its exact head and base SHA, even when it changes only files the smoke build does not read. Its build job runs only for `release/*` heads and base retargets, so non-release PRs skip the macOS builds. Manual `workflow_dispatch` runs always build, whatever the branch.

The **Branch default** ruleset in Settings → Rules → Rulesets requires these status checks: `Rust checks and tests`, `UI and i18n`, `quality`, `Playwright browser tests`, `dependencies`, `actionlint`, and **Release PR macOS updater bundle smoke**. Keep this set in sync with the workflows. A repository administrator must add or remove a required check there, and must not require the two macOS smoke jobs directly; the gate is the only macOS-related required check.

Keep signing keys in the approved GitHub Actions secrets; never commit private signing material or generate or replace a production key in CI. A Tauri updater signature verifies the update payload and does not replace platform publisher signing. Store delivery uses a separate Microsoft certification process.

The tag workflow creates and verifies a draft release before publication. Use its signed assets to validate the assets, signatures, `latest.json`, target URLs, and native installation/runtime behavior. The configured updater endpoint serves only the latest published release, so installed clients cannot update from a draft. A genuine two-version update and tampered-bundle rejection therefore require a previously published signed version and must be tested on each native target before claiming updater support; do not infer success across targets. The six-target manifest may include macOS Intel, but its runtime and updater support remain explicitly unverified and deferred.

Before creating a release tag, run the **Windows release workspace** workflow from the Actions tab on `main`. It exercises the same normalized-workspace preparation used by signed releases on native Windows x64 and ARM64 runners, without signing secrets or package builds. The workflow also runs automatically on pull requests that change the shared workspace preparation or either consumer workflow. Require both architecture jobs to pass before starting a tagged release.

The `Approve accepted draft release` job is protected by the GitHub Actions `release` environment; the downstream `Publish accepted draft release` job performs publication. After recording package and runtime acceptance evidence in the related issues or PRs, approve `Approve accepted draft release` to authorize publication of the draft to opted-in installations. If any target being claimed as supported fails those checks, do not approve publication. Since update checks require a published candidate, record their results separately and do not claim updater support for a target until its two-version and tamper-rejection checks pass. This approval is a post-merge release gate, not a prerequisite to merging the stack.

## Localization

User-facing strings live in Fluent catalogs under `locales/`. Rust code returns translation keys and arguments, never localized text — the frontend resolves them. Adding a language means adding a folder; do not hardcode strings in command return paths.

English literals that are intentionally not translated are not hardcoded UI strings and should not be flagged in review:

- Brand and provider names, such as Epikrise, Ollama, OpenAI, Anthropic, Gemini, OpenRouter, Groq, and xAI.
- Text sent to the model, such as the correction prompt built in `regenerateWithCorrections` in `src/routes/+page.svelte`.
- Persisted template data, such as the default section heading and `labels` written by `addTemplateEditorSection`. Stored data must not follow the UI language.
- Fluent source strings passed to `t()` or assigned to status state, such as `generationMessage = "Draft ready"`. `t()` resolves them through the catalogs, and missing keys fall back to the English source, so keys must be added to every catalog.
- CSS font names and placeholder URL examples.

## Templates and test data

Never commit real or realistic clinical material, not even as a test fixture. The `templates/` and `fixtures/clinical/` directories are git-ignored for this reason. Fixtures used by tests must be synthetic.

## Reporting security issues

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Do not open a public issue, especially for anything that could expose clinical content.
