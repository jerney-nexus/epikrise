import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { deriveReleaseVersions } from "./prepare-release.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const execFile = promisify(execFileCallback);

/** @typedef {{ path: string, size_bytes: number, sha256: string }} FileEvidence */
/** @typedef {{ schema_version: number, target: string, architecture: string, architecture_verified: boolean, commit: string, version: string, assets: FileEvidence[], resources: FileEvidence[] }} ReleaseIntegrityManifest */

export const releaseTargets = /** @type {const} */ ([
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
  "x86_64-apple-darwin",
  "aarch64-apple-darwin",
  "x86_64-pc-windows-msvc",
  "aarch64-pc-windows-msvc",
]);

const targetConfig = {
  "x86_64-unknown-linux-gnu": {
    platform: "linux-x86_64",
    suffixes: [".deb", ".rpm", ".AppImage", ".AppImage.sig"],
    updaterSuffix: ".AppImage",
  },
  "aarch64-unknown-linux-gnu": {
    platform: "linux-aarch64",
    suffixes: [".deb", ".rpm", ".AppImage", ".AppImage.sig"],
    updaterSuffix: ".AppImage",
  },
  "x86_64-apple-darwin": {
    platform: "darwin-x86_64",
    suffixes: [".dmg", ".app.tar.gz", ".app.tar.gz.sig"],
    updaterSuffix: ".app.tar.gz",
  },
  "aarch64-apple-darwin": {
    platform: "darwin-aarch64",
    suffixes: [".dmg", ".app.tar.gz", ".app.tar.gz.sig"],
    updaterSuffix: ".app.tar.gz",
  },
  "x86_64-pc-windows-msvc": {
    platform: "windows-x86_64-nsis",
    suffixes: [".exe", ".exe.sig"],
    updaterSuffix: ".exe",
  },
  "aarch64-pc-windows-msvc": {
    platform: "windows-aarch64-nsis",
    suffixes: [".exe", ".exe.sig"],
    updaterSuffix: ".exe",
  },
};

/** @param {unknown} condition @param {string} message @returns {asserts condition} */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** @param {unknown} error */
function isNotFoundError(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** @param {string} directory @returns {Promise<string[]>} */
async function collectFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(entryPath)));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files.sort();
}

/** @param {string} filePath */
async function sha256(filePath) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return digest.digest("hex");
}

/** @param {string} filePath @param {string} relativePath */
async function fileEvidence(filePath, relativePath) {
  const metadata = await lstat(filePath);
  assert(
    metadata.isFile() && !metadata.isSymbolicLink(),
    `Release evidence is not a regular file: ${relativePath}.`,
  );
  return {
    path: relativePath,
    size_bytes: metadata.size,
    sha256: await sha256(filePath),
  };
}

/** @param {string} bundlePath @param {string} signature @param {string} publicKey */
async function verifyUpdaterSignature(bundlePath, signature, publicKey) {
  const directory = await mkdtemp(path.join(tmpdir(), "epikrise-minisign-"));
  try {
    const signaturePath = path.join(directory, "bundle.sig");
    const publicKeyPath = path.join(directory, "updater.pub");
    const signatureContents = Buffer.from(signature, "base64");
    assert(
      signatureContents.toString("base64") === signature,
      "Updater signature is not valid base64.",
    );
    await writeFile(signaturePath, signatureContents);
    await writeFile(publicKeyPath, publicKey);
    await execFile("minisign", [
      "-V",
      "-p",
      publicKeyPath,
      "-m",
      bundlePath,
      "-x",
      signaturePath,
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** @param {string} tag @param {string} packageVersion */
export function validateReleaseTag(tag, packageVersion) {
  assert(
    /^v\d{4}\.(0[1-9]|1[0-2])\.(0|[1-9]\d*)$/.test(tag),
    "Release tag must use vYYYY.MM.PATCH.",
  );
  const releaseVersion = tag.slice(1);
  assert(
    releaseVersion === packageVersion,
    "Release tag must match package.json's padded CalVer version.",
  );
  const { updateProtocolVersion } = deriveReleaseVersions(releaseVersion);
  return { tag, releaseVersion, updateProtocolVersion };
}

/** @param {string} tag */
function releaseTagParts(tag) {
  const match = /^v(\d{4})\.(0[1-9]|1[0-2])\.(0|[1-9]\d*)$/.exec(tag);
  assert(match, `Release tag is not padded CalVer: ${tag}.`);
  return [Number(match[1]), Number(match[2]), BigInt(match[3])];
}

/** @param {string} candidateTag @param {string | undefined} latestTag */
export function shouldPromoteLatest(candidateTag, latestTag) {
  const candidate = releaseTagParts(candidateTag);
  if (!latestTag) return true;
  const latest = releaseTagParts(latestTag);
  for (let index = 0; index < candidate.length; index += 1) {
    if (candidate[index] > latest[index]) return true;
    if (candidate[index] < latest[index]) return false;
  }
  return true;
}

/** @param {unknown} release @param {string} tag @param {string} commit */
export function assertRecoverableReleaseDraft(release, tag, commit) {
  assert(
    typeof release === "object" && release !== null && !Array.isArray(release),
    "Existing release metadata is invalid.",
  );
  const metadata = /** @type {Record<string, unknown>} */ (release);
  assert(metadata.isDraft === true, "Only an existing draft release can be recovered.");
  assert(metadata.tagName === tag, "Existing draft tag does not match.");
  assert(/^[0-9a-f]{40}$/.test(commit), "Release commit must be a full SHA.");
  const marker = `<!-- epikrise-signed-release-commit:${commit} -->`;
  assert(
    typeof metadata.body === "string" && metadata.body.includes(marker),
    "Existing draft was not created for this commit.",
  );
}

/**
 * @param {{ target: string, bundleRoot: string, stageRoot: string, commit: string, version: string, resourceRoot: string, binaryRoot: string }} options
 * @returns {Promise<string[]>}
 */
export async function stageReleaseArtifacts({
  target,
  bundleRoot,
  stageRoot,
  commit,
  version,
  resourceRoot,
  binaryRoot,
}) {
  const config = targetConfig[/** @type {keyof typeof targetConfig} */ (target)];
  assert(config, `Unsupported release target: ${target}.`);
  assert(/^[0-9a-f]{40}$/.test(commit), "Release commit must be a full Git SHA.");
  assert(
    /^[0-9]{4}\.(0[1-9]|1[0-2])\.(0|[1-9][0-9]*)$/.test(version),
    "Release version must use padded CalVer.",
  );

  try {
    await lstat(stageRoot);
    throw new Error(`Release staging directory already exists: ${stageRoot}.`);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }

  const files = await collectFiles(bundleRoot);
  const selected = [];
  for (const suffix of config.suffixes) {
    const matches = files.filter((file) => path.basename(file).endsWith(suffix));
    assert(
      matches.length === 1,
      `Expected exactly one ${suffix} artifact for ${target}, found ${matches.length}.`,
    );
    selected.push(matches[0]);
  }

  await mkdir(stageRoot, { recursive: true });
  const assetNames = [];
  for (const sourcePath of selected) {
    const metadata = await lstat(sourcePath);
    assert(
      metadata.isFile() && !metadata.isSymbolicLink(),
      "Release assets must be regular files.",
    );
    const assetName = `${target}-${path.basename(sourcePath)}`;
    await cp(sourcePath, path.join(stageRoot, assetName), { errorOnExist: true });
    if (assetName.endsWith(".sig")) {
      assert(
        (await readFile(path.join(stageRoot, assetName), "utf8")).trim().length > 0,
        `Updater signature is empty for ${target}.`,
      );
    }
    assetNames.push(assetName);
  }

  const pdfiumName = target.includes("apple-darwin")
    ? "libpdfium.dylib"
    : target.includes("windows-msvc")
      ? "pdfium.dll"
      : "libpdfium.so";
  const tesseractName = target.includes("windows-msvc")
    ? `tesseract-${target}.exe`
    : `tesseract-${target}`;
  const resourceFiles = await Promise.all(
    [
      [path.join(resourceRoot, "pdfium", pdfiumName), `pdfium/${pdfiumName}`],
      [
        path.join(resourceRoot, "tessdata", "deu.traineddata"),
        "tessdata/deu.traineddata",
      ],
      [
        path.join(resourceRoot, "tessdata", "eng.traineddata"),
        "tessdata/eng.traineddata",
      ],
      [path.join(binaryRoot, tesseractName), `binaries/${tesseractName}`],
    ].map(([filePath, relativePath]) => fileEvidence(filePath, relativePath)),
  );
  const assetFiles = await Promise.all(
    assetNames.map((name) => fileEvidence(path.join(stageRoot, name), name)),
  );
  const architecture = target.startsWith("aarch64-") ? "arm64" : "x86_64";
  const integrityManifest = {
    schema_version: 1,
    target,
    architecture,
    architecture_verified: true,
    commit,
    version,
    assets: assetFiles,
    resources: resourceFiles,
  };
  await writeFile(
    path.join(stageRoot, `${target}-manifest.json`),
    `${JSON.stringify(integrityManifest, null, 2)}\n`,
    { flag: "wx" },
  );
  return assetNames;
}

/**
 * @param {{ tag: string, packageVersion: string, repository: string, artifactsRoot: string, commit?: string, pubDate?: string, signatureVerifier?: typeof verifyUpdaterSignature }} options
 */
export async function createLatestManifest({
  tag,
  packageVersion,
  repository,
  artifactsRoot,
  commit,
  pubDate = new Date().toISOString(),
  signatureVerifier = verifyUpdaterSignature,
}) {
  const { updateProtocolVersion } = validateReleaseTag(tag, packageVersion);
  assert(
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository),
    "Repository must be OWNER/REPO.",
  );
  assert(!Number.isNaN(Date.parse(pubDate)), "Publication date must be RFC 3339.");

  const releaseConfig = JSON.parse(
    await readFile(path.join(repoRoot, "src-tauri/tauri.release.conf.json"), "utf8"),
  );
  const publicKey = Buffer.from(
    releaseConfig.plugins.updater.pubkey,
    "base64",
  ).toString("utf8");

  /** @type {Record<string, { signature: string, url: string }>} */
  const platforms = {};
  for (const target of releaseTargets) {
    const config = targetConfig[target];
    const targetDirectory = path.join(artifactsRoot, `release-${target}`);
    const files = await readdir(targetDirectory);
    for (const suffix of config.suffixes) {
      assert(
        files.filter((name) => name.endsWith(suffix)).length === 1,
        `Expected exactly one ${suffix} asset for ${target}.`,
      );
    }
    const integrityName = `${target}-manifest.json`;
    assert(
      files.includes(integrityName),
      `Integrity manifest is missing for ${target}.`,
    );
    /** @type {ReleaseIntegrityManifest} */
    const integrity = JSON.parse(
      await readFile(path.join(targetDirectory, integrityName), "utf8"),
    );
    assert(
      integrity.schema_version === 1,
      "Unsupported release integrity manifest schema.",
    );
    assert(
      integrity.target === target,
      `Integrity manifest target does not match ${target}.`,
    );
    assert(
      integrity.architecture_verified === true,
      `Architecture was not verified for ${target}.`,
    );
    assert(
      integrity.commit === (commit ?? integrity.commit),
      `Integrity commit does not match ${target}.`,
    );
    assert(
      integrity.version === packageVersion,
      `Integrity version does not match ${target}.`,
    );
    assert(
      Array.isArray(integrity.assets) && Array.isArray(integrity.resources),
      "Integrity manifest entries are invalid.",
    );
    assert(
      integrity.resources.length === 4,
      `OCR resource evidence is incomplete for ${target}.`,
    );
    const assetNames = new Set(integrity.assets.map((asset) => asset.path));
    assert(
      files.length === integrity.assets.length + 1 &&
        files.every((name) => name === integrityName || assetNames.has(name)),
      `Integrity manifest asset set does not match ${target}.`,
    );
    for (const asset of integrity.assets) {
      assert(
        /^[0-9a-f]{64}$/.test(asset.sha256),
        `Asset hash is invalid for ${target}.`,
      );
      const evidence = await fileEvidence(
        path.join(targetDirectory, asset.path),
        asset.path,
      );
      assert(
        evidence.size_bytes === asset.size_bytes && evidence.sha256 === asset.sha256,
        `Release asset integrity check failed: ${asset.path}.`,
      );
    }
    assert(
      files.length === config.suffixes.length + 1,
      `Unexpected release assets for ${target}.`,
    );
    const updateBundles = files.filter((name) => name.endsWith(config.updaterSuffix));
    assert(
      updateBundles.length === 1,
      `Expected exactly one updater bundle for ${target}.`,
    );
    const bundleName = updateBundles[0];
    const signatureName = `${bundleName}.sig`;
    assert(
      files.includes(signatureName),
      `Updater signature is missing for ${target}.`,
    );

    for (const name of files) {
      const metadata = await lstat(path.join(targetDirectory, name));
      assert(
        metadata.isFile() && !metadata.isSymbolicLink(),
        "Release assets must be regular files.",
      );
    }
    const signature = (
      await readFile(path.join(targetDirectory, signatureName), "utf8")
    ).trim();
    assert(signature.length > 0, `Updater signature is empty for ${target}.`);
    await signatureVerifier(
      path.join(targetDirectory, bundleName),
      signature,
      publicKey,
    );
    platforms[config.platform] = {
      signature,
      url: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(bundleName)}`,
    };
  }

  return {
    version: updateProtocolVersion,
    pub_date: new Date(pubDate).toISOString(),
    platforms,
  };
}

/**
 * @param {{ artifactsRoot: string, latestPath: string, uploadedRoot: string, releaseAssets: unknown }} options
 */
export async function verifyUploadedReleaseAssets({
  artifactsRoot,
  latestPath,
  uploadedRoot,
  releaseAssets,
}) {
  assert(Array.isArray(releaseAssets), "Release asset metadata is invalid.");

  /** @type {Map<string, { size_bytes: number, sha256: string }>} */
  const expected = new Map();
  for (const target of releaseTargets) {
    const directory = path.join(artifactsRoot, `release-${target}`);
    for (const name of await readdir(directory)) {
      assert(
        path.basename(name) === name,
        `Unsafe staged release asset name: ${name}.`,
      );
      assert(!expected.has(name), `Duplicate staged release asset name: ${name}.`);
      const evidence = await fileEvidence(path.join(directory, name), name);
      expected.set(name, {
        size_bytes: evidence.size_bytes,
        sha256: evidence.sha256,
      });
    }
  }
  const latestName = path.basename(latestPath);
  assert(latestName === "latest.json", "Updater manifest must be named latest.json.");
  assert(
    !expected.has(latestName),
    "latest.json collides with a staged release asset.",
  );
  const latestEvidence = await fileEvidence(latestPath, latestName);
  expected.set(latestName, {
    size_bytes: latestEvidence.size_bytes,
    sha256: latestEvidence.sha256,
  });

  /** @type {Map<string, number>} */
  const metadata = new Map();
  for (const asset of releaseAssets) {
    assert(
      typeof asset === "object" && asset !== null && !Array.isArray(asset),
      "Release asset metadata entry is invalid.",
    );
    const item = /** @type {Record<string, unknown>} */ (asset);
    assert(typeof item.name === "string", "Release asset name is missing.");
    assert(
      path.basename(item.name) === item.name &&
        Number.isSafeInteger(item.size) &&
        Number(item.size) >= 0,
      `Release asset metadata is invalid: ${item.name}.`,
    );
    assert(!metadata.has(item.name), `Duplicate uploaded release asset: ${item.name}.`);
    metadata.set(item.name, Number(item.size));
  }

  const downloadedEntries = await readdir(uploadedRoot, { withFileTypes: true });
  const downloaded = new Map();
  for (const entry of downloadedEntries) {
    assert(
      entry.isFile(),
      `Downloaded release asset is not a regular file: ${entry.name}.`,
    );
    downloaded.set(entry.name, path.join(uploadedRoot, entry.name));
  }
  const expectedNames = [...expected.keys()].sort();
  const metadataNames = [...metadata.keys()].sort();
  const downloadedNames = [...downloaded.keys()].sort();
  assert(
    JSON.stringify(metadataNames) === JSON.stringify(expectedNames),
    "Uploaded release asset names do not match staged assets.",
  );
  assert(
    JSON.stringify(downloadedNames) === JSON.stringify(expectedNames),
    "Downloaded release asset names do not match staged assets.",
  );

  for (const name of expectedNames) {
    const uploadedEvidence = await fileEvidence(downloaded.get(name), name);
    const expectedEvidence = expected.get(name);
    assert(expectedEvidence, `Staged release asset is missing: ${name}.`);
    assert(
      metadata.get(name) === expectedEvidence.size_bytes &&
        uploadedEvidence.size_bytes === expectedEvidence.size_bytes &&
        uploadedEvidence.sha256 === expectedEvidence.sha256,
      `Uploaded release asset does not match staged bytes: ${name}.`,
    );
  }
}

/** @param {string[]} args @returns {Record<string, string>} */
function parseOptions(args) {
  const options = /** @type {Record<string, string>} */ ({});
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    assert(key.startsWith("--"), `Unexpected argument: ${key}.`);
    const value = args[index + 1];
    assert(value && !value.startsWith("--"), `Missing value for ${key}.`);
    options[key.slice(2)] = value;
    index += 1;
  }
  return options;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const options = parseOptions(args);
  const packageJson = JSON.parse(
    await readFile(path.join(repoRoot, "package.json"), "utf8"),
  );

  if (command === "validate") {
    validateReleaseTag(options.tag, packageJson.version);
    return;
  }
  if (command === "validate-draft") {
    const release = JSON.parse(await readFile(options["release-file"], "utf8"));
    assertRecoverableReleaseDraft(release, options.tag, options.commit);
    return;
  }
  if (command === "should-promote-latest") {
    process.stdout.write(
      `${shouldPromoteLatest(options.tag, options["latest-tag"] || undefined)}\n`,
    );
    return;
  }
  if (command === "verify-uploaded") {
    const release = JSON.parse(await readFile(options["release-file"], "utf8"));
    await verifyUploadedReleaseAssets({
      artifactsRoot: options["artifacts-root"],
      latestPath: options["latest-file"],
      uploadedRoot: options["uploaded-root"],
      releaseAssets: release.assets,
    });
    return;
  }
  if (command === "stage") {
    const packageJson = JSON.parse(
      await readFile(path.join(repoRoot, "package.json"), "utf8"),
    );
    await stageReleaseArtifacts({
      target: options.target,
      bundleRoot: options["bundle-root"],
      stageRoot: options["stage-root"],
      commit: options.commit,
      version: packageJson.version,
      resourceRoot: options["resource-root"],
      binaryRoot: options["binary-root"],
    });
    return;
  }
  assert(
    command === "latest",
    "Usage: release-artifacts.mjs validate|validate-draft|should-promote-latest|stage|latest|verify-uploaded [options]",
  );
  const manifest = await createLatestManifest({
    tag: options.tag,
    packageVersion: packageJson.version,
    repository: options.repository,
    artifactsRoot: options["artifacts-root"],
    commit: options.commit,
  });
  await writeFile(options.output, `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: "wx",
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
