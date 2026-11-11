# Releasing Epikrise

This is the short, ordered checklist for cutting a release. The detailed rules live in [CONTRIBUTING.md](CONTRIBUTING.md#commits-and-changelog) under "Commits and changelog" and "Release and update workflow". Check those sections when a step is unclear.

Versions use unpadded CalVer, `YYYY.M.MICRO` (for example `2026.11.1`). Tags use the same version with a `v` prefix (`v2026.11.1`).

## Before you start

- Work from a clean checkout of `main`, with everything you want released merged into it.
- Make sure user-visible changes have entries under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md).
- Have an authenticated GitHub CLI (`gh auth status`) and the pinned `git-cliff` 2.10.1 for local preparation. Install it with `cargo install git-cliff --version 2.10.1 --locked`.

## 1. Prepare the release

Run the **Release preparation** workflow from the Actions tab, or run:

```bash
pnpm release:prepare:workflow [YYYY.M.MICRO]
```

Leave the version blank to select the next CalVer version. The workflow updates the npm, Cargo, and Tauri version metadata, generates release notes, and opens a pull request.

Find that pull request:

```bash
pnpm release:pr
```

This runs `gh pr list --repo=jerney-nexus/epikrise --state=open --search "head:release/"`. The VS Code task is **Epikrise: Find Release Pull Request**.

Its branch is `release/<version>` and its title is `Release <version>`.

## 2. Review and merge the release PR

- Check the version metadata, release notes, and changelog changes.
- Make sure every required check passes, including **Release PR macOS updater bundle smoke**. That gate waits for the macOS updater bundle smoke run on the same head SHA. See [CONTRIBUTING.md](CONTRIBUTING.md#release-and-update-workflow).
- Merge the PR into `main`.

## 3. Check the Windows release workspace

Run the **Windows release workspace** workflow from the Actions tab on `main`, or run:

```bash
pnpm release:workspace
```

This starts the workflow on `main` and watches the new run until it finishes, exiting non-zero if it fails. Both architecture jobs (x64 and ARM64) must pass before you tag.

The VS Code task is **Epikrise: Run Windows Release Workspace**.

## 4. Confirm the tag is ready

From a clean worktree on the merged commit:

```bash
pnpm release:preflight
```

This fetches tags, fast-forwards `main` from `origin/main`, and reports the project version and whether its tag exists locally and remotely.

## 5. Create and push the tag

If preflight reports that the tag is absent, run:

```bash
pnpm release:tag [YYYY.M.MICRO]
```

Run it from the clean, synchronized `main` branch. It checks the version and tag state, then asks you to type `PUSH` to confirm. It creates an annotated tag and pushes only that tag. It never force-updates a tag. In the VS Code task, leave the version blank to use the current `package.json` version.

Pushing the `v*` tag starts the **Signed updater release** workflow.

## 6. Wait for the draft release

The signed-release workflow builds signed bundles for each target, stages the assets and signatures, generates `latest.json`, and creates a **draft** release. Nothing is published yet.

Check the draft's assets, signatures, `latest.json`, and target URLs:

```bash
pnpm release:draft-status
```

This shows the latest **Signed updater release** run and whether the draft exists for the `package.json` version. For a draft, it prints the releases page; open it and select the tag. Drafts are visible only to users with write access to the repository. The VS Code task is **Epikrise: Show Draft Release Status**.

## 7. Test the draft natively

On each target you plan to claim as supported, install the draft's assets and check installation and runtime behavior. Record the results in the related issue or PR.

Updater checks cannot be tested on a draft. The updater endpoint only serves the latest published release. A two-version update test and a tampered-bundle rejection test therefore have to wait until a previous signed version is published. Do not claim updater support for a target until both pass on that target. See [CONTRIBUTING.md](CONTRIBUTING.md#release-and-update-workflow).

## 8. Approve publication

Only after the acceptance evidence is recorded:

1. Open the **Signed updater release** run.
2. Approve the **Approve accepted draft release** job. It is protected by the `release` environment.
3. The **Publish accepted draft release** job publishes the draft to opted-in installations.

If any target you are claiming as supported fails its checks, do not approve.

## 9. After publishing

Confirm the release is visible on GitHub and that `latest.json` points at the right assets:

```bash
pnpm release:published-status
```

This checks that the release is published, that every `latest.json` platform URL targets its assets, and whether GitHub marks this release as latest. An older release can finish after a newer one. In that case the workflow keeps the latest marker on the newer tag, and the command reports that instead of failing. The VS Code task is **Epikrise: Show Published Release Status**.

- Record updater test results separately from the release, as described in step 7.
- Store delivery uses a separate Microsoft certification process. See [CONTRIBUTING.md](CONTRIBUTING.md#release-and-update-workflow).

## Never

- Commit private signing keys or generate or replace a production key in CI. Keys live in the approved GitHub Actions secrets.
- Move or re-create a published tag.
- Publish a release while a claimed platform has failing acceptance checks.
