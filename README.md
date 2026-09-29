# Epikrise

A local-only desktop assistant that turns anonymized clinical material into a
strictly formatted diagnosis and findings list, ready to be pasted into a
clinic information system.

> [!IMPORTANT]
> Epikrise is a **drafting aid**, not a medical device and not a diagnostic
> tool. Every generated text must be reviewed by the responsible clinician
> before use. See [Safety and scope](#safety-and-scope).

## What it does

You drop in raw material — free text, documents, screenshots, clipboard
contents or a URL — and Epikrise extracts the text, sends it to an LLM provider
of your choosing together with your own formatting template, and returns a
structured list. Findings can be added in several rounds; each round is
integrated cumulatively into one document.

The result is copied to the clipboard and pasted manually into the target
system. Epikrise never talks to a hospital information system.

## Privacy posture

- **No backend.** The app runs entirely on your machine. There is no server
  component, no telemetry and no account.
- **Clinical content is never written to disk.** Case material lives in memory
  for the lifetime of a session and is wiped when the session is cleared or the
  app exits. Only templates, settings and API keys persist.
- **API keys live in the OS keychain**, never in a config file.
- **Cloud providers still see your input.** If you configure OpenAI, Anthropic,
  Gemini, Grok, Groq or OpenRouter, the text you supply is transmitted to them.
  Use a local provider such as Ollama if that is unacceptable. The UI always
  names the exact endpoint that will receive the data.
- **Anonymization is your responsibility.** Epikrise does not de-identify
  anything and does not attempt to detect identifying data.

## Requirements

| Tool          | Version | Notes                                                                |
| ------------- | ------- | -------------------------------------------------------------------- |
| Rust          | 1.98+   | stable toolchain, edition 2024                                       |
| Node.js       | 22+     | npm is the package manager; pnpm is not used                         |
| Platform deps | —       | see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) |

A [dev container](.devcontainer/devcontainer.json) with everything preinstalled
is included; see [CONTRIBUTING.md](CONTRIBUTING.md).

## Getting started

```sh
npm install
npm run tauri dev
```

To produce installers for the current platform:

```sh
npm run tauri build
```

Tauri must be able to find `cargo` on `PATH`. If the build fails while running
`cargo metadata` with “No such file or directory”, see the [local Rust setup
instructions](CONTRIBUTING.md#local-setup).

## Templates

No clinical templates ship with Epikrise. The formatting rules used in a
hospital encode institutional know-how and stay with the institution, so the
app ships only a minimal generic starter template.

On first run you are asked to import your own template as an `.epitpl` file.
A template defines the system prompt, its variables, the toggleable sections
per specialty, and the output rules to apply to generated responses.

To convert a plain-text prompt locally, provide section labels explicitly:

```sh
npm run template:convert -- templates/prompt.txt templates/imported.epitpl \
  --name "Institutional template" --locale de-CH \
  --section diagnoses=Diagnosen --section findings=Befunde
```

The converter preserves the prompt text, creates enabled sections from the
provided labels, and refuses to overwrite an existing output unless `--force`
is supplied. It does not infer template variables; prompts containing MiniJinja
expressions must be converted manually. Both `templates/` and `.epitpl` files
are ignored by Git.

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

## Safety and scope

Epikrise formats text. It does not interpret findings, does not suggest
diagnoses, and makes no claim of conformity with MDR, IVDR or any comparable
regulation. Output cannot be copied until you explicitly confirm that you have
reviewed it, and that confirmation is reset whenever the output changes.

Material you ingest — especially fetched web pages — is untrusted input that
may contain text crafted to influence the model. Epikrise labels and delimits
every block to mitigate this, but the mitigation is not a guarantee. Review the
output.

## Documentation

- [CONTRIBUTING.md](CONTRIBUTING.md) — development setup, project layout, quality gates
- [CHANGELOG.md](CHANGELOG.md) — release history

## License

[MIT](LICENSE) © Pascal Jerney
