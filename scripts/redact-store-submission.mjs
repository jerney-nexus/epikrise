#!/usr/bin/env node
// Removes FileUploadUrl (a SAS upload credential) from a Partner Center
// submission JSON at any depth.
// Usage: node scripts/redact-store-submission.mjs <submission.json>
// Writes the redacted JSON to stdout.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** @param {unknown} value @returns {unknown} */
export function redactFileUploadUrls(value) {
  if (Array.isArray(value)) {
    return value.map(redactFileUploadUrls);
  }
  if (value !== null && typeof value === "object") {
    /** @type {Record<string, unknown>} */
    const result = {};
    for (const [key, child] of Object.entries(value)) {
      if (key.toLowerCase() === "fileuploadurl") {
        continue;
      }
      result[key] = redactFileUploadUrls(child);
    }
    return result;
  }
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [submissionPath] = process.argv.slice(2);
  if (!submissionPath) {
    process.stderr.write("usage: redact-store-submission.mjs <submission.json>\n");
    process.exit(1);
  }
  const submission = JSON.parse(readFileSync(submissionPath, "utf8"));
  process.stdout.write(
    `${JSON.stringify(redactFileUploadUrls(submission), null, 2)}\n`,
  );
}
