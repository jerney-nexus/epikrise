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
/** @typedef {{ schema_version: number, request_id: string, commit: string, target: DesktopTarget, version: string, signed: false, files: Array<{ path: string, size_bytes: number, sha256: string }> }} ArtifactManifest */
/** @typedef {{ requestId: string, commit: string, version: string, target: DesktopTarget }} ArtifactExpectation */

const expectedSuffixes = {
  "x86_64-unknown-linux-gnu": [".deb", ".rpm", ".AppImage"],
  "aarch64-unknown-linux-gnu": [".deb", ".rpm", ".AppImage"],
  "x86_64-apple-darwin": [".dmg"],
  "aarch64-apple-darwin": [".dmg"],
  "x86_64-pc-windows-msvc": [".exe"],
  "aarch64-pc-windows-msvc": [".exe"],
};

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
 * @returns {Promise<ArtifactManifest>}
 */
async function buildManifest(stageRoot, target, commit, requestId) {
  assert(desktopTargets.includes(target), `Unsupported desktop target: ${target}.`);
  assert(/^[0-9a-f]{40}$/.test(commit), "Commit must be a full Git SHA.");
  assert(/^[0-9a-f-]{36}$/.test(requestId), "Request ID must be a UUID.");

  const filesDirectory = path.join(stageRoot, "files");
  const stagedPaths = await collectFiles(filesDirectory);
  const suffixes = expectedSuffixes[target];
  for (const suffix of suffixes) {
    assert(
      stagedPaths.some((filePath) => filePath.endsWith(suffix)),
      `No ${suffix} package was staged for ${target}.`,
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
    schema_version: 1,
    request_id: requestId,
    commit,
    target,
    version: packageJson.version,
    signed: false,
    files: packageFiles,
  };
}

/** @param {string} bundleRoot @param {DesktopTarget} target */
async function findPackages(bundleRoot, target) {
  const bundleDirectory = target.endsWith("-pc-windows-msvc")
    ? path.join(bundleRoot, "nsis")
    : bundleRoot;
  const paths = await collectFiles(bundleDirectory);
  return paths.filter((filePath) =>
    expectedSuffixes[target].some((suffix) => filePath.endsWith(suffix)),
  );
}

/**
 * @param {{ target: DesktopTarget, commit: string, requestId: string, bundleRoot: string, stageRoot: string }} options
 * @returns {Promise<ArtifactManifest>}
 */
export async function stagePackages({
  target,
  commit,
  requestId,
  bundleRoot,
  stageRoot,
}) {
  assert(desktopTargets.includes(target), `Unsupported desktop target: ${target}.`);
  try {
    await lstat(stageRoot);
    throw new Error(`Artifact staging directory already exists: ${stageRoot}.`);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }

  const packages = await findPackages(bundleRoot, target);
  const filesDirectory = path.join(stageRoot, "files");
  await mkdir(filesDirectory, { recursive: true });
  const basenames = new Set();
  for (const packagePath of packages) {
    const basename = path.basename(packagePath);
    assert(!basenames.has(basename), `Package filename collision: ${basename}.`);
    basenames.add(basename);
    await cp(packagePath, path.join(filesDirectory, basename));
  }
  const manifest = await buildManifest(stageRoot, target, commit, requestId);
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
  assert(manifest.schema_version === 1, "Unsupported artifact manifest schema.");
  assert(
    manifest.request_id === expected.requestId,
    "Artifact request ID does not match.",
  );
  assert(manifest.commit === expected.commit, "Artifact commit SHA does not match.");
  assert(manifest.version === expected.version, "Artifact version does not match.");
  assert(manifest.signed === false, "Unexpected signed artifact status.");
  assert(
    expectedSuffixes[expected.target],
    `Unsupported artifact target: ${expected.target}.`,
  );
  assert(
    manifest.target === expected.target,
    "Artifact target does not match its download slot.",
  );
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

  for (const suffix of expectedSuffixes[expected.target]) {
    assert(
      manifest.files.some((file) => file.path.endsWith(suffix)),
      `Artifact is missing the required ${suffix} package.`,
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
      }),
    );
  }
  return manifests;
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
  const workflow = JSON.parse(
    await run("gh", ["workflow", "view", "desktop-builds.yml", "--json", "path,state"]),
  );
  assert(
    workflow.path === workflowPath && workflow.state === "active",
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
  console.log(`Verified all six architecture-specific bundles: ${outputRoot}`);
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
    await stagePackages({
      target: /** @type {DesktopTarget} */ (options.target),
      commit: options.commit,
      requestId: options["request-id"],
      bundleRoot: options["bundle-root"],
      stageRoot: options["stage-root"],
    });
    return;
  }
  assert(
    command === "dispatch",
    "Usage: node scripts/desktop-builds.mjs dispatch|stage [options]",
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
