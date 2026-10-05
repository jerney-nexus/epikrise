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

#### Agent approvals and permissions

Repository-wide editor, formatter, ESLint, Svelte, Vitest, and Rust project/test
settings live in `.vscode/settings.json`, including the Cargo manifest and
Clippy command used outside the container. The container's
`customizations.vscode.settings` holds only its agent approval defaults and
Linux-specific sandbox policy. Personal Copilot enablement and chat-session
cloud sync belong in User settings and are not forced by either shared file.
Workspace settings override container Remote defaults; object-valued settings
can merge with user settings, so these defaults are not enforced policies.

The container's VS Code settings use manual permissions for new sessions,
disable global allow-all and assisted permissions, and keep the built-in
terminal safety rules. Routine `pnpm` checks, tests, read-only formatting checks,
web builds, development servers, audits, and read-only Git/GitHub inspection are
explicitly auto-approved. File-writing formatters require approval. Rules evaluate individual subcommands; a command chain still
requires approval if any part is not allowed or matches a manual-approval rule.
The separate workspace package-script approver is disabled, so scripts such as
`prepare` and `tauri` are not approved merely because they exist in `package.json`.
Git branch commands require approval except for `git branch --show-current`,
overriding the broader built-in branch rule.

Dependency installation, dependency-audit fix modes, arbitrary shell/package
execution, Git mutations, GitHub API requests and writes, workflow dispatch,
release preparation, template conversion, and desktop/Windows provisioning or
builds remain manual.
These operations can change external state, handle clinical templates, download
and execute dependencies, or require license acceptance. Auto-approval assumes
trusted repository scripts and is a convenience, not a security boundary.

Normal source edits are allowed, but environment files, signing-key files,
policy files, agent instructions, container/editor configuration, GitHub
configuration, package scripts, pnpm lock/workspace files, Cargo manifests and
lockfiles, and tooling scripts require edit approval.
Selected official documentation URLs allow requests automatically, while their
responses still require review. This does not authorize sending secrets,
clinical material, prompts, or generated clinical output to any URL.

To apply and review these defaults:

1. Rebuild the container after changing `.devcontainer/devcontainer.json`, then
   start a new chat session with **Manual permissions**. Existing sessions and
   user overrides can retain different permissions; **Allow all** and Autopilot
   bypass approval prompts.
2. Run **Chat: Manage Tool Approval** to inspect saved pre- and post-approvals
   for extension and MCP tools. Do not blanket-trust a GitHub server or its write
   tools. The container makes the available GitHub write tools, extension
   installation, and generic VS Code command/task execution ineligible for
   auto-approval. Tool reference names depend on the installed extension/server;
   review this list when tools change. Use **Chat: Reset Tool Confirmations**
   only when you intend to clear all saved tool approvals.
3. Review URL response approvals separately from request approvals, and check
   **Trusted Domains**, which can independently approve URL requests.

Nested terminal sandboxing is off by default: a `bubblewrap` probe in the
current container fails with `Operation not permitted`, despite `bubblewrap`
and `socat` being installed. Do not assume that container isolation also hides
the mounted GitHub credentials or host agent configuration from commands.

On a host that supports nested sandboxing, install `bubblewrap` and `socat`,
verify that a sandboxed command works, and set `chat.agent.sandbox.enabled` to
`on` in Remote settings. The prepared policy disables sandbox-wide automatic
approval and unsandboxed fallback, denies reads of SSH and mounted host agent
configuration, and disables unrestricted network access. The domain allowlist
is limited to GitHub and package registries; add only services a task needs.
Local sessions and the Agent Host custom terminal tool can use this allowlist.
The Agent Host built-in shell cannot filter domains and instead blocks outbound
network access when `allowNetwork` is false. These restrictions are inactive
while sandboxing is off and do not apply to non-terminal tools.

Start a new session and use `/sandbox-policy` in an Agent Host session to inspect
the effective policy. Restart VS Code after changing network-domain settings.
Refer to [VS Code approvals and permissions](https://code.visualstudio.com/docs/agents/run/approvals)
and [terminal sandboxing](https://code.visualstudio.com/docs/agents/run/agent-sandboxing)
for harness differences and organization-managed restrictions. These editor
controls do not replace Epikrise's runtime clinical-data and egress policies.

### Local setup

Install the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
for your platform, plus Rust 1.98+ and Node 22+. macOS builds also require
Homebrew Tesseract and German language data:

```sh
brew install tesseract tesseract-lang
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

## Cross-platform Actions builds

The manual **Desktop builds** workflow produces six native/target-matched
packages: Linux x64 and ARM64 (`.deb`, `.rpm`, AppImage), macOS x64 and ARM64
(`.dmg`), and Windows x64 and ARM64 (NSIS `.exe` with offline WebView2). Linux
and macOS use native GitHub-hosted runners; Windows uses the existing
Linux-ARM64 `cargo-xwin` cross-build. OCR sidecars are built from pinned source
archives, and downloaded source/PDFium files are checksum-verified. Native
Linux OCR is statically linked; macOS OCR links its third-party dependencies
statically and checks that remaining dynamic libraries are provided by macOS.

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

Before enabling Windows jobs, a repository administrator must review the
license for the pinned Microsoft Windows SDK/CRT and set the repository
**Actions variable** `EPIKRISE_WINDOWS_SDK_LICENSE_APPROVED` to the exact string
`true`. The workflow only passes that value to the guarded setup script; it
does not accept the license or store the SDK/CRT in Actions caches. If the
variable is absent or different, setup fails before those downloads. Local
`pnpm windows:setup` remains interactive and still requires typing `ACCEPT`.

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

Do not open a public issue for a vulnerability, in particular anything that
could cause clinical content to leak. Contact the maintainer directly.
