import { execFile as execFileCallback } from "node:child_process";
import {
  appendFile,
  cp,
  mkdtemp,
  realpath,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import TOML from "@iarna/toml";

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

/** @param {string} version */
export function deriveReleaseVersions(version) {
  validateCalverVersion(version);
  const [yearText, monthText, patchText] = version.split(".");
  const year = Number(yearText);
  const month = Number(monthText);
  const patch = BigInt(patchText);

  if (year < 2000 || year > 2255) {
    throw new Error("Release year must be between 2000 and 2255 for MSI.");
  }
  if (patch > 65535n) {
    throw new Error("Release patch must be at most 65535 for MSI and MSIX.");
  }

  return {
    releaseVersion: version,
    updateProtocolVersion: `${year}.${month}.${patch}`,
    msiProductVersion: `${year - 2000}.${month}.${patch}`,
    msixIdentityVersion: `${year}.${month}.${patch}.0`,
  };
}

/** @param {string} version */
export function releaseVersionFromProtocolVersion(version) {
  const match = /^(\d{4})\.([1-9]|1[0-2])\.(0|[1-9]\d*)$/.exec(version);
  if (!match) throw new Error(`Invalid update protocol version: ${version}.`);
  const releaseVersion = `${match[1]}.${match[2].padStart(2, "0")}.${match[3]}`;
  deriveReleaseVersions(releaseVersion);
  return releaseVersion;
}

/** @param {string} releaseVersion @param {string} publishedStoreVersion */
export function assertStoreVersionAdvances(releaseVersion, publishedStoreVersion) {
  const next = deriveReleaseVersions(releaseVersion).msixIdentityVersion;
  const published = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(publishedStoreVersion);
  if (!published || published.slice(1).some((part) => BigInt(part) > 65535n)) {
    throw new Error(`Invalid published Store version: ${publishedStoreVersion}.`);
  }
  const nextParts = next.split(".").map(BigInt);
  const publishedParts = published.slice(1).map(BigInt);
  const comparison = nextParts.findIndex(
    (part, index) => part !== publishedParts[index],
  );
  if (comparison < 0 || nextParts[comparison] < publishedParts[comparison]) {
    throw new Error(
      `Store version ${next} must be greater than ${publishedStoreVersion}.`,
    );
  }
  return next;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {string} workspaceRoot */
export async function prepareReleaseBuildInputs(workspaceRoot) {
  const buildRoot = await realpath(path.resolve(workspaceRoot));
  const sourceRoot = await realpath(repoRoot);
  if (buildRoot === sourceRoot) {
    throw new Error("Release version normalization requires a disposable workspace.");
  }

  const packagePath = path.join(buildRoot, "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  const versions = deriveReleaseVersions(packageJson.version);
  const cargoManifestPath = path.join(buildRoot, "src-tauri/Cargo.toml");
  let cargoManifest = await readFile(cargoManifestPath, "utf8");
  const cargoData = TOML.parse(cargoManifest);
  if (
    !isRecord(cargoData) ||
    !isRecord(cargoData.package) ||
    !isRecord(cargoData.workspace) ||
    !isRecord(cargoData.workspace.package) ||
    cargoData.package?.version !== versions.releaseVersion ||
    cargoData.workspace?.package?.version !== versions.releaseVersion
  ) {
    throw new Error(
      "Disposable Cargo versions do not match the original release version.",
    );
  }
  cargoManifest = replaceCargoSectionVersion(
    cargoManifest,
    "package",
    versions.updateProtocolVersion,
  );
  cargoManifest = replaceCargoSectionVersion(
    cargoManifest,
    "workspace.package",
    versions.updateProtocolVersion,
  );

  const tauriConfigPath = path.join(buildRoot, "src-tauri/tauri.conf.json");
  const tauriConfig = JSON.parse(await readFile(tauriConfigPath, "utf8"));
  if (tauriConfig.version !== versions.releaseVersion) {
    throw new Error("Disposable Tauri version does not match package.json.");
  }
  tauriConfig.version = versions.updateProtocolVersion;
  tauriConfig.bundle ??= {};
  tauriConfig.bundle.windows ??= {};
  tauriConfig.bundle.windows.wix ??= {};
  tauriConfig.bundle.windows.wix.version = versions.msiProductVersion;

  await writeFile(cargoManifestPath, cargoManifest);
  await writeFile(tauriConfigPath, `${JSON.stringify(tauriConfig, null, 2)}\n`);

  const cargoOptions = {
    cwd: buildRoot,
    maxBuffer: 10 * 1024 * 1024,
  };
  await execFile(
    "cargo",
    [
      "metadata",
      "--format-version",
      "1",
      "--no-deps",
      "--offline",
      "--manifest-path",
      cargoManifestPath,
    ],
    cargoOptions,
  );
  await execFile(
    "cargo",
    [
      "metadata",
      "--format-version",
      "1",
      "--no-deps",
      "--offline",
      "--locked",
      "--manifest-path",
      cargoManifestPath,
    ],
    cargoOptions,
  );
  return versions;
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

  const validationRoot = await mkdtemp(path.join(tmpdir(), "epikrise-release-inputs-"));
  try {
    await cp(packagePath, path.join(validationRoot, "package.json"));
    await cp(path.join(repoRoot, "src-tauri"), path.join(validationRoot, "src-tauri"), {
      recursive: true,
      filter: (source) =>
        !["target", "resources", "binaries", "gen", "WixTools"].some((directory) =>
          source.split(path.sep).includes(directory),
        ),
    });
    await prepareReleaseBuildInputs(validationRoot);
  } finally {
    await rm(validationRoot, { recursive: true, force: true });
  }

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
  const command = process.argv[2] ?? "";
  const operation =
    command === "--prepare-build-inputs"
      ? prepareReleaseBuildInputs(process.argv[3] ?? "")
      : prepareRelease(command);
  operation.catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
