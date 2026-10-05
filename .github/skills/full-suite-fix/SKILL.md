---
name: full-suite-fix
description: "Use when asked to run the full Epikrise test suite, validate the whole project, or get all test and quality gates green. Fix actionable issues discovered by UI, i18n, Rust, Playwright, checks, lint, or dependency audits. Do not use for user-suggested issues or a single focused test or check; use the investigate skill for one user-suggested issue."
allowed-tools: Read, Grep, Glob, Edit, Bash(git status:*), Bash(git diff:*), Bash(pnpm test), Bash(pnpm test:*), Bash(pnpm check), Bash(pnpm check:*), Bash(pnpm lint), Bash(pnpm audit:*), Bash(git add:*), Bash(git commit:*), Bash(gh issue:*), Bash(gh pr:*), Bash(gh label:*), Bash(gh project:*), Bash(gh api:*), Bash(gh auth status:*), mcp_github_mcp_se_get_me, mcp_github_mcp_se_search_issues, mcp_github_mcp_se_issue_read, mcp_github_mcp_se_issue_write, mcp_github_mcp_se_add_issue_comment, mcp_github_mcp_se_list_issue_types, mcp_github_mcp_se_list_issue_fields, mcp_github_mcp_se_sub_issue_write, mcp_github_mcp_se_search_pull_requests, mcp_github_mcp_se_pull_request_read, mcp_github_mcp_se_update_pull_request
---

# Full Suite and Fix

Run Epikrise's complete test and quality gates, repair actionable failures at their root cause, and verify the fixes without hiding new diagnostics.

## Procedure

1. Read [AGENTS.md](../../../AGENTS.md) and follow its repository and testing requirements. Check the worktree before changing files so existing user changes remain untouched. This skill's scope is limited to issues discovered by its full-suite gates; do not take user-suggested issues as additional work. If the full-suite request or acceptance criteria are unclear, pause and ask the user for guidance before running tests or editing code.
2. Establish the accepted baseline before running or editing. Review CI configuration, nearby test documentation, and existing GitHub issues for failures explicitly documented as accepted. For GitHub MCP, call `get_me` before searching. Do not treat an issue as accepted merely because it is open, previously reported, flaky, inconvenient, or environment-specific; require explicit acceptance in its description or discussion.
3. Run the project gates from the repository root:
   - `pnpm test` for UI, internationalization, Rust, and Playwright browser tests.
   - `pnpm check` for UI and Rust checks, including formatting, Clippy, and dependency policy checks.
   - `pnpm lint` for ESLint diagnostics.
   - `pnpm audit:pnpm` and `pnpm audit:rust` for JavaScript and Rust dependency vulnerabilities.
4. As each failure, warning, or other actionable issue is identified, search this repository's GitHub issues using its symptom and relevant command, then inspect candidate issues to avoid duplicates. Reuse a matching open issue; reopen a matching closed issue only if the same failure is recurring. Search and inspect directly related PRs as well, then create or update issue metadata and reciprocal issue–PR references using [the investigate workflow](../investigate/SKILL.md). Include the failing command or source, concise evidence, and expected outcome in a new issue. Do not overwrite existing descriptions; use comments for progress. Use closing keywords only when the linked PR fully resolves the issue. Compare each finding with the accepted baseline, but do not suppress or omit new or undocumented issues. If MCP tools are unavailable, use authenticated `gh issue` and `gh pr` commands plus `gh api` for supported relationships. If neither route can track findings, stop and report the blocker; do not use `TODO.md` as a fallback.
5. When multiple unrelated actionable issues are found, handle each independently. Inspect its owning code, reproduce it with the narrowest relevant test or check, and fix the underlying cause with the smallest focused change. Preserve assertions and test coverage; do not skip tests, weaken checks, broadly silence warnings, or edit generated output to make a gate pass.
6. After each fix, rerun its focused check. If it passes, the coordinator stages and commits only that issue's changes when they can be safely isolated, using a separate commit. Never include unrelated or pre-existing worktree changes. Close the issue with reason `completed` only after its fix has reached the default branch. If its fix is awaiting a linked PR merge, keep it open and rely on the PR closing keyword after merge. If changes cannot be safely isolated for a commit, do not stage or commit and report the blocker. After all fixes are committed, rerun every gate in step 3; do not report the suite as green if any required gate was skipped or failed.
7. If a failure is demonstrably environmental or outside the requested scope, do not disguise it as accepted: leave its GitHub issue open, add a comment with evidence and blocker status, and report the gate as blocked or failing. If an undocumented issue may be intentionally accepted, ask the user before excluding it.
8. Before finishing, verify that every unresolved issue discovered during the run remains represented by an open GitHub issue, and that every resolved issue is closed unless its fix is awaiting a linked PR merge. Keep those issues open until merge so GitHub can close them through the PR's closing keyword. Preserve unrelated issues and their descriptions. If the appropriate disposition or scope of an issue is unclear, ask the user.
9. Summarize the gates run and their results, fixes and coordinator commits made, and every excluded, blocked, or unresolved issue. Report issue numbers, linked PRs, selected metadata and relationships, any relevant values or links left unset with the reason, and the documentation supporting each accepted exclusion.

## Safety Boundaries

- Preserve unrelated worktree changes and never commit secrets, API keys, real patient data, prompts, or generated clinical output.
- Do not hand-edit generated files in `build/`, `src-tauri/target/`, or generated bindings.
- Keep fixes within the failing behavior; avoid unrelated cleanup or test infrastructure changes.
- Keep GitHub issue descriptions intact; use comments for progress and blocker evidence.
- Do not change the accepted baseline by adding a new exception unless the user explicitly approves it.
