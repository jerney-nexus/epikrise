#!/usr/bin/env node
// Fails unless the current Partner Center submission is Published. Existing drafts
// may contain unrelated changes and must be resolved by a person before syncing.
// Usage: node scripts/check-store-submission-state.mjs <submission.json>

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** @param {unknown} submission @returns {string | undefined} */
export function submissionStatus(submission) {
  if (typeof submission !== "object" || submission === null) return undefined;
  const record = /** @type {Record<string, unknown>} */ (submission);
  const status = record.Status ?? record.status;
  return typeof status === "string" ? status : undefined;
}

/** @param {unknown} submission */
export function assertSubmissionAcceptsMetadata(submission) {
  const status = submissionStatus(submission);
  if (status === undefined) {
    throw new Error("The Partner Center submission has no readable Status.");
  }
  if (status !== "Published") {
    throw new Error(
      `The Partner Center submission is ${status}. ` +
        "Resolve the existing draft or wait for publication, then rerun the Store metadata workflow.",
    );
  }
  return status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [submissionPath] = process.argv.slice(2);
  if (!submissionPath) {
    process.stderr.write(
      "check-store-submission-state: usage: check-store-submission-state.mjs <submission.json>\n",
    );
    process.exit(1);
  }
  try {
    const submission = JSON.parse(readFileSync(submissionPath, "utf8"));
    const status = assertSubmissionAcceptsMetadata(submission);
    process.stdout.write(`Submission status ${status} accepts a metadata update.\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`check-store-submission-state: ${message}\n`);
    process.exit(1);
  }
}
