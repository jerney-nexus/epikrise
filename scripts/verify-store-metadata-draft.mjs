#!/usr/bin/env node
// Confirms a metadata update created a draft containing no unrelated changes.

import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import { redactFileUploadUrls } from "./redact-store-submission.mjs";

const ALLOWED_CHANGES = new Set([
  "id",
  "listings",
  "status",
  "statusdetails",
  "friendlyname",
]);
const PACKAGE_IDENTITY_FIELDS = [
  "id",
  "filename",
  "version",
  "architecture",
  "filestatus",
];

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
  const result = Object.fromEntries(
    Object.entries(redacted).filter(([key]) => !ALLOWED_CHANGES.has(key.toLowerCase())),
  );
  const pricing = field(result, "pricing");
  if (isRecord(pricing)) removeField(pricing, "isadvancedpricingmodel");
  const delivery = field(result, "packagedeliveryoptions");
  const rollout = isRecord(delivery) ? field(delivery, "packagerollout") : undefined;
  if (isRecord(rollout)) removeField(rollout, "fallbacksubmissionid");
  return result;
}

/** @param {Record<string, unknown>} value @param {string} name */
function field(value, name) {
  const keys = Object.keys(value).filter((key) => key.toLowerCase() === name);
  return keys.length === 1 ? value[keys[0]] : undefined;
}

/** @param {Record<string, unknown>} value @param {string} name */
function removeField(value, name) {
  for (const key of Object.keys(value)) {
    if (key.toLowerCase() === name) delete value[key];
  }
}

/** @param {Record<string, unknown>} value @param {string} name */
function hasUnambiguousField(value, name) {
  return Object.keys(value).filter((key) => key.toLowerCase() === name).length <= 1;
}

/**
 * Partner Center may omit derived platform details from a newly created draft.
 * Only tolerate missing details for a package with the same complete identity.
 * @param {Record<string, unknown>} published
 * @param {Record<string, unknown>} draft
 */
function normalizeIncompletePackageReadback(published, draft) {
  const before = field(published, "applicationpackages");
  const after = field(draft, "applicationpackages");
  if (
    !Array.isArray(before) ||
    !Array.isArray(after) ||
    before.length !== after.length
  ) {
    return;
  }
  for (let i = 0; i < before.length; i++) {
    const original = before[i];
    const updated = after[i];
    if (!isRecord(original) || !isRecord(updated)) continue;
    const sameIdentity = PACKAGE_IDENTITY_FIELDS.every((name) => {
      const expected = field(original, name);
      return (
        typeof expected === "string" &&
        expected !== "" &&
        field(updated, name) === expected
      );
    });
    if (!sameIdentity) continue;

    const platform = field(original, "targetplatform");
    const draftPlatform = field(updated, "targetplatform");
    if (
      hasUnambiguousField(original, "targetplatform") &&
      hasUnambiguousField(updated, "targetplatform") &&
      typeof platform === "string" &&
      platform !== "" &&
      draftPlatform == null
    ) {
      removeField(original, "targetplatform");
      removeField(updated, "targetplatform");
    }

    const families = field(original, "targetdevicefamilies");
    const draftFamilies = field(updated, "targetdevicefamilies");
    if (
      Array.isArray(families) &&
      families.length > 0 &&
      families.every((family) => typeof family === "string" && family !== "") &&
      hasUnambiguousField(original, "targetdevicefamilies") &&
      hasUnambiguousField(updated, "targetdevicefamilies") &&
      (draftFamilies == null ||
        (Array.isArray(draftFamilies) && draftFamilies.length === 0))
    ) {
      removeField(original, "targetdevicefamilies");
      removeField(updated, "targetdevicefamilies");
    }
  }
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
  const publishedComparable = comparable(published);
  const draftComparable = comparable(draft);
  normalizeIncompletePackageReadback(publishedComparable, draftComparable);
  if (!isDeepStrictEqual(publishedComparable, draftComparable)) {
    throw new Error(
      "The pending metadata draft contains changes outside listing metadata; refusing to publish it.",
    );
  }
  return id;
}

/**
 * @param {unknown} reviewed
 * @param {unknown} current
 * @param {string} expectedId
 */
export function assertReviewedMetadataDraftUnchanged(reviewed, current, expectedId) {
  if (!isRecord(reviewed) || !isRecord(current)) {
    throw new Error("Partner Center returned an unreadable submission.");
  }
  if (
    status(reviewed) !== "PendingCommit" ||
    status(current) !== "PendingCommit" ||
    submissionId(reviewed) !== expectedId ||
    submissionId(current) !== expectedId
  ) {
    throw new Error(
      "The Partner Center draft changed or is no longer pending after human review.",
    );
  }
  /** @param {Record<string, unknown>} value */
  const normalize = (value) => {
    const result = /** @type {Record<string, unknown>} */ (redactFileUploadUrls(value));
    const normalized = { ...result };
    delete normalized.Status;
    delete normalized.status;
    delete normalized.StatusDetails;
    delete normalized.statusDetails;
    return normalized;
  };
  if (!isDeepStrictEqual(normalize(reviewed), normalize(current))) {
    throw new Error(
      "The Partner Center draft changed after human review; refusing to publish it.",
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "verify-reviewed" && args.length === 3 && args.every(Boolean)) {
    try {
      assertReviewedMetadataDraftUnchanged(
        JSON.parse(readFileSync(args[0], "utf8")),
        JSON.parse(readFileSync(args[1], "utf8")),
        args[2],
      );
      process.stdout.write("The reviewed Partner Center draft is unchanged.\n");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`verify-store-metadata-draft: ${message}\n`);
      process.exit(1);
    }
  } else if (command === "verify-new" && args.length === 2 && args.every(Boolean)) {
    try {
      const id = assertMetadataDraftContainsOnlyListingChanges(
        JSON.parse(readFileSync(args[0], "utf8")),
        JSON.parse(readFileSync(args[1], "utf8")),
      );
      process.stdout.write(`${id}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`verify-store-metadata-draft: ${message}\n`);
      process.exit(1);
    }
  } else {
    process.stderr.write(
      "usage: verify-store-metadata-draft.mjs verify-new <published.json> <draft.json> | verify-reviewed <reviewed.json> <current.json> <submission-id>\n",
    );
    process.exit(1);
  }
}
