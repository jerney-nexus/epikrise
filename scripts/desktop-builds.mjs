import { createHash, randomUUID } from "node:crypto";
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
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { assertBuildProvenance, createBuildProvenance } from "./build-provenance.mjs";
import { deriveReleaseVersions } from "./prepare-release.mjs";
import { assertNativeBuildMetadata } from "./verify-native-build-environment.mjs";

const execFile = promisify(execFileCallback);
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const workflowPath = ".github/workflows/desktop-builds.yml";
export const desktopTargets = /** @type {const} */ ([
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
  "x86_64-apple-darwin",
  "aarch64-apple-darwin",
  "x86_64-pc-windows-msvc",
  "aarch64-pc-windows-msvc",
]);

/** @typedef {(typeof desktopTargets)[number]} DesktopTarget */
/** @typedef {{ databaseId: number, displayTitle: string, headSha: string, event: string }} WorkflowRun */
/** @typedef {{ name: string, conclusion: string | null }} WorkflowJob */
/** @typedef {"desktop" | "store-msix"} PackageFamily */
/** @typedef {{ runnerOS: string, runnerArch: string, rustHost: string, target: string, buildMode: string }} NativeBuildInput */
/** @typedef {{ runner_os: string, runner_arch: string, rust_host: string, target: string, build_mode: string }} NativeBuildEvidence */
/** @typedef {{ source: { commit: string, archive_sha256: string }, cache: { key: string, restored: boolean }, tool_versions: Record<string, string> }} BuildProvenance */
/** @typedef {{ schema_version: number, request_id: string, commit: string, target: DesktopTarget, package_family: PackageFamily, native_build: NativeBuildEvidence, source: { commit: string, archive_sha256: string }, cache: { key: string, restored: boolean }, tool_versions: Record<string, string>, version: string, signed: false, files: Array<{ path: string, size_bytes: number, sha256: string }> }} ArtifactManifest */
/** @typedef {{ requestId: string, commit: string, version: string, target: DesktopTarget, packageFamily: PackageFamily }} ArtifactExpectation */

const expectedSuffixes = {
  "x86_64-unknown-linux-gnu": [".deb", ".rpm", ".AppImage"],
  "aarch64-unknown-linux-gnu": [".deb", ".rpm", ".AppImage"],
  "x86_64-apple-darwin": [".dmg"],
  "aarch64-apple-darwin": [".dmg"],
  "x86_64-pc-windows-msvc": [".exe"],
  "aarch64-pc-windows-msvc": [".exe"],
};
const storeMsixTargets = new Set(["x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc"]);

/**
 * @param {DesktopTarget} target
 * @param {PackageFamily} packageFamily
 */
function packageSuffixes(target, packageFamily) {
  if (packageFamily === "store-msix") {
    return storeMsixTargets.has(target) ? [".msix"] : [];
  }
  return packageFamily === "desktop" ? expectedSuffixes[target] : [];
}

/** @param {unknown} condition @param {string} message */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** @param {unknown} error */
function isNotFoundError(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/**
 * @param {{ clean: boolean, branch: string, tag: string, commit: string, workflowPresent: boolean, pushedCommit: string }} preconditions
 */
export function assertDispatchPreconditions({
  clean,
  branch,
  tag,
  commit,
  workflowPresent,
  pushedCommit,
}) {
  assert(clean, "The worktree must be clean before dispatching desktop builds.");
  assert(
    (branch && branch !== "HEAD") || tag,
    "Build dispatch requires a pushed branch or tag.",
  );
  assert(/^[0-9a-f]{40}$/.test(commit), "HEAD must be a full Git commit SHA.");
  assert(workflowPresent, `HEAD does not contain ${workflowPath}.`);
  assert(
    pushedCommit === commit,
    "HEAD must be pushed to the matching origin branch before dispatching.",
  );
}

/**
 * @param {WorkflowRun[]} runs
 * @param {string} requestId
 * @param {string} commit
 * @returns {WorkflowRun | null}
 */
export function selectMatchingRun(runs, requestId, commit) {
  const expectedTitle = `Desktop builds ${requestId} @ ${commit}`;
  const matchingRequests = runs.filter((run) => run.displayTitle === expectedTitle);
  if (matchingRequests.length > 1) {
    throw new Error(`More than one Actions run matched request ${requestId}.`);
  }
  if (matchingRequests.length === 0) return null;

  const [run] = matchingRequests;
  assert(run.headSha === commit, "The Actions run is for a different commit.");
  assert(
    run.event === "workflow_dispatch",
    "The matched run was not manually dispatched.",
  );
  return run;
}

/** @param {WorkflowJob[]} jobs */
export function assertSuccessfulJobs(jobs) {
  const conclusions = new Map(jobs.map((job) => [job.name, job.conclusion]));
  for (const target of desktopTargets) {
    assert(
      conclusions.get(`Build ${target}`) === "success",
      `Required build job did not succeed: Build ${target}.`,
    );
  }
  assert(
    conclusions.size === desktopTargets.length,
    "The Actions run did not contain exactly the six required build jobs.",
  );
}

/** @param {string} filePath */
async function sha256(filePath) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return digest.digest("hex");
}

/** @param {string} directory @returns {Promise<string[]>} */
async function collectFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

/**
 * @param {string} stageRoot
 * @param {DesktopTarget} target
 * @param {string} commit
 * @param {string} requestId
 * @param {PackageFamily} packageFamily
 * @param {NativeBuildEvidence} nativeBuild
 * @param {BuildProvenance} buildProvenance
 * @returns {Promise<ArtifactManifest>}
 */
async function buildManifest(
  stageRoot,
  target,
  commit,
  requestId,
  packageFamily,
  nativeBuild,
  buildProvenance,
) {
  assert(desktopTargets.includes(target), `Unsupported desktop target: ${target}.`);
  assert(/^[0-9a-f]{40}$/.test(commit), "Commit must be a full Git SHA.");
  assert(/^[0-9a-f-]{36}$/.test(requestId), "Request ID must be a UUID.");

  const filesDirectory = path.join(stageRoot, "files");
  const stagedPaths = await collectFiles(filesDirectory);
  const suffixes = packageSuffixes(target, packageFamily);
  assert(
    suffixes.length > 0,
    `Unsupported ${packageFamily} package target: ${target}.`,
  );
  for (const suffix of suffixes) {
    const matches = stagedPaths.filter((filePath) => filePath.endsWith(suffix));
    assert(
      matches.length === 1,
      `Expected exactly one ${suffix} package for ${target}, found ${matches.length}.`,
    );
  }
  const packageFiles = [];
  for (const filePath of stagedPaths.sort()) {
    const metadata = await lstat(filePath);
    assert(
      metadata.isFile() && !metadata.isSymbolicLink(),
      "Artifact files must be regular files.",
    );
    packageFiles.push({
      path: path.posix.join("files", path.basename(filePath)),
      size_bytes: metadata.size,
      sha256: await sha256(filePath),
    });
  }
  assert(packageFiles.length > 0, `No packages were staged for ${target}.`);

  const packageJson = JSON.parse(
    await readFile(path.join(repoRoot, "package.json"), "utf8"),
  );
  return {
    schema_version: 3,
    request_id: requestId,
    commit,
    target,
    package_family: packageFamily,
    native_build: nativeBuild,
    ...buildProvenance,
    version: packageJson.version,
    signed: false,
    files: packageFiles,
  };
}

/** @param {string} bundleRoot @param {DesktopTarget} target @param {PackageFamily} packageFamily */
async function findPackages(bundleRoot, target, packageFamily) {
  const suffixes = packageSuffixes(target, packageFamily);
  assert(
    suffixes.length > 0,
    `Unsupported ${packageFamily} package target: ${target}.`,
  );
  const bundleDirectory =
    packageFamily === "desktop" && target.endsWith("-pc-windows-msvc")
      ? path.join(bundleRoot, "nsis")
      : bundleRoot;
  const paths = await collectFiles(bundleDirectory);
  return paths.filter((filePath) =>
    suffixes.some((suffix) => filePath.endsWith(suffix)),
  );
}

/**
 * @param {{ target: DesktopTarget, commit: string, requestId: string, bundleRoot: string, stageRoot: string, packageFamily: PackageFamily, nativeBuild: NativeBuildInput, sourceArchiveSha256: string, cacheKey: string, cacheRestored: boolean }} options
 * @returns {Promise<ArtifactManifest>}
 */
export async function stagePackages({
  target,
  commit,
  requestId,
  bundleRoot,
  stageRoot,
  packageFamily,
  nativeBuild,
  sourceArchiveSha256,
  cacheKey,
  cacheRestored,
}) {
  assert(desktopTargets.includes(target), `Unsupported desktop target: ${target}.`);
  const buildEvidence = assertNativeBuildMetadata(nativeBuild);
  const buildProvenance = await createBuildProvenance({
    commit,
    sourceArchiveSha256,
    cacheKey,
    cacheRestored,
  });
  assert(
    packageFamily === "desktop" || packageFamily === "store-msix",
    `Unsupported desktop package family: ${packageFamily}.`,
  );
  try {
    await lstat(stageRoot);
    throw new Error(`Artifact staging directory already exists: ${stageRoot}.`);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }

  const packages = await findPackages(bundleRoot, target, packageFamily);
  const filesDirectory = path.join(stageRoot, "files");
  await mkdir(filesDirectory, { recursive: true });
  const basenames = new Set();
  for (const packagePath of packages) {
    const basename = path.basename(packagePath);
    assert(!basenames.has(basename), `Package filename collision: ${basename}.`);
    basenames.add(basename);
    await cp(packagePath, path.join(filesDirectory, basename));
  }
  const manifest = await buildManifest(
    stageRoot,
    target,
    commit,
    requestId,
    packageFamily,
    buildEvidence,
    buildProvenance,
  );
  await writeFile(
    path.join(stageRoot, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: "wx" },
  );
  return manifest;
}

/**
 * @param {string} directory
 * @param {ArtifactExpectation} expected
 * @returns {Promise<ArtifactManifest>}
 */
async function verifyArtifactDirectory(directory, expected) {
  /** @type {ArtifactManifest} */
  const manifest = JSON.parse(
    await readFile(path.join(directory, "manifest.json"), "utf8"),
  );
  assert(manifest.schema_version === 3, "Unsupported artifact manifest schema.");
  assert(
    manifest.request_id === expected.requestId,
    "Artifact request ID does not match.",
  );
  assert(manifest.commit === expected.commit, "Artifact commit SHA does not match.");
  assert(manifest.version === expected.version, "Artifact version does not match.");
  assert(manifest.signed === false, "Unexpected signed artifact status.");
  assert(
    manifest.package_family === expected.packageFamily,
    "Artifact package family does not match its download slot.",
  );
  assert(
    manifest.target === expected.target,
    "Artifact target does not match its download slot.",
  );
  assert(
    typeof manifest.native_build === "object" && manifest.native_build !== null,
    "Native build evidence is missing.",
  );
  assert(
    manifest.native_build.target === expected.target &&
      manifest.native_build.build_mode === "diagnostic",
    "Native build evidence does not match the diagnostic target.",
  );
  assertNativeBuildMetadata({
    runnerOS: manifest.native_build.runner_os,
    runnerArch: manifest.native_build.runner_arch,
    rustHost: manifest.native_build.rust_host,
    target: manifest.native_build.target,
    buildMode: manifest.native_build.build_mode,
  });
  assertBuildProvenance(manifest, manifest.commit);
  assert(
    Array.isArray(manifest.files) && manifest.files.length > 0,
    "Artifact manifest has no files.",
  );

  const seen = new Set();
  for (const artifactFile of manifest.files) {
    assert(typeof artifactFile.path === "string", "Artifact path is missing.");
    const segments = artifactFile.path.split("/");
    assert(
      !path.posix.isAbsolute(artifactFile.path) &&
        !artifactFile.path.includes("\\") &&
        segments[0] === "files" &&
        !segments.includes("..") &&
        !segments.includes("."),
      "Artifact manifest contains an unsafe path.",
    );
    assert(!seen.has(artifactFile.path), "Artifact manifest contains duplicate paths.");
    seen.add(artifactFile.path);
    assert(
      /^[0-9a-f]{64}$/.test(artifactFile.sha256),
      "Artifact SHA-256 is malformed.",
    );
    const filePath = path.join(directory, ...segments);
    const metadata = await lstat(filePath);
    assert(
      metadata.isFile() && !metadata.isSymbolicLink(),
      "Downloaded artifact is not a regular file.",
    );
    assert(
      metadata.size === artifactFile.size_bytes,
      "Artifact size does not match its manifest.",
    );
    assert(
      (await sha256(filePath)) === artifactFile.sha256,
      "Artifact SHA-256 verification failed.",
    );
  }

  const suffixes = packageSuffixes(expected.target, expected.packageFamily);
  assert(
    suffixes.length > 0,
    `Unsupported ${expected.packageFamily} package target: ${expected.target}.`,
  );
  for (const suffix of suffixes) {
    const matches = manifest.files.filter((file) => file.path.endsWith(suffix));
    assert(
      matches.length === 1,
      matches.length === 0
        ? `Artifact is missing the required ${suffix} package.`
        : `Artifact contains multiple ${suffix} packages.`,
    );
  }
  const actualPaths = new Set(
    (await collectFiles(directory)).map((filePath) =>
      path.relative(directory, filePath).split(path.sep).join("/"),
    ),
  );
  actualPaths.delete("manifest.json");
  assert(
    actualPaths.size === seen.size &&
      [...actualPaths].every((filePath) => seen.has(filePath)),
    "Downloaded artifact contains files not declared in its manifest.",
  );
  return manifest;
}

/**
 * @param {string} root
 * @param {{ requestId: string, commit: string, version: string }} expected
 * @returns {Promise<ArtifactManifest[]>}
 */
export async function verifyArtifactSet(root, expected) {
  const manifests = [];
  for (const target of desktopTargets) {
    manifests.push(
      await verifyArtifactDirectory(path.join(root, target), {
        ...expected,
        target,
        packageFamily: "desktop",
      }),
    );
    if (storeMsixTargets.has(target)) {
      await verifyArtifactDirectory(path.join(root, `${target}-store-msix`), {
        ...expected,
        target,
        packageFamily: "store-msix",
      });
    }
  }
  return manifests;
}

const storeReleaseTargets = /** @type {const} */ ([
  {
    target: "x86_64-pc-windows-msvc",
    architecture: "x64",
  },
  {
    target: "aarch64-pc-windows-msvc",
    architecture: "arm64",
  },
]);

/**
 * @param {{ x64Root: string, arm64Root: string, outputRoot: string, tag: string, commit: string, requestId: string }} options
 */
export async function stageStoreReleaseAssets({
  x64Root,
  arm64Root,
  outputRoot,
  tag,
  commit,
  requestId,
}) {
  assert(
    /^v\d{4}\.([1-9]|1[0-2])\.(0|[1-9]\d*)$/.test(tag),
    "Store submission assets require an unpadded CalVer release tag.",
  );
  assert(/^[0-9a-f]{40}$/.test(commit), "Release commit is invalid.");
  const version = tag.slice(1);
  const roots = { x64: x64Root, arm64: arm64Root };
  try {
    await lstat(outputRoot);
    throw new Error(`Store release staging directory already exists: ${outputRoot}.`);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }

  await mkdir(outputRoot, { recursive: true });
  for (const target of storeReleaseTargets) {
    const artifactRoot = roots[target.architecture];
    const artifactManifest = await verifyArtifactDirectory(artifactRoot, {
      requestId,
      commit,
      version,
      target: target.target,
      packageFamily: "store-msix",
    });
    assert(
      artifactManifest.files.length === 1,
      `Expected one Store package for ${target.architecture}.`,
    );
    const artifactFile = artifactManifest.files[0];
    const packageName = path.posix.basename(artifactFile.path);
    assert(
      packageName.startsWith("Epikrise_") &&
        packageName.endsWith(`_${target.architecture}.msix`),
      `Store package name does not match ${target.architecture}: ${packageName}.`,
    );

    const sourcePath = path.join(artifactRoot, ...artifactFile.path.split("/"));
    const outputPath = path.join(outputRoot, packageName);
    await cp(sourcePath, outputPath, { errorOnExist: true, force: false });
    const releaseManifest = {
      schema_version: 1,
      tag,
      commit,
      architecture: target.architecture,
      target: target.target,
      package: {
        file: packageName,
        size_bytes: artifactFile.size_bytes,
        sha256: artifactFile.sha256,
      },
      artifact_manifest: {
        ...artifactManifest,
        files: [{ ...artifactFile, path: packageName }],
      },
    };
    await writeFile(
      path.join(outputRoot, `${packageName}.manifest.json`),
      `${JSON.stringify(releaseManifest, null, 2)}\n`,
      { flag: "wx" },
    );
  }

  await verifyStoreReleaseAssets(outputRoot, { tag, commit, requestId });
}

/**
 * @param {string} root
 * @param {{ tag: string, commit: string, requestId: string }} expected
 */
export async function verifyStoreReleaseAssets(root, expected) {
  assert(
    /^v\d{4}\.([1-9]|1[0-2])\.(0|[1-9]\d*)$/.test(expected.tag),
    "Store submission assets require an unpadded CalVer release tag.",
  );
  assert(/^[0-9a-f]{40}$/.test(expected.commit), "Release commit is invalid.");
  const version = expected.tag.slice(1);
  const storeVersion = deriveReleaseVersions(version).msixIdentityVersion;
  for (const target of storeReleaseTargets) {
    const expectedPackage = `Epikrise_${storeVersion}_${target.architecture}.msix`;
    assert(
      (await readdir(root)).includes(expectedPackage),
      `Store release is missing the ${target.architecture} MSIX package ${expectedPackage}.`,
    );
    const manifestPath = path.join(root, `${expectedPackage}.manifest.json`);
    const releaseManifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert(releaseManifest.schema_version === 1, "Unsupported Store release manifest.");
    assert(
      releaseManifest.tag === expected.tag &&
        releaseManifest.commit === expected.commit &&
        releaseManifest.architecture === target.architecture &&
        releaseManifest.target === target.target,
      "Store release manifest does not match its release target.",
    );
    assert(
      releaseManifest.package?.file === expectedPackage &&
        /^[0-9a-f]{64}$/.test(releaseManifest.package.sha256),
      "Store release package evidence is invalid.",
    );
    const packagePath = path.join(root, expectedPackage);
    const packageMetadata = await lstat(packagePath);
    assert(
      packageMetadata.isFile() &&
        !packageMetadata.isSymbolicLink() &&
        packageMetadata.size === releaseManifest.package.size_bytes,
      "Store release package size or file type does not match its manifest.",
    );
    assert(
      (await sha256(packagePath)) === releaseManifest.package.sha256,
      "Store release package SHA-256 verification failed.",
    );

    const artifactManifest = releaseManifest.artifact_manifest;
    assert(
      artifactManifest?.schema_version === 3 &&
        artifactManifest.request_id === expected.requestId &&
        artifactManifest.commit === expected.commit &&
        artifactManifest.version === version &&
        artifactManifest.target === target.target &&
        artifactManifest.package_family === "store-msix" &&
        artifactManifest.signed === false,
      "Store release artifact provenance does not match the release.",
    );
    assert(
      artifactManifest.files?.length === 1 &&
        artifactManifest.files[0].path === expectedPackage &&
        artifactManifest.files[0].size_bytes === releaseManifest.package.size_bytes &&
        artifactManifest.files[0].sha256 === releaseManifest.package.sha256,
      "Store release artifact integrity evidence is inconsistent.",
    );
    assertBuildProvenance(artifactManifest, expected.commit);
    assert(
      artifactManifest.native_build?.target === target.target &&
        artifactManifest.native_build?.build_mode === "diagnostic",
      "Store release native build evidence does not match the diagnostic target.",
    );
    assertNativeBuildMetadata({
      runnerOS: artifactManifest.native_build?.runner_os,
      runnerArch: artifactManifest.native_build?.runner_arch,
      rustHost: artifactManifest.native_build?.rust_host,
      target: artifactManifest.native_build?.target,
      buildMode: artifactManifest.native_build?.build_mode,
    });
  }
}

/** @param {string} command @param {string[]} args */
async function run(command, args) {
  const { stdout } = await execFile(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout.trim();
}

/** @param {number} milliseconds */
async function delay(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function dispatchAndDownload() {
  const status = await run("git", ["status", "--porcelain"]);
  const branch = await run("git", ["branch", "--show-current"]);
  const commit = await run("git", ["rev-parse", "HEAD"]);
  let ref = branch;
  let refIsTag = false;
  let pushedCommit = "";
  if (branch) {
    const pushedCommitOutput = await run("git", [
      "ls-remote",
      "--heads",
      "origin",
      `refs/heads/${branch}`,
    ]);
    pushedCommit = pushedCommitOutput.split(/\s+/)[0] ?? "";
  }
  if (pushedCommit !== commit) {
    const tags = (await run("git", ["tag", "--points-at", commit]))
      .split("\n")
      .filter(Boolean);
    for (const tag of tags) {
      const remoteTags = await run("git", [
        "ls-remote",
        "--tags",
        "origin",
        `refs/tags/${tag}`,
        `refs/tags/${tag}^{}`,
      ]);
      const matchingTag = remoteTags
        .split("\n")
        .map((line) => line.split(/\s+/))
        .find(
          ([sha, remoteRef]) => remoteRef === `refs/tags/${tag}^{}` || sha === commit,
        );
      if (
        matchingTag &&
        (matchingTag[0] === commit || matchingTag[1] === `refs/tags/${tag}^{}`)
      ) {
        ref = tag;
        refIsTag = true;
        pushedCommit = commit;
        break;
      }
    }
  }
  let workflowPresent = true;
  try {
    await run("git", ["cat-file", "-e", `${commit}:${workflowPath}`]);
  } catch {
    workflowPresent = false;
  }
  assertDispatchPreconditions({
    clean: status === "",
    branch: refIsTag ? "" : ref,
    tag: refIsTag ? ref : "",
    commit,
    workflowPresent,
    pushedCommit,
  });

  await run("gh", ["auth", "status"]);
  /** @type {Array<{ path: string, state: string }>} */
  const workflows = JSON.parse(
    await run("gh", ["workflow", "list", "--json", "name,path,state"]),
  );
  const workflow = workflows.find((entry) => entry.path === workflowPath);
  assert(
    workflow?.state === "active",
    "Desktop build workflow is not active on GitHub.",
  );

  const requestId = randomUUID();
  const title = `Desktop builds ${requestId} @ ${commit}`;
  await run("gh", [
    "workflow",
    "run",
    "desktop-builds.yml",
    "--ref",
    ref,
    "--field",
    `request_id=${requestId}`,
    "--field",
    `expected_sha=${commit}`,
  ]);
  console.log(`Dispatched ${title}`);

  let selectedRun;
  for (let attempt = 0; attempt < 60 && !selectedRun; attempt += 1) {
    const runListArgs = [
      "run",
      "list",
      "--workflow",
      "desktop-builds.yml",
      "--event",
      "workflow_dispatch",
    ];
    if (!refIsTag) runListArgs.push("--branch", ref);
    runListArgs.push(
      "--json",
      "databaseId,headSha,event,displayTitle,status,conclusion",
      "--limit",
      "100",
    );
    const runs = JSON.parse(await run("gh", runListArgs));
    selectedRun = selectMatchingRun(runs, requestId, commit);
    if (!selectedRun) await delay(2000);
  }
  if (!selectedRun) {
    throw new Error(`Timed out locating the Actions run for request ${requestId}.`);
  }

  console.log(`Waiting for Actions run ${selectedRun.databaseId}`);
  await run("gh", ["run", "watch", String(selectedRun.databaseId), "--exit-status"]);
  const completedRun = JSON.parse(
    await run("gh", [
      "run",
      "view",
      String(selectedRun.databaseId),
      "--json",
      "headSha,event,displayTitle,status,conclusion,jobs",
    ]),
  );
  assert(
    completedRun.headSha === commit,
    "Completed Actions run checked out a different commit.",
  );
  assert(
    completedRun.event === "workflow_dispatch",
    "Completed run was not manually dispatched.",
  );
  assert(
    completedRun.displayTitle === title,
    "Completed Actions run does not match this request.",
  );
  assert(
    completedRun.conclusion === "success",
    "At least one desktop build job failed.",
  );
  assertSuccessfulJobs(completedRun.jobs);

  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "epikrise-desktop-builds-"));
  const outputRoot = path.join(repoRoot, ".artifacts", "desktop-builds", requestId);
  try {
    for (const target of desktopTargets) {
      const destination = path.join(temporaryRoot, target);
      await mkdir(destination, { recursive: true });
      await run("gh", [
        "run",
        "download",
        String(selectedRun.databaseId),
        "--name",
        `epikrise-${target}`,
        "--dir",
        destination,
      ]);
      if (storeMsixTargets.has(target)) {
        const storeDestination = path.join(temporaryRoot, `${target}-store-msix`);
        const architecture = target.startsWith("aarch64-") ? "arm64" : "x64";
        await mkdir(storeDestination, { recursive: true });
        await run("gh", [
          "run",
          "download",
          String(selectedRun.databaseId),
          "--name",
          `epikrise-store-msix-${architecture}`,
          "--dir",
          storeDestination,
        ]);
      }
    }
    const packageJson = JSON.parse(
      await readFile(path.join(repoRoot, "package.json"), "utf8"),
    );
    await verifyArtifactSet(temporaryRoot, {
      requestId,
      commit,
      version: packageJson.version,
    });
    try {
      await lstat(outputRoot);
      throw new Error(`Output directory already exists: ${outputRoot}.`);
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
    await mkdir(path.dirname(outputRoot), { recursive: true });
    await cp(temporaryRoot, outputRoot, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  console.log(
    `Verified all six targets and both Windows package families: ${outputRoot}`,
  );
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
  if (command === "stage") {
    const options = parseOptions(args);
    assert(
      options["cache-restored"] === "true" || options["cache-restored"] === "false",
      "Cache restore status must be true or false.",
    );
    await stagePackages({
      target: /** @type {DesktopTarget} */ (options.target),
      commit: options.commit,
      requestId: options["request-id"],
      bundleRoot: options["bundle-root"],
      stageRoot: options["stage-root"],
      packageFamily: /** @type {PackageFamily} */ (options["package-family"]),
      nativeBuild: {
        runnerOS: options["runner-os"],
        runnerArch: options["runner-arch"],
        rustHost: options["rust-host"],
        target: options.target,
        buildMode: options["build-mode"],
      },
      sourceArchiveSha256: options["source-archive-sha256"],
      cacheKey: options["cache-key"],
      cacheRestored: options["cache-restored"] === "true",
    });
    return;
  }
  if (command === "stage-store-release") {
    const options = parseOptions(args);
    await stageStoreReleaseAssets({
      x64Root: options["x64-root"],
      arm64Root: options["arm64-root"],
      outputRoot: options["output-root"],
      tag: options.tag,
      commit: options.commit,
      requestId: options["request-id"],
    });
    return;
  }
  if (command === "verify-store-release") {
    const options = parseOptions(args);
    await verifyStoreReleaseAssets(options.root, {
      tag: options.tag,
      commit: options.commit,
      requestId: options["request-id"],
    });
    return;
  }
  assert(
    command === "dispatch",
    "Usage: node scripts/desktop-builds.mjs dispatch|stage|stage-store-release|verify-store-release [options]",
  );
  await dispatchAndDownload();
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
