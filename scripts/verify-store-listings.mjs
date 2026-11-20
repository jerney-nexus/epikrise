#!/usr/bin/env node
// Checks a Partner Center listings read-back against store-assets/base-metadata.json
// after msstore submission updateMetadata. Every base text field must match exactly;
// images are checked by update-store-metadata.mjs and are not compared here.
// Usage: node scripts/verify-store-listings.mjs <listings.json> <base-metadata.json>
// Prints the mismatched locale fields (never their values) and exits 1 when any differ.

import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    process.stderr.write(
      `verify-store-listings: cannot read ${path}: ${error.message}\n`,
    );
    process.exit(2);
  }
}

const [listingsPath, basePath] = process.argv.slice(2);
if (!listingsPath || !basePath) {
  process.stderr.write(
    "usage: verify-store-listings.mjs <listings.json> <base-metadata.json>\n",
  );
  process.exit(2);
}

const listings = readJson(listingsPath).Listings ?? {};
const base = readJson(basePath);
const baseLocales = Object.entries(base.Listings ?? {});
if (baseLocales.length === 0) {
  process.stderr.write(
    `verify-store-listings: ${basePath} has no locale listings to verify\n`,
  );
  process.exit(2);
}
const mismatches = [];

for (const [locale, source] of baseLocales) {
  const target = listings[locale]?.BaseListing;
  if (!target) {
    mismatches.push(`${locale}: missing from the submission`);
    continue;
  }
  for (const [field, expected] of Object.entries(source.BaseListing)) {
    if (field === "Images") continue;
    if (!isDeepStrictEqual(target[field], expected)) {
      mismatches.push(`${locale} ${field}`);
    }
  }
}

if (mismatches.length > 0) {
  process.stderr.write(
    `verify-store-listings: submission does not match base-metadata.json:\n  ${mismatches.join("\n  ")}\n`,
  );
  process.exit(1);
}
process.stdout.write("verify-store-listings: submission matches base-metadata.json\n");
