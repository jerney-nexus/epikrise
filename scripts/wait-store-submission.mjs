#!/usr/bin/env node
// Waits until Partner Center reports the submission created by this run as Published.
// `msstore submission get <productId>` falls back to the last Published submission
// when no draft is pending, so a Published status only counts when its ID matches the
// ID captured from the draft before publish.
// Usage:
//   STORE_PRODUCT_ID=<id> node scripts/wait-store-submission.mjs --capture-id
//   STORE_PRODUCT_ID=<id> STORE_SUBMISSION_ID=<id> node scripts/wait-store-submission.mjs [timeout-minutes]

import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";

const DEFAULT_TIMEOUT_MINUTES = 300;
const INTERVAL_MS = 60_000;
const FAILED_STATUS = /fail|reject|cancel/i;

/**
 * @param {{
 *   submissionId: string,
 *   fetchSubmission: () => Promise<{ id: string | undefined, status: string | undefined }>,
 *   sleep: (ms: number) => Promise<void>,
 *   now?: () => number,
 *   timeoutMs: number,
 *   intervalMs?: number,
 *   log?: (message: string) => void,
 * }} options
 */
export async function waitForPublished({
  submissionId,
  fetchSubmission,
  sleep,
  now = Date.now,
  timeoutMs,
  intervalMs = INTERVAL_MS,
  log = () => {},
}) {
  if (!submissionId) {
    throw new Error("No submission ID was captured before publish.");
  }
  const deadline = now() + timeoutMs;
  for (;;) {
    const { id, status } = await fetchSubmission();
    if (id === undefined) {
      throw new Error(
        "msstore submission get returned no submission ID; cannot confirm which submission is Published.",
      );
    }
    if (id === submissionId) {
      log(`Submission status: ${status ?? "unknown"}`);
      if (status === "Published") return status;
      if (status !== undefined && FAILED_STATUS.test(status)) {
        throw new Error(`The Partner Center submission is ${status}.`);
      }
    } else {
      log(`Partner Center reports another submission (waiting for ${submissionId}).`);
    }
    if (now() >= deadline) {
      throw new Error(
        `Timed out waiting for the Partner Center submission to be Published; last status ${status ?? "unknown"}.`,
      );
    }
    await sleep(intervalMs);
  }
}

/** @param {string} productId */
export function fetchSubmission(productId) {
  return new Promise((resolve, reject) => {
    execFile(
      "msstore",
      ["submission", "get", productId, "-m", "properties"],
      { shell: process.platform === "win32", maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          // Errors can carry command output; report only the exit failure.
          reject(new Error("msstore submission get (properties) failed."));
          return;
        }
        try {
          const submission = JSON.parse(stdout);
          const id = submission.id ?? submission.Id;
          const status = submission.Status ?? submission.status;
          resolve({
            id: typeof id === "string" && id !== "" ? id : undefined,
            status: typeof status === "string" ? status : undefined,
          });
        } catch {
          reject(new Error("msstore submission get returned unreadable JSON."));
        }
      },
    );
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const productId = process.env.STORE_PRODUCT_ID ?? "";
  const capture = process.argv[2] === "--capture-id";
  const timeoutMinutes = capture
    ? DEFAULT_TIMEOUT_MINUTES
    : Number(process.argv[2] ?? DEFAULT_TIMEOUT_MINUTES);
  const usage =
    "wait-store-submission: usage: STORE_PRODUCT_ID=<id> node scripts/wait-store-submission.mjs --capture-id | [timeout-minutes] with STORE_SUBMISSION_ID=<id>\n";
  if (!/^[A-Za-z0-9]+$/.test(productId) || !(timeoutMinutes > 0)) {
    process.stderr.write(usage);
    process.exit(1);
  }
  try {
    if (capture) {
      const { id } = await fetchSubmission(productId);
      if (id === undefined) {
        throw new Error("msstore submission get returned no submission ID.");
      }
      process.stdout.write(`${id}\n`);
    } else {
      await waitForPublished({
        submissionId: process.env.STORE_SUBMISSION_ID ?? "",
        fetchSubmission: () => fetchSubmission(productId),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        timeoutMs: timeoutMinutes * 60_000,
        log: (message) => process.stdout.write(`${message}\n`),
      });
      process.stdout.write("The Partner Center submission is Published.\n");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`wait-store-submission: ${message}\n`);
    process.exit(1);
  }
}
