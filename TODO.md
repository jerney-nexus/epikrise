# TODO

## Bug Fixes

### Medium Urgency

- Investigate VS Code Playwright Test Explorer runs leaving the configured dev
  server running. The focused terminal E2E run passed and exited Vite, but this
  environment has no reproducible Test Explorer run or leaked Vite process;
  verify the Explorer lifecycle before adding cleanup logic.

## Release and updater follow-up

### High Urgency

- Provision the Tauri updater signing key through an authorized secure process,
  back it up, and replace the release overlay's `unconfigured` public-key
  placeholder. Do not put the private key or password in the repository or
  command logs.
- Build a separate release contract for target-specific updater packages,
  signatures, `latest.json`, and version-tag publication. Keep it distinct from
  the six-target unsigned diagnostic workflow and preserve padded
  `YYYY.MM.PATCH` release identity.
- Add updater fake-service tests for policy changes after discovery, candidate
  invalidation, install/case races, and signature or payload failures. Existing
  checks cover basic policy gates, version/target validation, URL allowlisting,
  and install-gate exclusion.
- Complete native install and two-version update acceptance on supported
  Linux, macOS, and Windows architectures, including tamper rejection and
  Windows installer-family behavior. Browser mocks do not replace native
  acceptance.
- Decide and complete the separate Store MSIX identity, certification, and
  submission track; Microsoft Store signing and updates are not provided by
  the direct-release updater.

## Enhancements

### Medium Urgency

- Finalize the initial-release changelog policy; use only `Added` entries if
  required for the first release and review the current `Changed`/`Fixed`
  sections before release.
- Search the institutional template for output rules and patterns.
- Use MiniJinja placeholders in the institutional template.

### Low Urgency

- Implement help page for the application.
- Allow creating and deleting templates directly from template settings, each subject to
  policy restrictions.
- Add feature to handle date formatting via template strings/localization.
- Add support for the Gemini Interactions API as soon as `genai` v0.7.0 is released.
- Add native Windows build and acceptance support; Windows packaging currently
  relies on Linux cross-compilation and still needs native runtime validation.
