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

## Microsoft Store submission

The Store package is separate from the signed release, the NSIS installer, and the direct-release updater. It is never installed by the direct updater, and the Store build has no updater code or update checks. Microsoft manages Store updates.

1. Wait for the **Store submission packages** run for the tag. It attaches the unsigned x64 and ARM64 MSIX packages and the `.msixbundle`, built by the signed release run for the same commit, with SHA-256 and provenance manifests, to the GitHub Release. The `.msixbundle` also has a build provenance attestation, which the publish job verifies with `gh attestation verify` before uploading. To check it yourself, run `gh attestation verify <file> --repo jerney-nexus/epikrise`. Its inputs do not include `previous_store_version`.
2. The `submit` job waits for approval in the `store-partner-center` GitHub environment before it uploads anything. Configure that environment with required reviewers (Settings → Environments). Approve the job in the run page only after the signed release is verified. Once approved, the same run uploads the bundle to Partner Center with `msstore publish --noCommit`, after the signed release is published. It then copies the listing text and images from [`store-assets/base-metadata.json`](store-assets/base-metadata.json) into the draft, keeping the draft's packages, sends the result with `msstore submission updateMetadata` (which replaces the whole submission), and commits it with `msstore submission publish`. The base-metadata file is a snapshot of the live listing, so update it by hand with the output of **Store base metadata** after changing the listing in Partner Center. The listing images in the file must already be uploaded in Partner Center for every locale; the job fails before committing if any are not `Uploaded`. Upload them by hand first. Before uploading, the job runs a version guard (`scripts/check-store-version.mjs`) that compares the release version with every package version in the current Partner Center submission and fails if the release does not advance past them. The guard fails closed: if it cannot read any package versions from `msstore submission get`, the job stops. The first submission therefore has to be done by hand. If the upload fails, the signed release assets are unaffected; fix the cause, check Partner Center for a draft left by the failed run, and rerun the job. A leftover draft with the same version can block the guard on rerun, so resolve it in Partner Center first.
3. The first Store submission and any manual resubmission are done by hand in Partner Center. To build packages before the release is published, dispatch **Desktop builds** with `previous_store_version` set to the last submitted Store version. The build rejects a version that does not advance. See [CONTRIBUTING.md](CONTRIBUTING.md#building-the-store-msixbundle).
4. Microsoft signs submitted packages and runs certification. Record the certification outcome and any reviewer questions in the related issue.
5. Test the Store package on a clean Windows install. Record the Windows version and WebView2 runtime status. The package does not bundle WebView2, so the device must already have the Evergreen Runtime.

## Microsoft Store setup

Complete this once before the first automated submission:

1. Create the Partner Center app and set its product ID as the `STORE_PRODUCT_ID` repository variable.
2. Add the secrets `AZURE_AD_TENANT_ID`, `SELLER_ID`, `AZURE_AD_APPLICATION_CLIENT_ID`, `AZURE_AD_CERTIFICATE_PFX_BASE64` (the base64 of the PFX file, which contains the private key), and `AZURE_AD_CERTIFICATE_PASSWORD`, and the variable `STORE_PRODUCT_ID`, to the `store-partner-center` environment (Settings → Environments), not as repository-level secrets. Upload the matching `.cer` to the Entra app registration. The certificate is valid for 24 months at most; renew it before it expires. Restrict the environment's deployment branches to `main`. Use these names only, and never commit their values or the PFX file.
3. Add every locale listed in `store-assets/base-metadata.json` (currently `de-ch`, `en-us`, `fr-fr`, `it-it`, and `es-es`) to the listings in Partner Center, then upload the listing images by hand for each. The sync job fails for any locale that is not in the submission.
4. Run **Store base metadata** (`.github/workflows/store-base-metadata.yml`) with manual dispatch, then download the `epikrise-store-base-metadata` artifact. Save it as `store-assets/base-metadata.json`, removing any `FileUploadUrl` values first. The file is the source for the automated listing sync.

Both Store submission jobs run on `windows-latest`, following the Microsoft GitHub Actions example. The upload job uses PowerShell and stops on the first failing `msstore` command.

## Partner Center certificate

The Store workflows authenticate to Partner Center with a self-signed certificate instead of a client secret. The certificate expires 24 months after creation, and the workflows fail once it does. Record its expiry date (shown in the `NotAfter` field below) and set a reminder at least 30 days before it.

### Create the certificate (Windows PowerShell)

```powershell
$dir = "$env:USERPROFILE\epikrise-msstore"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$cert = New-SelfSignedCertificate -Subject "CN=epikrise-msstore" `
  -CertStoreLocation Cert:\CurrentUser\My `
  -KeyAlgorithm RSA -KeyLength 2048 -KeyExportPolicy Exportable `
  -NotAfter (Get-Date).AddMonths(24)
$cert | Select-Object Subject, Thumbprint, NotAfter
```

### Export the public certificate and upload it to Entra

```powershell
Export-Certificate -Cert $cert -FilePath "$dir\epikrise-msstore.cer"
```

In the Entra admin center, open the app registration used for Partner Center (its client ID is `AZURE_AD_APPLICATION_CLIENT_ID`), go to **Certificates & secrets → Certificates → Upload certificate**, and upload `epikrise-msstore.cer`. Keep any older certificate until the new one has passed a workflow run.

### Export the PFX for CI

```powershell
$pfxPassword = Read-Host -AsSecureString "PFX password"
Export-PfxCertificate -Cert $cert -FilePath "$dir\epikrise-msstore.pfx" -Password $pfxPassword
[BitConverter]::ToString([IO.File]::ReadAllBytes("$dir\epikrise-msstore.pfx")[0..15])
```

A valid PFX prints `30-82-xx-xx-02-01-03`, where `xx-xx` is the length. A `.cer` file prints `30-82-xx-xx-30-82` instead; if you see that, repeat the export. Never commit the PFX or the password.

### Set the CI secrets

Encode the PFX as one line and copy it to the clipboard:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$dir\epikrise-msstore.pfx")) | Set-Clipboard
```

Paste it into the `AZURE_AD_CERTIFICATE_PFX_BASE64` secret of the `store-partner-center` environment. Set `AZURE_AD_CERTIFICATE_PASSWORD` to the password entered above.

### Test locally

Import the PFX into the current user's certificate store, then run the read-only checks, substituting the new certificate's thumbprint:

```powershell
Import-PfxCertificate -FilePath "$dir\epikrise-msstore.pfx" -CertStoreLocation Cert:\CurrentUser\My -Password $pfxPassword
msstore reconfigure --tenantId <tenant> --sellerId <seller> --clientId <client> --certificateThumbprint <thumbprint>
msstore info
```

Do not run `updateMetadata`, `publish`, or `submission publish` as a test.

### Finish the renewal

1. Run **Store base metadata** (manual dispatch) and confirm it passes with the new secrets.
2. Delete the old certificate from the Entra app registration.
3. Delete the local `.pfx` and `.cer` files, then clear the clipboard with `Set-Clipboard -Value ' '`.
4. Renew the certificate before the old one expires. A failed Store run leaves any draft in Partner Center; check and remove it before rerunning.

If the client secret (`AZURE_AD_APPLICATION_SECRET`) still exists, delete it from the environment and revoke it in Entra after the first certificate-based run passes.

## Never

- Commit private signing keys or generate or replace a production key in CI. Keys live in the approved GitHub Actions secrets.
- Move or re-create a published tag.
- Publish a release while a claimed platform has failing acceptance checks.
- Upload a Store package whose version does not advance over the last Partner Center submission.
