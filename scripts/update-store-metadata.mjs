#!/usr/bin/env node
// Merges store-assets/listing.json into a Partner Center submission JSON.
// Usage: node scripts/update-store-metadata.mjs <submission.json> <listing.json>
// Writes the updated submission JSON to stdout and fails when expected
// listing images are not uploaded for every locale.

import { readFileSync } from "node:fs";

const TEXT_FIELDS = [
  "Title",
  "Description",
  "Features",
  "Keywords",
  "CopyrightAndTrademarkInfo",
  "LicenseTerms",
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

const [submissionPath, listingPath] = process.argv.slice(2);
if (!submissionPath || !listingPath) {
  fail("usage: update-store-metadata.mjs <submission.json> <listing.json>");
}

const submission = readJson(submissionPath);
const listing = readJson(listingPath);

const listings = submission.Listings ?? {};
const missingImages = [];

for (const [locale, source] of Object.entries(listing.Listings)) {
  const baseListing = listings[locale]?.BaseListing;
  if (!baseListing) {
    fail(`locale ${locale} is not in the submission; add it in Partner Center first`);
  }

  for (const field of TEXT_FIELDS) {
    if (source.BaseListing[field] !== undefined) {
      baseListing[field] = source.BaseListing[field];
    }
  }

  const uploaded = new Set(
    (baseListing.Images ?? [])
      .filter((image) => image.FileStatus === "Uploaded")
      .map((image) => image.FileName),
  );
  for (const { FileName: fileName } of listing.Images) {
    if (!uploaded.has(fileName)) {
      missingImages.push(`${locale}: ${fileName}`);
    }
  }
}

if (missingImages.length > 0) {
  fail(`images not uploaded in Partner Center:\n  ${missingImages.join("\n  ")}`);
}

process.stdout.write(`${JSON.stringify(submission, null, 2)}\n`);
