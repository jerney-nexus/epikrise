---
name: full-suite-fix
description: "Use when asked to run the full Epikrise test suite, validate the whole project, or get all test and quality gates green. Fix actionable issues discovered by UI, i18n, Rust, Playwright, checks, lint, or dependency audits. Do not use for user-suggested issues or a single focused test or check; use the investigate skill for one user-suggested issue."
allowed-tools: Read, Grep, Glob, Edit, Bash(git status:*), Bash(git diff:*), Bash(pnpm test), Bash(pnpm test:*), Bash(pnpm check), Bash(pnpm check:*), Bash(pnpm lint), Bash(pnpm audit:*), Bash(git add:*), Bash(git commit:*)
---

# Full Suite and Fix

Run Epikrise's complete test and quality gates, repair actionable failures at their root cause, and verify the fixes without hiding new diagnostics.

## Procedure

1. Read [AGENTS.md](../../../AGENTS.md) and follow its repository and testing requirements. Check the worktree before changing files so existing user changes remain untouched. This skill's scope is limited to issues discovered by its full-suite gates; do not take user-suggested issues as additional work. If the full-suite request or acceptance criteria are unclear, pause and ask the user for guidance before running tests or editing code.
2. Establish the accepted baseline before running or editing. Search [TODO.md](../../../TODO.md), CI configuration, and nearby test documentation for issues explicitly recorded as known and accepted. Exclude only issues already documented as accepted. A repeated, flaky, inconvenient, or environment-specific failure is not automatically accepted.
3. Run the project gates from the repository root:
   - `pnpm test` for UI, internationalization, Rust, and Playwright browser tests.
   - `pnpm check` for UI and Rust checks, including formatting, Clippy, and dependency policy checks.
   - `pnpm lint` for ESLint diagnostics.
   - `pnpm audit:pnpm` and `pnpm audit:rust` for JavaScript and Rust dependency vulnerabilities.
4. As each failure, warning, or other issue is identified, immediately add or update its entry in [TODO.md](../../../TODO.md) before investigating further. Include the command or source, concise evidence, and current status. Group entries first by issue class (for example, Bug Fixes, Enhancements, Maintenance, Security, Documentation, or Release), then by urgency; order urgency subsections High, Medium, then Low, with unprioritized items last only when urgency cannot yet be assessed. Put each issue under one class and urgency, updating a matching existing entry instead of duplicating it. Compare the issue with the accepted baseline, but do not suppress or omit new or undocumented issues.
5. When multiple unrelated actionable issues are found, handle each independently. Inspect its owning code, reproduce it with the narrowest relevant test or check, and fix the underlying cause with the smallest focused change. Preserve assertions and test coverage; do not skip tests, weaken checks, broadly silence warnings, or edit generated output to make a gate pass.
6. After each fix, rerun its focused check. If it passes, remove that resolved issue's entry from [TODO.md](../../../TODO.md), preserving all unrelated entries. Also remove its urgency subsection if it is now empty, and remove its issue-class section if it has no remaining subsections. Then stage and commit the issue's fix as a separate commit using repository commit conventions. Stage only files or hunks belonging to that fix; never include unrelated or pre-existing worktree changes. If the issue's changes cannot be safely isolated for a commit, pause and ask the user how to proceed. After all fixes are committed, rerun every gate in step 3; do not report the suite as green if any required gate was skipped or failed.
7. If a failure is demonstrably environmental or outside the requested scope, do not disguise it as accepted: keep its [TODO.md](../../../TODO.md) entry with evidence and blocker status, and report the gate as blocked or failing. If an undocumented issue may be intentionally accepted, ask the user before excluding it.
8. Before finishing, verify that every unresolved issue discovered during the run remains documented in [TODO.md](../../../TODO.md), and that every issue resolved and focused-verified during the run has been removed. Preserve existing entries unrelated to this run. If the appropriate disposition or scope of a TODO entry is unclear, ask the user.
9. Summarize the gates run and their results, fixes and commits made, and every excluded, blocked, or unresolved issue. Cite the documentation supporting each accepted exclusion and confirm the TODO ledger reflects current status.

## Safety Boundaries

- Preserve unrelated worktree changes and never commit secrets, API keys, real patient data, prompts, or generated clinical output.
- Do not hand-edit generated files in `build/`, `src-tauri/target/`, or generated bindings.
- Keep fixes within the failing behavior; avoid unrelated cleanup or test infrastructure changes.
- Update [TODO.md](../../../TODO.md) as issues arise and remove only entries resolved and verified during this run; preserve unrelated existing entries.
- Do not change the accepted baseline by adding a new exception unless the user explicitly approves it.
