#!/usr/bin/env node
// Exports Fluent catalog messages to CSV for native-speaker review and imports
// reviewed CSV files back into locales/<locale>/app.ftl.
// Usage:
//   node scripts/translation-review.mjs export <locale> [output-dir]
//   node scripts/translation-review.mjs import <locale> <csv-file> [--apply]
// Import is a dry run unless --apply is passed. Nothing is written when any row fails.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { FluentResource } from "@fluent/bundle";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceLocale = "en";
const referenceLocale = "de-CH";
const defaultOutputDir = join(repoRoot, "templates", "translation-review");
const headers = ["message_id", "english", "reference", "translation", "comment"];
const messageLine = /^([a-z][a-z0-9-]*) = (.*?)(\r?)$/;

/** @param {string} text */
export function parseCatalog(text) {
  return [...text.matchAll(new RegExp(messageLine.source, "gm"))].map((match) => ({
    id: match[1],
    value: match[2],
  }));
}

/** @param {string} text @param {Map<string, string>} replacements */
export function applyTranslations(text, replacements) {
  return text.replace(new RegExp(messageLine.source, "gm"), (line, id, value, cr) =>
    replacements.has(id) ? `${id} = ${replacements.get(id)}${cr}` : line,
  );
}

/** @param {string} value */
export function placeholderNames(value) {
  return [
    ...new Set([...value.matchAll(/\$([a-zA-Z][a-zA-Z0-9_-]*)/g)].map((m) => m[1])),
  ].sort();
}

/** @param {string} id @param {string} value @param {string} english @returns {string[]} */
export function translationProblems(id, value, english) {
  const problems = [];
  if (value.trim() === "") problems.push("translation is blank");
  if (value !== value.trim())
    problems.push("translation has leading or trailing spaces");
  if (/[\r\n]/.test(value)) problems.push("translation must be a single line");
  const expected = placeholderNames(english).join(", ");
  const found = placeholderNames(value).join(", ");
  if (expected !== found) {
    problems.push(
      `placeholders differ (expected: ${expected || "none"}; found: ${found || "none"})`,
    );
  }
  const entries = new FluentResource(`${id} = ${value}\n`).body;
  if (entries.length !== 1 || entries[0].id !== id) {
    problems.push("translation is not valid Fluent syntax");
  }
  return problems;
}

/** @param {string[][]} rows @param {string} delimiter */
export function serializeCsv(rows, delimiter) {
  const quote = (field) =>
    /[";,\r\n]|"/.test(field) || field !== field.trim() || field.includes(delimiter)
      ? `"${field.replaceAll('"', '""')}"`
      : field;
  return (
    rows
      .map((row) => row.map((field) => quote(field ?? "")).join(delimiter))
      .join("\r\n") + "\r\n"
  );
}

/** @param {string} text @param {string} delimiter @returns {string[][]} */
export function parseCsv(text, delimiter) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\r" || char === "\n") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell !== ""));
}

/** @param {string} text */
export function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/)[0];
  return firstLine.split(";").length > firstLine.split(",").length ? ";" : ",";
}

async function readCatalog(locale) {
  return readFile(join(repoRoot, "locales", locale, "app.ftl"), "utf8");
}

async function exportLocale(locale, outputDir) {
  if (locale === sourceLocale)
    throw new Error("Export a target language, not English.");
  const [english, reference, target] = await Promise.all([
    readCatalog(sourceLocale),
    readCatalog(referenceLocale),
    readCatalog(locale),
  ]);
  const referenceValues = new Map(parseCatalog(reference).map((m) => [m.id, m.value]));
  const targetValues = new Map(parseCatalog(target).map((m) => [m.id, m.value]));
  const rows = [headers];
  const exported = new Set();
  for (const { id, value } of parseCatalog(english)) {
    if (exported.has(id)) continue;
    exported.add(id);
    rows.push([
      id,
      value,
      referenceValues.get(id) ?? "",
      targetValues.get(id) ?? "",
      "",
    ]);
  }
  await mkdir(outputDir, { recursive: true });
  const file = join(outputDir, `${locale}.csv`);
  // A UTF-8 byte order mark lets Excel show accented characters correctly.
  await writeFile(file, "\uFEFF" + serializeCsv(rows, ";"), "utf8");
  await writeFile(join(outputDir, "REVIEWER-GUIDE.txt"), reviewerGuide, "utf8");
  console.log(`Wrote ${rows.length - 1} messages to ${file}`);
}

async function importLocale(locale, file, apply) {
  if (locale === sourceLocale)
    throw new Error("Import a target language, not English.");
  const english = parseCatalog(await readCatalog(sourceLocale));
  const englishValues = new Map(english.map((m) => [m.id, m.value]));
  const targetText = await readCatalog(locale);
  const targetValues = new Map(parseCatalog(targetText).map((m) => [m.id, m.value]));

  const text = (await readFile(file, "utf8")).replace(/^\uFEFF/, "");
  const rows = parseCsv(text, detectDelimiter(text));
  const [header, ...body] = rows;
  const idIndex = header?.indexOf("message_id") ?? -1;
  const translationIndex = header?.indexOf("translation") ?? -1;
  if (idIndex < 0 || translationIndex < 0) {
    throw new Error("The CSV header must contain message_id and translation columns.");
  }

  const problems = [];
  const seen = new Set();
  const replacements = new Map();
  body.forEach((row, index) => {
    const line = index + 2;
    const id = row[idIndex] ?? "";
    const value = row[translationIndex] ?? "";
    if (!englishValues.has(id))
      return problems.push(`line ${line}: unknown message_id "${id}"`);
    if (seen.has(id))
      return problems.push(`line ${line}: duplicate message_id "${id}"`);
    seen.add(id);
    for (const problem of translationProblems(id, value, englishValues.get(id))) {
      problems.push(`line ${line} (${id}): ${problem}`);
    }
    if (value !== targetValues.get(id)) replacements.set(id, value);
  });
  for (const id of englishValues.keys()) {
    if (!seen.has(id)) problems.push(`missing message_id "${id}"`);
  }

  if (problems.length > 0) {
    throw new Error(`Import rejected, nothing written:\n  ${problems.join("\n  ")}`);
  }
  console.log(`Checked ${body.length} messages; ${replacements.size} would change.`);
  if (!apply) {
    console.log("Dry run. Pass --apply to write locales/" + locale + "/app.ftl.");
    return;
  }
  await writeFile(
    join(repoRoot, "locales", locale, "app.ftl"),
    applyTranslations(targetText, replacements),
    "utf8",
  );
  console.log(`Updated locales/${locale}/app.ftl.`);
}

const reviewerGuide = `Translation review guide
=======================

Thank you for reviewing the app text. Each file is one language. The
"translation" column holds the text the app shows today. Please check it and
correct it where it is wrong, unclear, or does not sound natural.

Opening the file
- Excel: Data > From Text/CSV, then choose semicolon (;) as the separator
  and UTF-8 as the encoding.
- LibreOffice or Google Sheets: choose semicolon (;) as the separator.

What to change
- Change only the "translation" column.
- Use the "english" and "reference" columns (German, Swiss) to check the meaning.
- Use the "comment" column for notes. These notes are not added to the app.

Rules
- Keep every placeholder such as { $name } or { $count } exactly as written.
  You may move it within the sentence, but do not rename or remove it.
- Keep each message on one line. Do not press Enter inside a cell.
- Do not add or remove rows, and do not change message_id values.
- Save the file as CSV (semicolon separated, UTF-8) when you are done.
`;

async function main() {
  const [command, locale, ...rest] = process.argv.slice(2);
  if (command === "export" && locale) {
    await exportLocale(locale, resolve(rest[0] ?? defaultOutputDir));
  } else if (
    command === "import" &&
    locale &&
    rest.some((arg) => !arg.startsWith("--"))
  ) {
    const file = rest.find((arg) => !arg.startsWith("--"));
    await importLocale(locale, resolve(file), rest.includes("--apply"));
  } else {
    console.error(
      "Usage:\n  node scripts/translation-review.mjs export <locale> [output-dir]\n" +
        "  node scripts/translation-review.mjs import <locale> <csv-file> [--apply]",
    );
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
