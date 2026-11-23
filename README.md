# Epikrise

[![Quality checks](https://github.com/jerney-nexus/epikrise/actions/workflows/quality-checks.yml/badge.svg?branch=main)](https://github.com/jerney-nexus/epikrise/actions/workflows/quality-checks.yml) [![Rust tests](https://github.com/jerney-nexus/epikrise/actions/workflows/rust-tests.yml/badge.svg?branch=main)](https://github.com/jerney-nexus/epikrise/actions/workflows/rust-tests.yml) [![Frontend tests](https://github.com/jerney-nexus/epikrise/actions/workflows/frontend-tests.yml/badge.svg?branch=main)](https://github.com/jerney-nexus/epikrise/actions/workflows/frontend-tests.yml) [![Security audit](https://github.com/jerney-nexus/epikrise/actions/workflows/security-audit.yml/badge.svg?branch=main)](https://github.com/jerney-nexus/epikrise/actions/workflows/security-audit.yml) [![License: MIT](https://img.shields.io/github/license/jerney-nexus/epikrise)](LICENSE) [![Crowdin](https://badges.crowdin.net/epikrise/localized.svg)](https://crowdin.com/project/epikrise)

A desktop drafting aid that turns user-supplied clinical material into a structured draft for review and manual use in a clinic information system. Epikrise does not anonymize input; remove identifying details before use.

<!-- prettier-ignore -->
> [!IMPORTANT]
> Epikrise is a **drafting aid**, not a medical device and not a diagnostic tool. Every generated text must be reviewed by the responsible clinician before use. See [Safety and scope](https://github.com/jerney-nexus/epikrise/wiki/User-Guide#safety-and-scope).

## What it does

Paste text or images, import documents, or provide a URL. Epikrise extracts text from plain-text files, PDF, DOCX, XLSX, RTF and HTML. PNG/JPEG images and sparse PDF pages can use local OCR or, when enabled and supported by the selected model, vision analysis. Images are limited to 20 MB, 8,192 pixels in width and in height, and 128 MB of decoded pixel data; larger images are rejected, and an image that cannot be decoded is reported as an invalid image. URLs are fetched and converted to readable text. Text clipboard access uses Tauri's clipboard plugin; image paste is handled by the webview and sent to Rust over IPC.

The extracted material and your template are sent to the selected model. The app supports OpenAI, Anthropic, Gemini, Ollama, OpenAI-compatible endpoints, OpenRouter, xAI and Groq. It can discover models, check a connection, stream a draft, and cancel generation. Findings can be added in several rounds and integrated cumulatively. Template-defined output checks are shown as warnings, with an option to regenerate with corrections.

Only connections through the providers' APIs are supported, so an API key is required for each provider you use, except Ollama and other local endpoints.

The desktop workspace separates clinical inputs, generated output, and draft controls. Input rows show provenance, extraction method, round, content type, and character count. Provider credentials and endpoint settings are managed in a dialog; templates can be edited with a live rendered MiniJinja preview. Output has plain and formatted preview modes.

The result can be copied to the clipboard only after the clinician reviews and acknowledges the current output. Copy writes formatted HTML with the approved text as a plain-text fallback. It is pasted manually into the target system; Epikrise does not connect to a hospital information system.

## Privacy posture

- **No hosted backend, telemetry or account.** The desktop app processes input locally except for requests sent to the configured model endpoint.
- **Case content is not saved as history.** Case inputs and generated output are held in process memory; Rust-owned case state is cleared when a case is discarded or the app exits. OCR may create temporary image files in private temporary directories; those files are overwritten before removal, and abandoned directories are cleaned up on a later launch. The OS and runtime may retain copies, so forensic erasure cannot be guaranteed.
- **Templates and credentials persist separately.** Imported templates are stored by the app; API keys are stored in the OS keychain. Provider choice, model, endpoint, output limit and reasoning settings are not persisted by the current UI.
- **Remote endpoints receive your input.** OpenAI, Anthropic, Gemini, xAI, Groq, OpenRouter and any remote OpenAI-compatible or Ollama endpoint receive the material included in a request. Ollama is local only when its configured endpoint is local. The active provider and endpoint are shown in the controls rail. Before the first remote generation in each case, Epikrise asks you to confirm the provider and endpoint that will receive the case and template.
- **Anonymization is your responsibility.** Epikrise does not de-identify anything and does not attempt to detect identifying data.

The full privacy policy is available in [English](docs/privacy-policy.en.md), [Deutsch](docs/privacy-policy.de.md), [Français](docs/privacy-policy.fr.md), [Italiano](docs/privacy-policy.it.md) and [Español](docs/privacy-policy.es.md).

## Requirements

| Tool | Version | Notes |
| --- | --- | --- |
| Rust | 1.98+ | stable toolchain, edition 2024 |
| Node.js | 22+ | pnpm 12.15.0, activated through Corepack |
| Platform deps | — | see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) |

A [dev container](.devcontainer/devcontainer.json) with everything preinstalled is included; see [CONTRIBUTING.md](CONTRIBUTING.md).

## Getting started

Before building, complete the operating-system-specific prerequisites in [Local native setup](CONTRIBUTING.md#local-native-setup). In particular, a native build needs Tesseract and German (`deu`), English (`eng`), French (`fra`), Italian (`ita`), and Spanish (`spa`) language data. The build compiles its own Tesseract sidecar, but uses the installed Tesseract command to locate that data.

```sh
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm tauri dev
```

### Installers

Local installers for macOS, Linux, and Windows, the Dev Container cross-build, and uninstall steps are in the [Installers wiki page](https://github.com/jerney-nexus/epikrise/wiki/Installers).

## Software updates

Update behavior, administrator policy, and Linux package-manager notes are in the [User Guide](https://github.com/jerney-nexus/epikrise/wiki/User-Guide#software-updates) wiki page.

## Testing

Test commands and coverage are in the [Testing](https://github.com/jerney-nexus/epikrise/wiki/Testing) wiki page.

## Templates

Template import, conversion, and format details are in the [User Guide](https://github.com/jerney-nexus/epikrise/wiki/User-Guide#templates) wiki page.

## Provider generation settings

Output-token limits and reasoning effort are described in the [User Guide](https://github.com/jerney-nexus/epikrise/wiki/User-Guide#provider-generation-settings) wiki page.

## Interface language

Language and theme options are described in the [User Guide](https://github.com/jerney-nexus/epikrise/wiki/User-Guide#interface-language) wiki page.

## Safety and scope

Read [Safety and scope](https://github.com/jerney-nexus/epikrise/wiki/User-Guide#safety-and-scope) before using Epikrise. Administrator egress policy is in the [User Guide](https://github.com/jerney-nexus/epikrise/wiki/User-Guide#administrator-egress-policy) wiki page.

## Versioning

Epikrise uses [Calendar Versioning](https://calver.org). Versions follow **`YYYY.M.MICRO`**; for example, `2026.10.0` is the first release of October 2026, and the final number counts fixes within that month. Release steps are in the [Releasing](https://github.com/jerney-nexus/epikrise/wiki/Releasing) wiki page.

## Documentation

- [Wiki](https://github.com/jerney-nexus/epikrise/wiki) — user guide, installers, native and cross-platform builds, testing, and releasing
- [CONTRIBUTING.md](CONTRIBUTING.md) — development setup, project layout, quality gates
- [CHANGELOG.md](CHANGELOG.md) — release history

## License

[MIT](LICENSE) © Pascal Jerney
