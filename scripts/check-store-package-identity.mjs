#!/usr/bin/env node
// Fails unless every package in the submission matches the release identity.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} submission @param {string} expectedVersion */
export function assertStorePackageIdentity(submission, expectedVersion) {
  if (!/^\d{4}\.(?:[1-9]|1[0-2])\.(?:0|[1-9]\d*)\.0$/.test(expectedVersion)) {
    throw new Error(`Invalid expected Store package version: ${expectedVersion}.`);
  }
  const packages = isRecord(submission)
    ? (submission.ApplicationPackages ?? submission.applicationPackages)
    : undefined;
  if (!Array.isArray(packages) || packages.length === 0) {
    throw new Error(
      "The Partner Center submission has no readable application packages.",
    );
  }
  const versions = packages.map((pkg) =>
    isRecord(pkg) ? (pkg.Version ?? pkg.version) : undefined,
  );
  if (versions.some((version) => typeof version !== "string")) {
    throw new Error("A Partner Center package has no readable version.");
  }
  const mismatches = versions.filter((version) => version !== expectedVersion);
  if (mismatches.length > 0) {
    throw new Error(
      `The Partner Center submission does not match release package ${expectedVersion}.`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [submissionPath, expectedVersion] = process.argv.slice(2);
  if (!submissionPath || !expectedVersion) {
    process.stderr.write(
      "usage: check-store-package-identity.mjs <submission.json> <expected-version>\n",
    );
    process.exit(1);
  }
  try {
    assertStorePackageIdentity(
      JSON.parse(readFileSync(submissionPath, "utf8")),
      expectedVersion,
    );
    process.stdout.write(`Store packages match release ${expectedVersion}.\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`check-store-package-identity: ${message}\n`);
    process.exit(1);
  }
}
