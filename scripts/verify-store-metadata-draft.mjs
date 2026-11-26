#!/usr/bin/env node
// Confirms a metadata update created a draft containing no unrelated changes.

import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import { redactFileUploadUrls } from "./redact-store-submission.mjs";

const ALLOWED_CHANGES = new Set(["id", "listings", "status", "statusdetails"]);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {Record<string, unknown>} value */
function status(value) {
  const result = value.Status ?? value.status;
  return typeof result === "string" ? result : undefined;
}

/** @param {Record<string, unknown>} value */
function submissionId(value) {
  const result = value.Id ?? value.id;
  return typeof result === "string" || typeof result === "number"
    ? String(result)
    : undefined;
}

/** @param {Record<string, unknown>} value */
function comparable(value) {
  const redacted = /** @type {Record<string, unknown>} */ (redactFileUploadUrls(value));
  return Object.fromEntries(
    Object.entries(redacted).filter(([key]) => !ALLOWED_CHANGES.has(key.toLowerCase())),
  );
}

/**
 * @param {unknown} published
 * @param {unknown} draft
 * @returns {string} the ID of the verified pending draft
 */
export function assertMetadataDraftContainsOnlyListingChanges(published, draft) {
  if (!isRecord(published) || !isRecord(draft)) {
    throw new Error("Partner Center returned an unreadable submission.");
  }
  if (status(published) !== "Published" || status(draft) !== "PendingCommit") {
    throw new Error(
      "Metadata update did not create a PendingCommit draft from Published.",
    );
  }
  const id = submissionId(draft);
  if (!id) {
    throw new Error("The pending metadata draft has no readable ID.");
  }
  if (!isDeepStrictEqual(comparable(published), comparable(draft))) {
    throw new Error(
      "The pending metadata draft contains changes outside listing metadata; refusing to publish it.",
    );
  }
  return id;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [publishedPath, draftPath] = process.argv.slice(2);
  if (!publishedPath || !draftPath) {
    process.stderr.write(
      "usage: verify-store-metadata-draft.mjs <published.json> <draft.json>\n",
    );
    process.exit(1);
  }
  try {
    const id = assertMetadataDraftContainsOnlyListingChanges(
      JSON.parse(readFileSync(publishedPath, "utf8")),
      JSON.parse(readFileSync(draftPath, "utf8")),
    );
    process.stdout.write(`${id}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`verify-store-metadata-draft: ${message}\n`);
    process.exit(1);
  }
}
