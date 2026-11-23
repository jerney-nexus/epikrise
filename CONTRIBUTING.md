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

Release preparation, the release gates, and the updater and Store rules are documented in the [Releasing](https://github.com/jerney-nexus/epikrise/wiki/Releasing) wiki page.

## Localization

User-facing strings live in Fluent catalogs under `locales/`. Rust code returns translation keys and arguments, never localized text — the frontend resolves them. Adding a language means adding a folder; do not hardcode strings in command return paths.

English literals that are intentionally not translated are not hardcoded UI strings and should not be flagged in review:

- Brand and provider names, such as Epikrise, Ollama, OpenAI, Anthropic, Gemini, OpenRouter, Groq, and xAI.
- Text sent to the model, such as the correction prompt built in `regenerateWithCorrections` in `src/routes/+page.svelte`.
- Persisted template data, such as the default section heading and `labels` written by `addTemplateEditorSection`. Stored data must not follow the UI language.
- Fluent source strings passed to `t()` or assigned to status state, such as `generationMessage = "Draft ready"`. `t()` resolves them through the catalogs, and missing keys fall back to the English source, so keys must be added to every catalog.
- CSS font names and placeholder URL examples.

Native startup dialogs run before the webview exists, so `src-tauri/src/startup_dialog.rs` resolves them from the catalogs using the OS locale. This can differ from the in-app language, which is stored in the webview and defaults to `de-CH`. The static `<title>` in `src/app.html` is a pre-mount fallback; the runtime title is set from `t()` once the app mounts.

### Reviewing translations in Crowdin

Crowdin is the main review path for translations. Send only UI strings; never send patient data, clinical text, or credentials.

The file-based project `epikrise` (id 946799) uses `en` as its source and `fr`, `es-ES`, and `it` as targets. `de-CH` is not a Crowdin target: it is the app's default and reference locale, so `locales/de-CH/app.ftl` is the authored German text that the other catalogs are checked against, not a translation to be produced. It stays in the repo as the reference locale. The source is `locales/en/app.ftl`, uploaded in Crowdin's `ftl` format at the same repo path, so `crowdin.yml` needs no `dest` override. `crowdin.yml` maps `es-ES` to the repo folder `es` through `%two_letters_code%`, because Crowdin reports the code as `es`.

Run the Crowdin CLI through these shortcuts. It is pinned as the `@crowdin/cli` dev dependency (5.6.0). The config reads `CROWDIN_PROJECT_ID` and `CROWDIN_PERSONAL_TOKEN` from the environment; never commit a token.

```sh
pnpm crowdin:upload:sources        # uploads the English source
pnpm crowdin:upload:translations   # uploads the fr, es, and it catalogs
pnpm crowdin:download              # extracts locales/{fr,es,it}/app.ftl
```

The same commands are available as "Epikrise: Crowdin ..." tasks in `.vscode/tasks.json`.

A download ran cleanly and changed no repo files. A synthetic `ui-provider-rejected` translation confirmed that `{ $status }` survives Crowdin storage, and it was deleted afterwards.

## Templates and test data

Never commit real or realistic clinical material, not even as a test fixture. The `templates/` and `fixtures/clinical/` directories are git-ignored for this reason. Fixtures used by tests must be synthetic.

## Reporting security issues

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Do not open a public issue, especially for anything that could expose clinical content.
