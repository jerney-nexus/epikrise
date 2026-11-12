#!/usr/bin/env node
// Copies listing text and images from store-assets/base-metadata.json into a
// Partner Center submission JSON. The submission keeps its own packages.
// Usage: node scripts/update-store-metadata.mjs <submission.json> <base-metadata.json>
// Writes the updated submission JSON to stdout and fails when a base image is
// not uploaded.

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

const [submissionPath, basePath] = process.argv.slice(2);
if (!submissionPath || !basePath) {
  fail("usage: update-store-metadata.mjs <submission.json> <base-metadata.json>");
}

const submission = readJson(submissionPath);
const base = readJson(basePath);

const listings = submission.Listings ?? {};
const notUploaded = [];

for (const [locale, source] of Object.entries(base.Listings ?? {})) {
  const target = listings[locale]?.BaseListing;
  if (!target) {
    fail(`locale ${locale} is not in the submission; add it in Partner Center first`);
  }

  for (const field of TEXT_FIELDS) {
    if (source.BaseListing[field] !== undefined) {
      target[field] = source.BaseListing[field];
    }
  }

  const images = source.BaseListing.Images ?? [];
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

process.stdout.write(`${JSON.stringify(submission, null, 2)}\n`);
