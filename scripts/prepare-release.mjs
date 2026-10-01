import { execFile as execFileCallback } from "node:child_process";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFile = promisify(execFileCallback);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const calverPattern = /^(\d{4})\.(0[1-9]|1[0-2])\.(0|[1-9]\d*)$/;

/** @param {string} version */
export function validateCalverVersion(version) {
  if (!calverPattern.test(version)) {
    throw new Error(`Invalid CalVer version: ${version}. Expected YYYY.MM.PATCH.`);
  }
  return version;
}

/** @param {string} currentVersion @param {Date} [date] */
export function nextCalverVersion(currentVersion, date = new Date()) {
  validateCalverVersion(currentVersion);
  const [currentYear, currentMonth, currentPatch] = currentVersion
    .split(".")
    .map(Number);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;

  if (year < currentYear || (year === currentYear && month < currentMonth)) {
    throw new Error("The current date is earlier than the project version.");
  }
  if (year === currentYear && month === currentMonth) {
    return `${year}.${String(month).padStart(2, "0")}.${currentPatch + 1}`;
  }
  return `${year}.${String(month).padStart(2, "0")}.0`;
}

/** @param {string} left @param {string} right */
function compareVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index];
    }
  }
  return 0;
}

/** @param {string} source @param {string} sectionName @param {string} version */
function replaceCargoSectionVersion(source, sectionName, version) {
  const sectionStart = source.indexOf(`[${sectionName}]`);
  if (sectionStart < 0) throw new Error(`Missing Cargo section: ${sectionName}`);
  const nextSectionStart = source.indexOf("\n[", sectionStart + 1);
  const sectionEnd = nextSectionStart < 0 ? source.length : nextSectionStart;
  const section = source.slice(sectionStart, sectionEnd);
  const updated = section.replace(/^version = "[^"]+"$/m, `version = "${version}"`);
  if (updated === section)
    throw new Error(`Missing version in Cargo section: ${sectionName}`);
  return source.slice(0, sectionStart) + updated + source.slice(sectionEnd);
}

/** @param {string} changelog @param {string} generatedNotes @param {string} version @param {string} previousVersion */
export function createReleasedChangelog(
  changelog,
  generatedNotes,
  version,
  previousVersion,
) {
  const heading = "## [Unreleased]";
  const headingStart = changelog.indexOf(heading);
  if (headingStart < 0)
    throw new Error("CHANGELOG.md is missing its Unreleased section.");

  const bodyStart = headingStart + heading.length;
  const nextHeading = changelog.slice(bodyStart).search(/^## \[/m);
  const unreleasedLink = changelog.slice(bodyStart).search(/^\[Unreleased\]:/m);
  const boundaries = [nextHeading, unreleasedLink]
    .filter((index) => index >= 0)
    .map((index) => bodyStart + index);
  const bodyEnd = boundaries.length ? Math.min(...boundaries) : changelog.length;
  const unreleasedBody = changelog.slice(bodyStart, bodyEnd).trim();
  const generatedBody = generatedNotes.replace(/^## \[[^\]]+\].*\n/m, "").trim();
  const date = new Date().toISOString().slice(0, 10);
  const releaseBody = [unreleasedBody, generatedBody].filter(Boolean).join("\n\n");
  const releasedSection = `## [${version}] - ${date}\n\n${releaseBody}`;
  const prefix = changelog.slice(0, headingStart);
  const suffix = changelog.slice(bodyEnd).trimStart();
  let updated = `${prefix}${heading}\n\n${releasedSection}\n\n${suffix}`;

  const baseUrl = "https://github.com/jerney-nexus/epikrise/compare";
  const versionReference = `[${version}]: ${baseUrl}/v${previousVersion}...v${version}`;
  const unreleasedReference = `[Unreleased]: ${baseUrl}/v${version}...HEAD`;
  if (!/^\[Unreleased\]:/m.test(updated)) {
    throw new Error("CHANGELOG.md is missing its Unreleased link reference.");
  }
  updated = updated.replace(
    /^\[Unreleased\]:.*$/m,
    `${versionReference}\n${unreleasedReference}`,
  );
  return updated;
}

/** @param {string} requestedVersion */
async function prepareRelease(requestedVersion) {
  const packagePath = path.join(repoRoot, "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  const previousVersion = validateCalverVersion(packageJson.version);
  const version = validateCalverVersion(
    requestedVersion || nextCalverVersion(previousVersion),
  );
  if (compareVersions(version, previousVersion) <= 0) {
    throw new Error(
      `Release version ${version} must be greater than ${previousVersion}.`,
    );
  }

  const { stdout: generatedNotes } = await execFile(
    "git-cliff",
    ["--tag", `v${version}`],
    { cwd: repoRoot, maxBuffer: 10 * 1024 * 1024 },
  );
  if (!generatedNotes.trim()) throw new Error("git-cliff generated no release notes.");

  packageJson.version = version;
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

  const tauriConfigPath = path.join(repoRoot, "src-tauri/tauri.conf.json");
  const tauriConfig = JSON.parse(await readFile(tauriConfigPath, "utf8"));
  tauriConfig.version = version;
  await writeFile(tauriConfigPath, `${JSON.stringify(tauriConfig, null, 2)}\n`);

  const cargoManifestPath = path.join(repoRoot, "src-tauri/Cargo.toml");
  let cargoManifest = await readFile(cargoManifestPath, "utf8");
  cargoManifest = replaceCargoSectionVersion(cargoManifest, "package", version);
  cargoManifest = replaceCargoSectionVersion(
    cargoManifest,
    "workspace.package",
    version,
  );
  await writeFile(cargoManifestPath, cargoManifest);
  await execFile(
    "cargo",
    ["metadata", "--format-version", "1", "--manifest-path", cargoManifestPath],
    { cwd: repoRoot, maxBuffer: 10 * 1024 * 1024 },
  );

  const changelogPath = path.join(repoRoot, "CHANGELOG.md");
  const changelog = await readFile(changelogPath, "utf8");
  await writeFile(
    changelogPath,
    createReleasedChangelog(changelog, generatedNotes, version, previousVersion),
  );

  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `version=${version}\n`);
  }
  process.stdout.write(`Prepared release ${version}.\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  prepareRelease(process.argv[2] ?? "").catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
