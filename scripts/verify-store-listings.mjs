#!/usr/bin/env node
// Checks a Partner Center listings read-back against the intended submission after
// msstore submission updateMetadata. Text and ordered image identities must match.
// Usage: node scripts/verify-store-listings.mjs <listings.json> <expected-submission.json> [published-submission.json]
// Prints the mismatched locale fields (never their values) and exits 1 when any differ.

import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";

/** @typedef {{ image: Record<string, unknown>, index: number }} ScreenshotEntry */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {Record<string, unknown>} value @param {string} pascal @param {string} camel */
function field(value, pascal, camel) {
  return value[pascal] ?? value[camel];
}

/** @param {unknown} images @returns {string | undefined} */
function imageIdentity(images) {
  if (!Array.isArray(images)) return undefined;
  /** @type {string[]} */
  const identities = [];
  for (const image of images) {
    if (!isRecord(image)) return undefined;
    const id = field(image, "Id", "id");
    const fileName = field(image, "FileName", "fileName");
    const imageType = field(image, "ImageType", "imageType");
    const fileStatus = field(image, "FileStatus", "fileStatus");
    if (
      (typeof id !== "string" && typeof id !== "number") ||
      typeof fileName !== "string" ||
      fileName === "" ||
      typeof imageType !== "string" ||
      imageType === "" ||
      fileStatus !== "Uploaded"
    ) {
      return undefined;
    }
    identities.push(JSON.stringify([String(id), fileName, imageType]));
  }
  return JSON.stringify(identities);
}

/** @param {string} value @returns {string} */
function escapeMarkdown(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/[\\|`]/g, "\\$&")
    .replace(/[\r\n]/g, " ");
}

/**
 * @param {unknown} readback
 * @param {unknown} expectedSubmission
 * @param {unknown} [publishedSubmission]
 * @returns {{ mismatches: string[], screenshotRows: string[] }}
 */
export function verifyStoreListings(readback, expectedSubmission, publishedSubmission) {
  if (!isRecord(readback) || !isRecord(expectedSubmission)) {
    throw new Error("The read-back and expected submission must be JSON objects.");
  }
  const listings = readback.Listings ?? readback.listings ?? {};
  const expectedListings =
    expectedSubmission.Listings ?? expectedSubmission.listings ?? {};
  if (!isRecord(listings) || !isRecord(expectedListings)) {
    throw new Error("The read-back or expected submission has no readable Listings.");
  }
  const expectedLocales = Object.entries(expectedListings);
  if (expectedLocales.length === 0) {
    throw new Error("The expected submission has no locale listings to verify.");
  }
  const previousListings = isRecord(publishedSubmission)
    ? (publishedSubmission.Listings ?? publishedSubmission.listings ?? {})
    : {};
  if (!isRecord(previousListings)) {
    throw new Error("The published submission has no readable Listings.");
  }

  /** @type {string[]} */
  const mismatches = [];
  for (const locale of Object.keys(listings)) {
    if (!Object.hasOwn(expectedListings, locale)) {
      mismatches.push(`${locale}: unexpected listing`);
    }
  }
  /** @type {Map<string, Record<string, unknown>[]>} */
  const verifiedScreenshots = new Map();
  for (const [locale, source] of expectedLocales) {
    const actualLocale = listings[locale];
    if (isRecord(source) && isRecord(actualLocale)) {
      const fields = new Set([...Object.keys(source), ...Object.keys(actualLocale)]);
      fields.delete("BaseListing");
      fields.delete("baseListing");
      for (const fieldName of fields) {
        if (!isDeepStrictEqual(actualLocale[fieldName], source[fieldName])) {
          mismatches.push(`${locale} ${fieldName}`);
        }
      }
    }
    const expectedListing = isRecord(source)
      ? (source.BaseListing ?? source.baseListing)
      : undefined;
    const actualListing = isRecord(actualLocale)
      ? (actualLocale.BaseListing ?? actualLocale.baseListing)
      : undefined;
    if (!isRecord(expectedListing) || !isRecord(actualListing)) {
      mismatches.push(`${locale}: missing listing`);
      continue;
    }

    const listingFields = new Set([
      ...Object.keys(expectedListing),
      ...Object.keys(actualListing),
    ]);
    for (const fieldName of listingFields) {
      if (fieldName.toLowerCase() === "images") continue;
      if (!isDeepStrictEqual(actualListing[fieldName], expectedListing[fieldName])) {
        mismatches.push(`${locale} ${fieldName}`);
      }
    }

    const expectedImages = field(expectedListing, "Images", "images");
    const actualImages = field(actualListing, "Images", "images");
    const expectedIdentity = imageIdentity(expectedImages);
    const actualIdentity = imageIdentity(actualImages);
    if (
      expectedIdentity === undefined ||
      actualIdentity === undefined ||
      expectedIdentity !== actualIdentity
    ) {
      mismatches.push(
        `${locale} Images (missing, changed, reordered, or not uploaded)`,
      );
      continue;
    }

    /** @type {Record<string, unknown>[]} */
    const screenshots = [];
    for (const image of /** @type {Record<string, unknown>[]} */ (expectedImages)) {
      if (field(image, "ImageType", "imageType") === "Screenshot") {
        screenshots.push(image);
      }
    }
    if (screenshots.length === 0) {
      mismatches.push(`${locale} Screenshots (none configured)`);
    }
    verifiedScreenshots.set(locale, screenshots);
  }

  /** @type {string[]} */
  const screenshotRows = [];
  for (const locale of new Set([
    ...Object.keys(previousListings),
    ...verifiedScreenshots.keys(),
  ])) {
    const beforeLocale = previousListings[locale];
    const beforeListing = isRecord(beforeLocale)
      ? (beforeLocale.BaseListing ?? beforeLocale.baseListing)
      : undefined;
    const beforeImages =
      isRecord(beforeListing) && Array.isArray(field(beforeListing, "Images", "images"))
        ? /** @type {Record<string, unknown>[]} */ (
            field(beforeListing, "Images", "images")
          ).filter(
            (image) =>
              isRecord(image) &&
              field(image, "ImageType", "imageType") === "Screenshot",
          )
        : [];
    const afterImages = verifiedScreenshots.get(locale) ?? [];
    /** @type {Map<string, ScreenshotEntry>} */
    const beforeByIdentity = new Map(
      beforeImages.map(
        (image, index) =>
          /** @type {[string, ScreenshotEntry]} */ ([
            JSON.stringify([
              String(field(image, "Id", "id")),
              field(image, "FileName", "fileName"),
              field(image, "ImageType", "imageType"),
            ]),
            { image, index },
          ]),
      ),
    );
    /** @type {Map<string, ScreenshotEntry>} */
    const afterByIdentity = new Map(
      afterImages.map(
        (image, index) =>
          /** @type {[string, ScreenshotEntry]} */ ([
            JSON.stringify([
              String(field(image, "Id", "id")),
              field(image, "FileName", "fileName"),
              field(image, "ImageType", "imageType"),
            ]),
            { image, index },
          ]),
      ),
    );
    for (const identity of new Set([
      ...beforeByIdentity.keys(),
      ...afterByIdentity.keys(),
    ])) {
      const before = beforeByIdentity.get(identity);
      const after = afterByIdentity.get(identity);
      const change =
        before === undefined
          ? "Added"
          : after === undefined
            ? "Removed"
            : before.index === after.index
              ? "Unchanged"
              : "Reordered";
      /** @param {ScreenshotEntry | undefined} entry */
      const cell = (entry) =>
        entry === undefined
          ? "—"
          : `${entry.index + 1}. ${escapeMarkdown(String(field(entry.image, "FileName", "fileName")))} (${escapeMarkdown(String(field(entry.image, "Id", "id")))})`;
      screenshotRows.push(
        `| ${escapeMarkdown(locale)} | ${change} | ${cell(before)} | ${cell(after)} |`,
      );
    }
  }
  return { mismatches, screenshotRows };
}

/** @param {string} path */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    process.stderr.write(
      `verify-store-listings: cannot read ${path}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [listingsPath, expectedPath, publishedPath] = process.argv.slice(2);
  if (!listingsPath || !expectedPath) {
    process.stderr.write(
      "usage: verify-store-listings.mjs <listings.json> <expected-submission.json> [published-submission.json]\n",
    );
    process.exit(2);
  }

  /** @type {{ mismatches: string[], screenshotRows: string[] }} */
  let verification;
  try {
    verification = verifyStoreListings(
      readJson(listingsPath),
      readJson(expectedPath),
      publishedPath ? readJson(publishedPath) : undefined,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`verify-store-listings: ${message}\n`);
    process.exit(2);
  }

  if (verification.mismatches.length > 0) {
    process.stderr.write(
      `verify-store-listings: submission does not match the expected submission:\n  ${verification.mismatches.join("\n  ")}\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    "verify-store-listings: text and image read-back matches the expected submission\n",
  );
  if (verification.screenshotRows.length > 0) {
    process.stdout.write(
      [
        "",
        "### Screenshot review required in Partner Center",
        "",
        "| Locale | Change | Published screenshot (position, ID) | Draft screenshot (position, ID) |",
        "| --- | --- | --- | --- |",
        ...verification.screenshotRows,
        "",
      ].join("\n"),
    );
  }
}
