# Accessibility

This guide describes the accessibility checks contributors can use when changing Epikrise. Automated checks cover selected screens and states; they are not a complete accessibility evaluation or proof of conformance to a standard.

## Automated checks

Run the selected Playwright accessibility tests with:

```sh
pnpm test:a11y
```

The selected tests in `tests/e2e/accessibility.spec.ts` run axe checks tagged for WCAG 2.0, 2.1, and 2.2 Level A and AA on onboarding, the workspace and settings, updater confirmation, template and egress dialogs, and reviewed output controls. The selection also checks a 960-by-640 viewport, settings-dialog focus trapping and restoration, and German and pseudo-locale layouts at the minimum viewport. The tests request reduced motion.

These automated checks only inspect the states they visit. They do not cover every workflow, assistive technology, browser, language, display configuration, or user need, and passing them does not establish full WCAG conformance.

## Manual checks

When a change affects the interface, also consider these checks:

- **Keyboard and focus:** Complete the affected workflow using only the keyboard. Check that the tab order is meaningful, focus remains visible, dialogs keep focus while open, and focus returns to the opener when a dialog closes.
- **Screen readers:** Check that controls have understandable names, roles, and states; headings describe the page structure; dialogs and status updates are announced; and instructions are associated with their controls.
- **Zoom and reflow:** Increase browser zoom and narrow the viewport. Check that content remains readable and operable, controls are not obscured, and users do not need unnecessary horizontal scrolling.
- **Color contrast:** Check text, controls, focus indicators, and other meaningful visual information against their backgrounds. Do not rely on color alone to convey meaning.
- **Reduced motion:** Enable the operating system or browser reduced-motion preference and check that nonessential animation is removed or reduced without losing information or functionality.

These checks are a practical review, not a substitute for testing with users or a complete accessibility audit.

## Reporting an issue

Report non-security accessibility problems through a public GitHub issue. Describe the affected screen, steps to reproduce, expected and actual behavior, and relevant assistive technology or display settings. Use synthetic examples only; do not attach patient data, clinical text, or screenshots containing sensitive information.

Report security vulnerabilities privately using the link in the issue chooser or the process in [SECURITY.md](SECURITY.md). Do not report vulnerabilities in a public issue.
