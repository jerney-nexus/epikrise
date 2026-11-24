# Epikrise

[![Quality checks](https://github.com/jerney-nexus/epikrise/actions/workflows/quality-checks.yml/badge.svg?branch=main)](https://github.com/jerney-nexus/epikrise/actions/workflows/quality-checks.yml) [![Rust tests](https://github.com/jerney-nexus/epikrise/actions/workflows/rust-tests.yml/badge.svg?branch=main)](https://github.com/jerney-nexus/epikrise/actions/workflows/rust-tests.yml) [![Frontend tests](https://github.com/jerney-nexus/epikrise/actions/workflows/frontend-tests.yml/badge.svg?branch=main)](https://github.com/jerney-nexus/epikrise/actions/workflows/frontend-tests.yml) [![Security audit](https://github.com/jerney-nexus/epikrise/actions/workflows/security-audit.yml/badge.svg?branch=main)](https://github.com/jerney-nexus/epikrise/actions/workflows/security-audit.yml) [![License: MIT](https://img.shields.io/github/license/jerney-nexus/epikrise)](LICENSE) [![Crowdin](https://badges.crowdin.net/epikrise/localized.svg)](https://crowdin.com/project/epikrise)

A desktop drafting aid that turns user-supplied clinical material into a structured draft for review and manual use in a clinic information system. Epikrise does not anonymize input; remove identifying details before use.

<!-- prettier-ignore -->
> [!IMPORTANT]
> Epikrise is a **drafting aid**, not a medical device and not a diagnostic tool. Every generated text must be reviewed by the responsible clinician before use. See [Safety and scope](https://github.com/jerney-nexus/epikrise/wiki/User-Guide#safety-and-scope).

Project website: [epikrise.jerney.nexus](https://epikrise.jerney.nexus/).

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
| Rust | 1.90+ | stable toolchain, edition 2024 |
| Node.js | 22+ | pnpm 12.15.0, activated through Corepack |
| Platform deps | — | see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) |

A [dev container](.devcontainer/devcontainer.json) with everything preinstalled is included; see [CONTRIBUTING.md](CONTRIBUTING.md).

## Getting started

Before building, complete the operating-system-specific prerequisites in the [Development setup](https://github.com/jerney-nexus/epikrise/wiki/Development-Setup) wiki page.

```sh
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm tauri dev
```

## Documentation

Detailed guides are in the [wiki](https://github.com/jerney-nexus/epikrise/wiki):

- [User Guide](https://github.com/jerney-nexus/epikrise/wiki/User-Guide) — software updates, templates, provider generation settings, interface language, safety and scope, administrator egress policy
- [Installers](https://github.com/jerney-nexus/epikrise/wiki/Installers) — local macOS, Linux, and Windows installers, Dev Container cross-build, uninstall
- [Cross-Platform Builds](https://github.com/jerney-nexus/epikrise/wiki/Cross-Platform-Builds) — native and cross-platform builds, Store `.msixbundle`
- [Testing](https://github.com/jerney-nexus/epikrise/wiki/Testing) — test commands and quality gates
- [Releasing](https://github.com/jerney-nexus/epikrise/wiki/Releasing) — release steps for [Calendar Versioning](https://calver.org) (`YYYY.M.MICRO`)

Also see [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and project layout, and [CHANGELOG.md](CHANGELOG.md) for release history.

## License

[MIT](LICENSE) © Pascal Jerney
