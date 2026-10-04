---
name: parallel-investigate
description: "Investigate and fix multiple user-defined bugs or issues in parallel using separate, low-cost subagents. Use when a request contains several independent issues; serialize overlapping work and verify each fix with focused checks. Do not use for single issues or broad repository surveys."
argument-hint: "List each issue, expected outcome, and any reproduction details"
user-invocable: true
---

# Parallel Investigate

Use this workflow when the user asks to investigate and fix multiple distinct issues. Each issue remains a separate `/investigate` task; this skill coordinates delegation, shared repository state, and final verification. Do not use it for a single issue or a request to run the full suite.

## Procedure

1. **Normalize the issue list.** Give each issue a short identifier and preserve the user's expected outcome, reproduction steps, and constraints. Ask only about issues that are not actionable without clarification. Do not invent additional issues from incidental findings.
2. **Load shared context once.** Read [AGENTS.md](../../../AGENTS.md), [the single-issue investigate workflow](../investigate/SKILL.md), and [TODO.md](../../../TODO.md). Check `git status` and existing changes before editing. Preserve user work and do not claim ownership of pre-existing modifications.
3. **Check independence.** Identify likely owning areas and shared resources. Issues touching the same files, behavior contract, tests, or setup are not independent: combine them into one worker task if they form one outcome, otherwise serialize them. Keep unrelated issues parallel. Never launch workers that may edit the same file concurrently.
4. **Record the issues once.** Before investigation, add or update each accepted issue in `TODO.md` following the single-issue workflow's grouping and urgency rules. The coordinator owns this shared file throughout; workers must not edit it.
5. **Delegate narrowly and concurrently.** Use [`issue-worker`](../../agents/issue-worker.agent.md) with `runSubagent` once per independent issue, launching those calls in parallel when the tool supports it and capacity allows. Select the lowest-cost capable model available. Give each worker only its issue, expected outcome, reproduction steps, constraints, relevant repository instructions, and any known owning paths. Ask it to follow `/investigate` for that issue, trace the root cause, make the smallest fix in its disjoint files, and run the narrowest relevant check. Workers must not edit `TODO.md`, stage files, commit, or delegate further. Avoid broad repository surveys and unrelated cleanup.
6. **Require compact worker reports.** Each worker returns only: issue identifier, root cause, changed files, focused check and result, and blockers or cross-issue risks. If an issue cannot be verified, it must say so and leave its code changes clearly identified.
7. **Integrate serially.** Review every worker's changes against the stated outcome and inspect the combined diff. Resolve conflicts or dependent fixes in the coordinator rather than asking workers to overwrite one another. Run focused checks for the combined touched slice where practical. Do not expand into the full suite unless requested or required by repository instructions.
8. **Close out each issue.** Remove only verified-resolved entries from `TODO.md`, preserving unresolved issues and unrelated entries. Commit resolved issues separately only when each issue's changes can be safely isolated and the worktree contains no unrelated changes that would be staged. The coordinator performs staging and commits serially. If changes cannot be isolated safely, do not commit; report the blocker and ask how to proceed.
9. **Summarize per issue.** Report each issue's outcome, changed area, focused check result, and commit if made. Explicitly identify unresolved issues, verification gaps, and anything serialized because of overlap.

## Safety Boundaries

- Keep each worker focused on exactly one issue and its smallest root-cause fix.
- Parallelize only independent edits. Shared files, `TODO.md`, the Git index, and commits have one coordinator owner.
- Preserve unrelated worktree changes; never stage or commit them.
- Do not weaken assertions or checks, and do not fix unrelated findings as part of a worker task.
- Follow repository restrictions on secrets, patient data, prompts, generated files, and other protected assets.
- If a worker discovers another issue, report it to the coordinator; do not silently add it to the task or fix it.
