#!/usr/bin/env node
// Writes a Markdown checklist about the Store listing release notes for the
// release pull request. It lists the locales in store-assets/base-metadata.json
// whose ReleaseNotes are empty or still match the previous release tag.
// Usage: node scripts/check-store-release-notes.mjs
// Never fails because of the notes: they are edited on the release branch itself.

import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFile = promisify(execFileCallback);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const metadataPath = "store-assets/base-metadata.json";

/** @param {unknown} metadata @returns {Record<string, string>} */
function releaseNotesByLocale(metadata) {
  const listings =
    typeof metadata === "object" && metadata !== null
      ? /** @type {Record<string, unknown>} */ (metadata).Listings
      : undefined;
  /** @type {Record<string, string>} */
  const notes = {};
  if (typeof listings !== "object" || listings === null) return notes;
  for (const [locale, listing] of Object.entries(listings)) {
    const baseListing = /** @type {Record<string, unknown> | undefined} */ (
      /** @type {Record<string, unknown>} */ (listing ?? {}).BaseListing
    );
    const value = baseListing?.ReleaseNotes;
    notes[locale] = typeof value === "string" ? value : "";
  }
  return notes;
}

/**
 * Locales whose release notes are empty or identical to the previous release.
 * @param {unknown} current @param {unknown} previous @returns {string[]}
 */
export function localesNeedingReleaseNotes(current, previous) {
  const before = releaseNotesByLocale(previous);
  return Object.entries(releaseNotesByLocale(current))
    .filter(([locale, notes]) => notes.trim() === "" || notes === before[locale])
    .map(([locale]) => locale);
}

/** @param {{ locales: string[], needing: string[], previousTag: string | null }} options */
export function renderReleaseNotesChecklist({ locales, needing, previousTag }) {
  const lines = [
    "## Store listing release notes",
    "",
    "<!-- Please tick all applicable checkboxes. -->",
    "",
    `- [ ] Update \`ReleaseNotes\` in \`${metadataPath}\` for every locale (${locales
      .map((locale) => `\`${locale}\``)
      .join(", ")}) on this branch, then run **Store metadata** after the release.`,
    "",
  ];
  if (previousTag === null) {
    lines.push("No previous release tag exists, so every locale needs release notes.");
  } else if (needing.length > 0) {
    lines.push(
      `Still empty or unchanged since \`${previousTag}\`: ${needing
        .map((locale) => `\`${locale}\``)
        .join(", ")}.`,
    );
  } else {
    lines.push(`All locales differ from \`${previousTag}\`.`);
  }
  return `${lines.join("\n")}\n`;
}

/** @param {string[]} args */
async function git(args) {
  const { stdout } = await execFile("git", args, {
    cwd: repoRoot,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

async function previousReleaseTag() {
  try {
    return (await git(["describe", "--tags", "--abbrev=0", "--match", "v*"])).trim();
  } catch {
    return null;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const current = JSON.parse(
      await readFile(path.join(repoRoot, metadataPath), "utf8"),
    );
    const previousTag = await previousReleaseTag();
    let previous = {};
    if (previousTag !== null) {
      try {
        previous = JSON.parse(await git(["show", `${previousTag}:${metadataPath}`]));
      } catch {
        previous = {};
      }
    }
    const locales = Object.keys(releaseNotesByLocale(current));
    const needing =
      previousTag === null ? locales : localesNeedingReleaseNotes(current, previous);
    process.stdout.write(
      renderReleaseNotesChecklist({ locales, needing, previousTag }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`check-store-release-notes: ${message}\n`);
    process.exit(1);
  }
}
