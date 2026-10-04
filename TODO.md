# TODO

## Bug Fixes

### Medium Urgency

- Investigate VS Code Playwright Test Explorer runs leaving the configured dev
  server running. The focused terminal E2E run passed and exited Vite, but this
  environment has no reproducible Test Explorer run or leaked Vite process;
  verify the Explorer lifecycle before adding cleanup logic.

## Release and updater follow-up

### High Urgency

- Complete portable package verification: Windows-hosted x64/ARM64 MSI bundling
  from immutable cross-compiled layouts, stable UpgradeCodes, derived MSI
  versions, offline WebView2 variants for both installer families, and
  architecture/resource/runtime/cache evidence across all six targets. Blocked
  on Windows-hosted bundling and install evidence; this Linux ARM64 environment
  cannot prove those MSI acceptance requirements.
- Updater secret provenance confirmed. A local synthetic signature verified
  against the configured public key, a tampered message was rejected, and the
  authorized holder attested ownership, custody, and recoverable encrypted
  backup. The `release` environment now requires reviewer approval, blocks
  self-review and administrator bypass, and restricts deployments to selected
  version-tag patterns. The authorized holder confirms the environment secret
  was provisioned from this matching key. Never expose or store private-key
  material.
- Verify the first signed updater release from a padded `vYYYY.MM.PATCH` tag,
  including all six target assets, signatures, static `latest.json`, and
  published update URLs before relying on automatic updates.
- Blocked: native install and two-version update acceptance still needs all
  supported Linux, macOS, and Windows hosts. GitHub currently has no releases
  and the updater's `latest.json` endpoint returns 404; this runner is Linux
  ARM64 only. Resume after a signed release is available and native hosts can
  verify tamper rejection and Windows installer-family behavior.
- Decide and complete the separate Store MSIX identity, certification, and
  submission track; Microsoft Store signing and updates are not provided by
  the direct-release updater.

## Enhancements

### Medium Urgency

- Search the institutional template for output rules and patterns.
- Use MiniJinja placeholders in the institutional template.

### Low Urgency

- Implement help page for the application.
- Add feature to handle date formatting via template strings/localization.
- Add support for the Gemini Interactions API as soon as `genai` v0.7.0 is released.
- Add native Windows build and acceptance support; Windows packaging currently
  relies on Linux cross-compilation and still needs native runtime validation.
