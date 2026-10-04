---
name: parallel-investigate
description: "Investigate and fix multiple user-defined bugs or issues in parallel using separate, low-cost subagents. Use when a request contains several independent issues; serialize overlapping work and verify each fix with focused checks. Do not use for single issues or broad repository surveys."
argument-hint: "List each issue, expected outcome, and any reproduction details"
user-invocable: true
allowed-tools: Read, Grep, Glob, Edit, Bash(git status:*), Bash(git diff:*), Bash(pnpm test:*), Bash(pnpm check:*), Bash(pnpm format:check:file:*), Bash(git add:*), Bash(git commit:*), Bash(gh issue:*), Bash(gh label:*), Bash(gh project:*), Bash(gh api:*), Bash(gh auth status:*), mcp_github_mcp_se_get_me, mcp_github_mcp_se_search_issues, mcp_github_mcp_se_issue_read, mcp_github_mcp_se_issue_write, mcp_github_mcp_se_add_issue_comment, mcp_github_mcp_se_list_issue_types, mcp_github_mcp_se_list_issue_fields, mcp_github_mcp_se_sub_issue_write
---

# Parallel Investigate

Use this workflow when the user asks to investigate and fix multiple distinct issues. Each issue remains a separate `/investigate` task; this skill coordinates delegation, shared repository state, and final verification. Do not use it for a single issue or a request to run the full suite.

## Procedure

1. **Normalize the issue list.** Give each issue a short identifier and preserve the user's expected outcome, reproduction steps, and constraints. Ask only about issues that are not actionable without clarification. Do not invent additional issues from incidental findings.
2. **Load shared context once.** Read [AGENTS.md](../../../AGENTS.md) and [the single-issue investigate workflow](../investigate/SKILL.md). Check `git status` and existing changes before editing. Preserve user work and do not claim ownership of pre-existing modifications.
3. **Check independence.** Identify likely owning areas and shared resources. Issues touching the same files, behavior contract, tests, or setup are not independent: combine them into one worker task if they form one outcome, otherwise serialize them. Keep unrelated issues parallel. Never launch workers that may edit the same file concurrently.
4. **Create or identify the issues once.** The coordinator owns all GitHub issue operations. For GitHub MCP, call `get_me` first, search the repository for duplicates, and inspect matching issues. Reuse matching open issues; reopen a matching closed issue only when the reported behavior is demonstrably recurring. Create one issue per accepted task before delegation, including its expected outcome, reproduction details, and constraints. Apply the metadata and relationship checklist in [the investigate workflow](../investigate/SKILL.md) to each new or reused issue before delegation. Do not overwrite existing reports; use comments for progress. If MCP issue tools are unavailable, use authenticated `gh issue` commands. If neither route is available, stop and report the blocker; do not use `TODO.md` as a fallback.
5. **Delegate narrowly and concurrently.** Use [`issue-worker`](../../agents/issue-worker.agent.md) with `runSubagent` once per independent issue, launching those calls in parallel when the tool supports it and capacity allows. Select the lowest-cost capable model available. Give each worker only its issue number, expected outcome, reproduction steps, constraints, relevant repository instructions, and any known owning paths. Ask it to follow `/investigate` for that issue, trace the root cause, make the smallest fix in its disjoint files, and run the narrowest relevant check. Workers must not create or update GitHub issues, edit `TODO.md`, stage files, commit, or delegate further. Avoid broad repository surveys and unrelated cleanup.
6. **Require compact worker reports.** Each worker returns only: issue number, root cause, changed files, focused check and result, and blockers or cross-issue risks. If an issue cannot be verified, it must say so and leave its code changes clearly identified.
7. **Integrate serially.** Review every worker's changes against the stated outcome and inspect the combined diff. Resolve conflicts or dependent fixes in the coordinator rather than asking workers to overwrite one another. Run focused checks for the combined touched slice where practical. Do not expand into the full suite unless requested or required by repository instructions.
8. **Close out each issue.** After focused verification succeeds, the coordinator closes that GitHub issue with reason `completed`. Leave unresolved or unverified issues open and add a concise comment with evidence and blocker status. Commit resolved issues separately only when each issue's changes can be safely isolated and the worktree contains no unrelated changes that would be staged. The coordinator performs staging and commits serially. If changes cannot be isolated safely, do not commit; report the blocker and ask how to proceed.
9. **Summarize per issue.** Report each issue's outcome, issue number, selected metadata and relationships, any relevant values or links left unset with the reason, changed area, focused check result, and commit if made. Explicitly identify unresolved issues, verification gaps, and anything serialized because of overlap.

## Safety Boundaries

- Keep each worker focused on exactly one issue and its smallest root-cause fix.
- Parallelize only independent edits. Shared files, GitHub issue operations, the Git index, and commits have one coordinator owner.
- Preserve existing GitHub issue descriptions; record progress, findings, and blockers in comments.
- Preserve unrelated worktree changes; never stage or commit them.
- Do not weaken assertions or checks, and do not fix unrelated findings as part of a worker task.
- Follow repository restrictions on secrets, patient data, prompts, generated files, and other protected assets.
- If a worker discovers another issue, report it to the coordinator; do not silently add it to the task or fix it.
