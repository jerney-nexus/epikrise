#!/usr/bin/env node
// Fails unless the release's MSIX identity version is greater than every
// package version already in the Partner Center submission.
// Usage: node scripts/check-store-version.mjs <release-version> <submission.json>
// Fails closed when the submission lists no readable package versions.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { assertStoreVersionAdvances, deriveReleaseVersions } from "./store-version.mjs";

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} submission @returns {string[]} */
export function publishedPackageVersions(submission) {
  const packages = isRecord(submission) ? submission.applicationPackages : undefined;
  if (!Array.isArray(packages)) return [];
  return packages
    .filter(isRecord)
    .map((pkg) => pkg.version)
    .filter((version) => typeof version === "string");
}

/** @param {string} releaseVersion @param {unknown} submission */
export function assertReleaseAdvancesStoreVersions(releaseVersion, submission) {
  const versions = publishedPackageVersions(submission);
  if (versions.length === 0) {
    throw new Error(
      "No package versions were found in the Partner Center submission. " +
        "Submit the first version manually, then rerun this check.",
    );
  }
  const next = deriveReleaseVersions(releaseVersion).msixIdentityVersion;
  for (const version of versions) {
    assertStoreVersionAdvances(releaseVersion, version);
  }
  return next;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [releaseVersion, submissionPath] = process.argv.slice(2);
  if (!releaseVersion || !submissionPath) {
    process.stderr.write(
      "check-store-version: usage: check-store-version.mjs <release-version> <submission.json>\n",
    );
    process.exit(1);
  }
  try {
    const submission = JSON.parse(readFileSync(submissionPath, "utf8"));
    const next = assertReleaseAdvancesStoreVersions(releaseVersion, submission);
    process.stdout.write(`Store version ${next} advances the submission.\n`);
  } catch (error) {
    process.stderr.write(`check-store-version: ${error.message}\n`);
    process.exit(1);
  }
}
