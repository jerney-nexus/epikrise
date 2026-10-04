import { cp, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deriveReleaseVersions } from "./prepare-release.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

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
    platform: "windows-x86_64",
    suffixes: [".exe", ".exe.sig"],
    updaterSuffix: ".exe",
  },
  "aarch64-pc-windows-msvc": {
    platform: "windows-aarch64",
    suffixes: [".exe", ".exe.sig"],
    updaterSuffix: ".exe",
  },
};

/** @param {unknown} condition @param {string} message */
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
 * @param {{ target: string, bundleRoot: string, stageRoot: string }} options
 * @returns {Promise<string[]>}
 */
export async function stageReleaseArtifacts({ target, bundleRoot, stageRoot }) {
  const config = targetConfig[/** @type {keyof typeof targetConfig} */ (target)];
  assert(config, `Unsupported release target: ${target}.`);

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
  return assetNames;
}

/**
 * @param {{ tag: string, packageVersion: string, repository: string, artifactsRoot: string, pubDate?: string }} options
 */
export async function createLatestManifest({
  tag,
  packageVersion,
  repository,
  artifactsRoot,
  pubDate = new Date().toISOString(),
}) {
  const { updateProtocolVersion } = validateReleaseTag(tag, packageVersion);
  assert(
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository),
    "Repository must be OWNER/REPO.",
  );
  assert(!Number.isNaN(Date.parse(pubDate)), "Publication date must be RFC 3339.");

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
    assert(
      files.length === config.suffixes.length,
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
  if (command === "stage") {
    await stageReleaseArtifacts({
      target: options.target,
      bundleRoot: options["bundle-root"],
      stageRoot: options["stage-root"],
    });
    return;
  }
  assert(
    command === "latest",
    "Usage: release-artifacts.mjs validate|validate-draft|stage|latest [options]",
  );
  const manifest = await createLatestManifest({
    tag: options.tag,
    packageVersion: packageJson.version,
    repository: options.repository,
    artifactsRoot: options["artifacts-root"],
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
