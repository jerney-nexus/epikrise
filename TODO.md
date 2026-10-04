# TODO

## Bug Fixes

### Medium Urgency

- Investigate VS Code Playwright Test Explorer runs leaving the configured dev
  server running. The focused terminal E2E run passed and exited Vite, but this
  environment has no reproducible Test Explorer run or leaked Vite process;
  verify the Explorer lifecycle before adding cleanup logic.

## Release and updater follow-up

### High Urgency

- Verify the first signed updater release from a padded `vYYYY.MM.PATCH` tag,
  including all six target assets, signatures, static `latest.json`, and
  published update URLs before relying on automatic updates.
- Complete native install and two-version update acceptance on supported
  Linux, macOS, and Windows architectures, including tamper rejection and
  Windows installer-family behavior. Browser mocks do not replace native
  acceptance.
- Decide and complete the separate Store MSIX identity, certification, and
  submission track; Microsoft Store signing and updates are not provided by
  the direct-release updater.

## Enhancements

### Medium Urgency

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
