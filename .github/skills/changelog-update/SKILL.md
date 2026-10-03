---
name: changelog-update
description: "Review recent undocumented project work and update CHANGELOG.md. Use when recording recent changes, preparing an unreleased changelog entry, or checking whether completed work is documented."
---

# Changelog Update

Update `CHANGELOG.md` with recent, user-relevant work that is not documented yet. Keep entries accurate, concise, and consistent with the existing format.

## Procedure

1. Read `AGENTS.md`, `CHANGELOG.md`, and relevant release/versioning guidance. Follow repository-specific instructions and the changelog's existing format.
2. Inspect `git status --short` without changing the worktree. Find recent commits since the last change to `CHANGELOG.md` and inspect their diffs. Also inspect staged and unstaged diffs for completed work that may belong in the changelog. Do not treat commit messages alone as evidence.
3. Exclude generated files, internal maintenance with no user-visible impact, unfinished or uncertain work, and any secrets or real patient data. If the status or intent of a change is unclear, ask before documenting it. Never stage, discard, or rewrite the user's changes.
4. Compare the verified work against existing entries to avoid duplication. Add only missing changes under the existing `[Unreleased]` heading, or create it using the file's conventions if absent. Do not rewrite unrelated history, release links, or sections.
5. Determine whether a first versioned release has occurred by checking for versioned release tags, verifiable published releases, and versioning guidance. Either a release tag or a published release confirms that the first release has happened. Before the first release, put all documented work only under `### Added`; do not create `Changed`, `Fixed`, or other categories. After the first release, group entries under meaningful Keep a Changelog categories such as `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, or `Security`, and omit empty categories.
6. Write brief, user-facing entries that describe outcomes rather than implementation trivia. Preserve the existing Markdown style and wrap long bullets consistently.
7. Review `git diff -- CHANGELOG.md` to confirm every entry is supported, non-duplicative, and in the right category. Run `pnpm format:check:file CHANGELOG.md` if available; report any check that cannot run.

## Completion Criteria

- Every new entry is supported by an inspected diff or other clear project evidence.
- No already-documented, generated, speculative, or sensitive material is included.
- The pre-first-release rule is applied based on tag or published-release evidence, and only relevant categories are present.
- The diff contains only the intended changelog update.
