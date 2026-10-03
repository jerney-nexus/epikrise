---
name: investigate
description: "Use when the user describes or suggests one specific bug or issue and wants it investigated and fixed. Treat that report as the sole goal, implement the smallest root-cause fix, and verify it with focused checks. Do not use for running the full project suite."
argument-hint: "Describe one issue to investigate and fix"
---

# Investigate One Issue

Resolve exactly one issue suggested by the user. Keep the work bounded to that goal; do not turn unrelated findings into additional fixes.

## Procedure

1. Read [AGENTS.md](../../../AGENTS.md) and follow the repository requirements. Check the worktree and read [TODO.md](../../../TODO.md) before editing so existing work and issue entries are preserved.
2. Confirm the user supplied one actionable issue and its expected outcome is clear. If the request is ambiguous, lacks a necessary decision, or contains multiple unrelated issues, pause and ask the user to clarify or choose the single goal.
3. Add or update the issue in [TODO.md](../../../TODO.md) as soon as it is identified, before investigating further. Include concise evidence or the observed behavior; update a matching entry instead of duplicating it.
4. Trace the issue to its owning code and reproduce it with the narrowest relevant test or check. Implement the smallest root-cause fix that satisfies the stated outcome. Do not make unrelated changes or weaken assertions, tests, or checks.
5. Run the focused test or check. If it passes, remove this resolved issue's entry from [TODO.md](../../../TODO.md), preserving unrelated entries, then stage and commit only this issue's changes as a separate commit using repository conventions. If changes cannot be safely isolated from unrelated worktree changes, pause and ask the user how to proceed.
6. If the issue cannot be resolved or verified, keep its [TODO.md](../../../TODO.md) entry with concise evidence and blocker status. Report the limitation rather than claiming success.
7. Summarize the fix, focused checks and results, commit, and any blocker. If an unrelated issue surfaced, record it in [TODO.md](../../../TODO.md) but do not expand this task to fix it.

## Safety Boundaries

- Preserve unrelated worktree changes; never stage or commit them.
- Never commit secrets, API keys, real patient data, prompts, or generated clinical output.
- Do not hand-edit generated files in `build/`, `src-tauri/target/`, or generated bindings.
- Keep [TODO.md](../../../TODO.md) current for this issue and preserve all unrelated existing entries.
