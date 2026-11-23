#!/usr/bin/env node
// Copies listing text and images from store-assets/base-metadata.json into a
// Partner Center submission JSON. The submission keeps its own packages.
// Usage: node scripts/update-store-metadata.mjs <submission.json> <base-metadata.json>
// Writes the updated submission JSON to stdout and fails when a base image is
// not uploaded. Writes nothing (exit 0) when the listings already match, so the
// caller does not create a draft for a no-op.

import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

// Every BaseListing field msstore accepts, except Images (handled below).
const LISTING_FIELDS = [
  "Title",
  "ShortTitle",
  "VoiceTitle",
  "Description",
  "ShortDescription",
  "Features",
  "Keywords",
  "ReleaseNotes",
  "CopyrightAndTrademarkInfo",
  "LicenseTerms",
  "DevStudio",
  "RecommendedHardware",
  "MinimumHardware",
];

function fail(message) {
  process.stderr.write(`update-store-metadata: ${message}\n`);
  process.exit(1);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`cannot read ${path}: ${error.message}`);
  }
}

const [submissionPath, basePath] = process.argv.slice(2);
if (!submissionPath || !basePath) {
  fail("usage: update-store-metadata.mjs <submission.json> <base-metadata.json>");
}

const submission = readJson(submissionPath);
const base = readJson(basePath);

const listings = submission.Listings ?? {};
const original = structuredClone(listings);
const notUploaded = [];

for (const [locale, source] of Object.entries(base.Listings ?? {})) {
  const target = listings[locale]?.BaseListing;
  if (!target) {
    fail(`locale ${locale} is not in the submission; add it in Partner Center first`);
  }

  for (const field of LISTING_FIELDS) {
    if (source.BaseListing[field] !== undefined) {
      target[field] = source.BaseListing[field];
    }
  }

  // Locales without base images keep the images uploaded to the draft.
  const baseImages = source.BaseListing.Images ?? [];
  const images = baseImages.length > 0 ? baseImages : (target.Images ?? []);
  if (images.length === 0) {
    notUploaded.push(
      `${locale}: no listing images in base-metadata.json or the submission`,
    );
  }
  for (const image of images) {
    if (image.FileStatus !== "Uploaded") {
      notUploaded.push(`${locale}: ${image.FileName} (${image.FileStatus})`);
    }
  }
  target.Images = images;
}

if (notUploaded.length > 0) {
  fail(`images not uploaded in Partner Center:\n  ${notUploaded.join("\n  ")}`);
}

if (isDeepStrictEqual(original, listings)) {
  process.stderr.write(
    "update-store-metadata: listings already match; nothing to update\n",
  );
} else {
  process.stdout.write(`${JSON.stringify(submission, null, 2)}\n`);
}
