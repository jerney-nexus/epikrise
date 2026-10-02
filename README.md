# Epikrise

A desktop drafting aid that turns user-supplied clinical material into a
structured draft for review and manual use in a clinic information system.
Epikrise does not anonymize input; remove identifying details before use.

> [!IMPORTANT]
> Epikrise is a **drafting aid**, not a medical device and not a diagnostic
> tool. Every generated text must be reviewed by the responsible clinician
> before use. See [Safety and scope](#safety-and-scope).

## What it does

Paste text or images, import documents, or provide a URL. Epikrise extracts
text from plain-text files, PDF, DOCX, XLSX, RTF and HTML. PNG/JPEG images and
sparse PDF pages can use local OCR or, when enabled and supported by the
selected model, vision analysis. URLs are fetched and converted to readable
text. Text clipboard access uses Tauri's clipboard plugin; image paste is
handled by the webview and sent to Rust over IPC.

The extracted material and your template are sent to the selected model. The
app supports OpenAI, Anthropic, Gemini, Ollama, OpenAI-compatible endpoints,
OpenRouter, xAI and Groq. It can discover models, check a connection, stream a
draft, and cancel generation. Findings can be added in several rounds and
integrated cumulatively. Template-defined output checks are shown as warnings,
with an option to regenerate with corrections.

The desktop workspace separates clinical inputs, generated output, and draft
controls. Input rows show provenance, extraction method, round, content type,
and character count. Provider credentials and endpoint settings are managed in
a dialog; templates can be edited with a live rendered MiniJinja preview.
Output has plain and formatted preview modes.

The result can be copied to the clipboard only after the clinician reviews and
acknowledges the current output. Copy writes formatted HTML with the approved
text as a plain-text fallback. It is pasted manually into the target system;
Epikrise does not connect to a hospital information system.

## Privacy posture

- **No hosted backend, telemetry or account.** The desktop app processes input
  locally except for requests sent to the configured model endpoint.
- **Case content is not saved as history.** Case inputs and generated output
  are held in process memory; Rust-owned case state is cleared when a case is
  discarded or the app exits. OCR may create temporary image files in private
  temporary directories; those files are overwritten before removal, and
  abandoned directories are cleaned up on a later launch. The OS and runtime
  may retain copies, so forensic erasure cannot be guaranteed.
- **Templates and credentials persist separately.** Imported templates are
  stored by the app; API keys are stored in the OS keychain. Provider choice,
  model, endpoint, output limit and reasoning settings are not persisted by the
  current UI.
- **Remote endpoints receive your input.** OpenAI, Anthropic, Gemini, xAI,
  Groq, OpenRouter and any remote OpenAI-compatible or Ollama endpoint receive
  the material included in a request. Ollama is local only when its configured
  endpoint is local. The active provider and endpoint are shown in the controls
  rail. Before the first remote generation in each case, Epikrise asks you to
  confirm the provider and endpoint that will receive the case and template.
- **Anonymization is your responsibility.** Epikrise does not de-identify
  anything and does not attempt to detect identifying data.

## Requirements

| Tool          | Version | Notes                                                                |
| ------------- | ------- | -------------------------------------------------------------------- |
| Rust          | 1.98+   | stable toolchain, edition 2024                                       |
| Node.js       | 22+     | pnpm 12.8.1, activated through Corepack                              |
| Platform deps | —       | see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) |

A [dev container](.devcontainer/devcontainer.json) with everything preinstalled
is included; see [CONTRIBUTING.md](CONTRIBUTING.md).

## Getting started

```sh
corepack enable pnpm
pnpm install
pnpm tauri dev
```

### macOS Installers

Build on macOS after installing the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
and Tesseract with German and English language data. See [Local setup in
CONTRIBUTING.md](CONTRIBUTING.md#local-setup) for OCR setup details:

```sh
pnpm tauri build
```

This creates the macOS app and disk image in
`src-tauri/target/host-<host-triple>/release/bundle/`.

### Linux Installers

Build on Linux after installing the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/),
Tesseract, and German and English language data. The dev container includes
these dependencies. Run:

```sh
pnpm tauri build
```

This creates AppImage, Debian (`.deb`), and RPM packages under
`src-tauri/target/host-<host-triple>/release/bundle/`.

### Windows Installers

#### Local Windows build

Native Windows installer builds are not currently supported by the repository
scripts. The bundled Tesseract OCR sidecar is cross-compiled on Linux ARM64, so
use the dev container instructions below.

#### Dev container build

From the ARM64 Linux dev container, run `pnpm windows:setup` once and review
the Microsoft SDK/CRT license when prompted. Then build one architecture or both
sequentially:

```sh
pnpm windows:build:x64
pnpm windows:build:arm64
pnpm windows:build
```

The installers are written under `src-tauri/target/<target>/release/bundle/nsis/`.
They include local OCR resources and the offline WebView2 installer. Initial
tool and asset downloads require network access; native Windows testing is still
required. See [CONTRIBUTING.md](CONTRIBUTING.md#building-windows-installers).

### Cross-platform Actions builds

`pnpm build:all` dispatches the manual **Desktop builds** GitHub Actions
workflow for the current pushed commit from either an ARM64 or x64 dev
container. It builds Linux ARM64/x64 (`.deb`, `.rpm`, AppImage), macOS
ARM64/x64 (`.dmg`), and Windows ARM64/x64 (NSIS `.exe` with offline WebView2)
in six isolated jobs. The workflow must be enabled on GitHub, and the commit
must contain the workflow. It never commits or pushes changes.

The command requires a clean worktree, the current branch or tag pushed to
`origin` at exactly `HEAD`, the GitHub CLI authenticated with Actions dispatch
and artifact-read permissions, and network access to GitHub Actions. It waits
for all six jobs, then verifies the request ID, commit, version, target, package
completeness and SHA-256 values. Verified manifests and packages are written to
`.artifacts/desktop-builds/<request-id>/`; partial, stale or modified artifacts
are rejected. Each artifact expires after 14 days.

Windows jobs require repository variable
`EPIKRISE_WINDOWS_SDK_LICENSE_APPROVED` to equal `true`. An administrator must
review the pinned Microsoft SDK/CRT license before setting it; the workflow
does not set or infer approval. Missing or invalid approval stops the Windows
setup before any SDK/CRT download. Local `pnpm windows:setup` continues to use
interactive acceptance. The CI builds are unsigned and unnotarized: Windows
SmartScreen and macOS Gatekeeper may warn or block installation. This workflow
does not publish releases or use the separate direct-release updater
configuration. A successful package build is not a substitute for native
installation and synthetic OCR acceptance testing on each target; see
[CONTRIBUTING.md](CONTRIBUTING.md#cross-platform-actions-builds).

## Software updates

The standard application build reports updates as unavailable. The separate
`src-tauri/tauri.release.conf.json` overlay enables updater code for direct
release builds; it does not make a production update channel ready. In an
updater-enabled build, users must opt in under General settings and manually
request each check; there are no background or startup checks. Administrator
policy can prohibit opt-in, checks, and installs. Installing an update requires
a separate confirmation and is blocked while a case or generation is active.
Update requests use the fixed GitHub Releases endpoint and do not send case or
template content.

Tauri updater artifacts require their own signature. This signature verifies
the update payload; it is not Authenticode, Apple Developer ID signing,
notarization, or Linux package signing. The current release overlay still has
an `unconfigured` public-key placeholder, and no production signing key or
release-publication workflow is provisioned. It is not ready for production
updates. See [CONTRIBUTING.md](CONTRIBUTING.md#release-and-update-readiness)
for implementation and release constraints.

Tauri must be able to find `cargo` on `PATH`. If the build fails while running
`cargo metadata` with “No such file or directory”, see the [local Rust setup
instructions](CONTRIBUTING.md#local-setup).

## Testing

For Rust tool prerequisites, including `cargo-deny` required by `pnpm check`,
see [Quality gates in CONTRIBUTING.md](CONTRIBUTING.md#quality-gates). Run the
test suites from the project root:

```sh
pnpm test
pnpm test:coverage
pnpm test:e2e
pnpm test:a11y
```

The combined coverage command runs UI tests with V8 coverage and the Rust
workspace with `cargo-llvm-cov`. It writes an HTML report to
`coverage/index.html` and an LCOV report to `lcov.info`, which is read by the
recommended Coverage Gutters VS Code extension. Use `pnpm test:ui:coverage` or
`pnpm test:rust:coverage` for a targeted coverage run.
Rust tests, Clippy, and Tauri builds keep Cargo artifacts in a host-triple-specific
directory under `src-tauri/target`, so macOS builds and dev-container builds do
not share incompatible host artifacts.

Additional project checks are `pnpm check`, `pnpm build`, `pnpm lint`,
and `pnpm format:check`.

## Templates

No clinical templates ship with Epikrise. The formatting rules used in a
hospital encode institutional know-how and stay with the institution, so the
app ships only a minimal generic starter template.

On first run you can import your own template as an `.epitpl` file or start
from the generic template. `.epitpl` files and the app's `templates.toml`
library use versioned TOML; template objects cross the Rust/UI boundary as
JSON. A template defines the system prompt, its variables, toggleable sections
and output rules. The app validates and previews a template before saving it.
Older JSON `.epitpl` files and an existing `templates.json` library are migrated
when read.

To convert a plain-text prompt locally, provide section labels explicitly:

```sh
  pnpm template:convert templates/prompt.txt templates/imported.epitpl \
  --name "Institutional template" --locale de-CH \
  --section diagnoses=Diagnosen --section findings=Befunde
```

The converter preserves the prompt text, writes TOML, and creates enabled
sections from the labels you provide. It refuses to overwrite an existing output unless `--force`
is supplied. Specialty/category examples are not required defaults; the
converter does not infer sections or template variables, and
prompts containing MiniJinja expressions must be converted manually. Both
`templates/` and `.epitpl` files are ignored by Git.

## Provider generation settings

The provider settings include an output-token limit, defaulting to 8,192 tokens
and configurable from 1 to 1,000,000. This is a ceiling, not a promise that a
provider will return that many tokens; model and provider limits may be lower.
Reasoning tokens can use part of this same output budget, depending on the
provider, so raise the limit or choose a lower reasoning effort if the report
is cut short.

Reasoning effort can be left at the provider default or set to none, minimal,
low, medium, high, extra high, or maximum. These are provider hints: supported
values and their effect vary by provider and model, and unsupported settings may
be ignored or rejected.

## Interface language

The interface defaults to German (Switzerland) and also supports English. On
first launch, Epikrise uses the operating-system language when it is supported;
otherwise it uses the default. Choose a language in General settings to save
an override on this device. Template names, field labels and clinical content
continue to use the locale defined by each template.

Interface messages live in `locales/<locale>/app.ftl`. Keep message IDs aligned
between shipped catalogs and run `pnpm test:i18n` after editing
them. During development, the settings dialog also offers a temporary
pseudo-localized preview to expose untranslated or layout-sensitive text.

## Safety and scope

Epikrise sends material and a template to the selected language model to create
a draft. The model may interpret findings or suggest diagnoses, and its output
may be incomplete or incorrect. Epikrise does not independently validate
clinical correctness and makes no claim of conformity with MDR, IVDR or any
comparable regulation. Output cannot be copied until you explicitly confirm
that you have reviewed it; that confirmation is reset when the output or case
changes.

Material you ingest — especially fetched web pages — is untrusted input that
may contain text crafted to influence the model. Epikrise labels and delimits
every block to mitigate this, but the mitigation is not a guarantee. Review the
output.

## Administrator Egress Policy

IT can install a machine-wide `policy.toml` to restrict providers and URL
ingestion. The app reads it once at startup; the UI cannot loosen it. A malformed
policy prevents startup rather than silently disabling the restrictions.
Supported locations are `/etc/epikrise/policy.toml` on Linux,
`/Library/Application Support/Epikrise/policy.toml` on macOS, and
`%ProgramData%\Epikrise\policy.toml` on Windows. The file and containing
directory should be administrator-owned and not writable by standard users.
Epikrise warns when it cannot verify that protection.
On Linux and macOS, use a root-owned directory (mode `0755`) and policy file
(mode `0644`). On Windows, grant write/modify access only to Administrators
and SYSTEM; standard users should have read access only.

Start from [`policy.example.toml`](policy.example.toml). `allowed_providers`
uses adapter IDs (`open_ai`, `anthropic`, `gemini`, `ollama`,
`open_ai_compatible`, `open_router`, `xai`, `groq`); omitted means all
providers. `local_only = true` additionally restricts endpoints to `localhost`
or a loopback IP, regardless of the allowlist. `allow_url_ingestion = false`
disables URL extraction. In updater-enabled builds, `allow_updater = false`
prevents opting in, checking, or installing updates; standard builds report the
updater as unavailable. Set `allow_template_import`, `allow_template_export`,
or `allow_template_edit` to `false` to block adding templates, exporting
templates, or changing/removing saved templates respectively. These restrictions
are enforced by the backend as well as the settings UI.

`allowed_models` optionally lists exact, case-sensitive model identifiers scoped
by provider, for example `[{ adapter = "ollama", model = "llama3.2" }]`;
omitting it allows every model under the provider policy. `max_output_tokens`
sets a hard ceiling on generated output tokens. `max_reasoning_effort` caps the
selected reasoning effort (`none`, `minimal`, `low`, `medium`, `high`, `x_high`,
or `max`); a provider-default selection is also capped. `fixed_endpoint` forces
all provider operations to use one validated HTTP(S) endpoint, overriding the
endpoint entered in settings. `allow_credential_management = false` prevents
adding or removing credentials from the OS keychain. The review gate remains
mandatory even if a policy sets `require_review_gate = false`.

The webview CSP restricts network connections to Tauri IPC. The app does not
configure clinical-content logging; debug representations of case, extraction,
image and chat payloads redact their contents. Production devtools and the
context menu are disabled.

## Documentation

- [CONTRIBUTING.md](CONTRIBUTING.md) — development setup, project layout, quality gates
- [CHANGELOG.md](CHANGELOG.md) — release history

## License

[MIT](LICENSE) © Pascal Jerney
