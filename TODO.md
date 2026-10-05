# TODO

## Release and updater follow-up

### High Urgency

- Verify the first signed updater release from a padded `vYYYY.MM.PATCH` tag,
  including all six target assets, signatures, static `latest.json`, and
  published update URLs before relying on automatic updates.
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
