#!/usr/bin/env node
// Waits until Partner Center reports the submission Status as Published.
// `msstore submission poll` is not used: it returns after one check and can
// report the last Published submission while the committed one is in certification.
// Usage: STORE_PRODUCT_ID=<id> node scripts/wait-store-submission.mjs [timeout-minutes]

import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";

const DEFAULT_TIMEOUT_MINUTES = 300;
const INTERVAL_MS = 60_000;
const FAILED_STATUS = /fail|reject|cancel/i;

/**
 * @param {{
 *   fetchStatus: () => Promise<string | undefined>,
 *   sleep: (ms: number) => Promise<void>,
 *   now?: () => number,
 *   timeoutMs: number,
 *   intervalMs?: number,
 *   log?: (message: string) => void,
 * }} options
 */
export async function waitForPublished({
  fetchStatus,
  sleep,
  now = Date.now,
  timeoutMs,
  intervalMs = INTERVAL_MS,
  log = () => {},
}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const status = await fetchStatus();
    log(`Submission status: ${status ?? "unknown"}`);
    if (status === "Published") return status;
    if (status !== undefined && FAILED_STATUS.test(status)) {
      throw new Error(`The Partner Center submission is ${status}.`);
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
export function fetchSubmissionStatus(productId) {
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
          const status = submission.Status ?? submission.status;
          resolve(typeof status === "string" ? status : undefined);
        } catch {
          reject(new Error("msstore submission get returned unreadable JSON."));
        }
      },
    );
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const productId = process.env.STORE_PRODUCT_ID ?? "";
  const timeoutMinutes = Number(process.argv[2] ?? DEFAULT_TIMEOUT_MINUTES);
  if (!/^[A-Za-z0-9]+$/.test(productId) || !(timeoutMinutes > 0)) {
    process.stderr.write(
      "wait-store-submission: usage: STORE_PRODUCT_ID=<id> node scripts/wait-store-submission.mjs [timeout-minutes]\n",
    );
    process.exit(1);
  }
  try {
    await waitForPublished({
      fetchStatus: () => fetchSubmissionStatus(productId),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      timeoutMs: timeoutMinutes * 60_000,
      log: (message) => process.stdout.write(`${message}\n`),
    });
    process.stdout.write("The Partner Center submission is Published.\n");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`wait-store-submission: ${message}\n`);
    process.exit(1);
  }
}
