# AI-assisted material disclosure

This file records AI-assisted material in the Flatpak packaging, following the [Flathub generative AI policy](https://docs.flathub.org/docs/for-app-authors/requirements#generative-ai-policy). It is kept current so a future Flathub submission has the facts ready.

Status: the Flatpak bundles are built and attested in GitHub Actions and are not submitted to Flathub. Under Flathub policy, the manifest in this directory must not contain AI-generated or AI-assisted content before any Flathub submission.

## AI-assisted files (issue #185, branch `issue-185-flatpak-release`)

Each commit on this branch that touched these files has a Copilot `Co-authored-by` trailer.

- `flatpak/nexus.jerney.epikrise.yml`: Flatpak manifest. Written with AI assistance. Not for Flathub submission in its current form.
- `flatpak/nexus.jerney.epikrise.desktop`: desktop entry. AI-assisted.
- `flatpak/nexus.jerney.epikrise.metainfo.xml`: AppStream metadata. AI-assisted.
- `.github/workflows/flatpak.yml`: reusable Flatpak build workflow. AI-assisted.
- `.github/workflows/desktop-builds.yml`, `.github/workflows/signed-release.yml`: Flatpak job wiring. AI-assisted.
- `scripts/desktop-builds.mjs`, `scripts/release-artifacts.mjs`: artifact handling and verification. AI-assisted.
- `tests/tooling.test.ts`: tests for the above. AI-assisted.
- `CHANGELOG.md`: Flatpak entry. AI-assisted.

## Not covered by this file

Application source code outside the files above was not reviewed for this disclosure. Before any Flathub submission, the maintainer must audit the rest of the repository for AI-generated code and extend this list.
