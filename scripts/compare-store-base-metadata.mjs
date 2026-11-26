#!/usr/bin/env node
// Lists the top-level keys where a Partner Center submission export differs
// from store-assets/base-metadata.json. FileUploadUrl is ignored (it is a
// credential) and so are Status and StatusDetails (review progress, not
// listing content). Prints nothing when the documents match.
// Usage: node scripts/compare-store-base-metadata.mjs <submission.json> <base-metadata.json>

import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import { redactFileUploadUrls } from "./redact-store-submission.mjs";

const VOLATILE_KEYS = new Set(["Status", "StatusDetails"]);

/** @param {Record<string, unknown>} document */
function comparable(document) {
  const redacted = /** @type {Record<string, unknown>} */ (
    redactFileUploadUrls(document)
  );
  return Object.fromEntries(
    Object.entries(redacted).filter(([key]) => !VOLATILE_KEYS.has(key)),
  );
}

/**
 * @param {Record<string, unknown>} submission
 * @param {Record<string, unknown>} base
 * @returns {string[]} sorted top-level keys whose values differ
 */
export function differingTopLevelKeys(submission, base) {
  const left = comparable(submission);
  const right = comparable(base);
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].filter((key) => !isDeepStrictEqual(left[key], right[key])).sort();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [submissionPath, basePath] = process.argv.slice(2);
  if (!submissionPath || !basePath) {
    process.stderr.write(
      "usage: compare-store-base-metadata.mjs <submission.json> <base-metadata.json>\n",
    );
    process.exit(1);
  }
  const keys = differingTopLevelKeys(
    JSON.parse(readFileSync(submissionPath, "utf8")),
    JSON.parse(readFileSync(basePath, "utf8")),
  );
  if (keys.length > 0) {
    process.stdout.write(`${keys.join("\n")}\n`);
  }
}
