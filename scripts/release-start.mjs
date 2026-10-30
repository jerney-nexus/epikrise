import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { validateCalverVersion } from "./prepare-release.mjs";

const execFile = promisify(execFileCallback);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gitOptions = { cwd: repoRoot, maxBuffer: 1024 * 1024 };

/** @param {string[]} args */
async function git(args) {
  const { stdout } = await execFile("git", args, gitOptions);
  return stdout.trimEnd();
}

/** @param {string} tag */
async function hasLocalTag(tag) {
  const output = await git(["tag", "--list", tag]);
  return output.split(/\r?\n/).includes(tag);
}

/** @param {string} status */
export function assertCleanReleaseWorktree(status) {
  if (status.trim()) {
    throw new Error(
      `The worktree is dirty. Commit or stash changes before release preparation.\n${status}`,
    );
  }
}

/** @param {string} branch @param {string} head @param {string} remoteHead */
export function assertReleaseMainIsSynchronized(branch, head, remoteHead) {
  if (branch !== "main") {
    throw new Error(`Release tagging requires main; current branch is ${branch}.`);
  }
  if (head !== remoteHead) {
    throw new Error("Local main is not synchronized with origin/main.");
  }
}

/**
 * @param {string} branch
 * @param {string} head
 * @param {string} remoteHead
 * @param {string} worktreeStatus
 * @param {string} checkedHead
 * @param {string} checkedVersion
 * @param {string} projectVersion
 */
export function assertReleaseTagContextIsUnchanged(
  branch,
  head,
  remoteHead,
  worktreeStatus,
  checkedHead,
  checkedVersion,
  projectVersion,
) {
  assertCleanReleaseWorktree(worktreeStatus);
  assertReleaseMainIsSynchronized(branch, head, remoteHead);
  if (head !== checkedHead) {
    throw new Error("HEAD changed during confirmation.");
  }
  if (projectVersion !== checkedVersion) {
    throw new Error("Project version changed during confirmation.");
  }
}

/** @param {string} projectVersion @param {string} requestedVersion */
export function resolveReleaseTagVersion(projectVersion, requestedVersion = "") {
  validateCalverVersion(projectVersion);
  if (!requestedVersion) return projectVersion;
  validateCalverVersion(requestedVersion);
  if (requestedVersion !== projectVersion) {
    throw new Error(
      `Requested tag version ${requestedVersion} does not match package.json version ${projectVersion}.`,
    );
  }
  return requestedVersion;
}

/** @param {string} tag @param {boolean} localExists @param {boolean} remoteExists */
export function assertReleaseTagAvailable(tag, localExists, remoteExists) {
  if (localExists) throw new Error(`Tag ${tag} already exists locally.`);
  if (remoteExists) throw new Error(`Tag ${tag} already exists on origin.`);
}

async function assertRepositoryRoot() {
  const actualRoot = path.resolve(await git(["rev-parse", "--show-toplevel"]));
  if (actualRoot !== repoRoot) {
    throw new Error(`Run this command from the Epikrise repository at ${repoRoot}.`);
  }
}

async function readProjectVersion() {
  const packageJson = JSON.parse(
    await readFile(path.join(repoRoot, "package.json"), "utf8"),
  );
  return validateCalverVersion(packageJson.version);
}

/** @param {string} tag */
async function readRemoteTagExists(tag) {
  const ref = `refs/tags/${tag}`;
  const output = await git(["ls-remote", "--tags", "--refs", "origin", ref]);
  return output.split(/\r?\n/).some((line) => line.split("\t")[1] === ref);
}

async function ensureWorktreeIsClean() {
  const status = await git(["status", "--porcelain", "--untracked-files=all"]);
  assertCleanReleaseWorktree(status);
}

async function ensureMainIsSynchronized() {
  const branch = await git(["branch", "--show-current"]);
  const head = await git(["rev-parse", "HEAD"]);
  const remoteHead = await git(["rev-parse", "refs/remotes/origin/main"]);
  assertReleaseMainIsSynchronized(branch, head, remoteHead);
}

/** @param {string} version */
async function reportTagState(version) {
  const tag = `v${version}`;
  const [localExists, remoteExists] = await Promise.all([
    hasLocalTag(tag),
    readRemoteTagExists(tag),
  ]);
  process.stdout.write(`Project version: ${version}\n`);
  process.stdout.write(`Local tag ${tag}: ${localExists ? "exists" : "not found"}\n`);
  process.stdout.write(`Remote tag ${tag}: ${remoteExists ? "exists" : "not found"}\n`);
}

async function prepareReleaseStart() {
  await assertRepositoryRoot();
  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const status = await git(["status", "--short", "--branch"]);
  process.stdout.write(`Starting branch: ${branch}\nWorktree status:\n${status}\n`);
  await ensureWorktreeIsClean();

  await git(["fetch", "origin", "--tags"]);
  const localMain = await git([
    "branch",
    "--list",
    "--format=%(refname:short)",
    "main",
  ]);
  if (localMain.split(/\r?\n/).includes("main")) {
    await git(["switch", "main"]);
  } else {
    await git(["switch", "--create", "main", "--track", "origin/main"]);
  }
  await git(["pull", "--ff-only", "origin", "main"]);
  await ensureMainIsSynchronized();

  const version = await readProjectVersion();
  await reportTagState(version);
  process.stdout.write(
    `Updated worktree status:\n${await git(["status", "--short", "--branch"])}\n`,
  );
}

/** @param {string} tag @param {string} version */
async function confirmTagPush(tag, version) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Tag creation requires an interactive terminal confirmation.");
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const response = await readline.question(
      `Create annotated tag ${tag} (Release ${version}) and push only refs/tags/${tag} to origin? Type PUSH to confirm: `,
    );
    return response.trim() === "PUSH";
  } finally {
    readline.close();
  }
}

/** @param {string} requestedVersion */
async function createAndPushReleaseTag(requestedVersion) {
  await assertRepositoryRoot();
  await ensureWorktreeIsClean();
  const branch = await git(["branch", "--show-current"]);
  if (branch !== "main") {
    throw new Error(`Release tagging requires main; current branch is ${branch}.`);
  }

  const projectVersion = await readProjectVersion();
  const version = resolveReleaseTagVersion(projectVersion, requestedVersion);
  const tag = `v${version}`;
  assertReleaseTagAvailable(tag, await hasLocalTag(tag), false);

  await git(["fetch", "origin", "--tags"]);
  await ensureMainIsSynchronized();
  const remoteExists = await readRemoteTagExists(tag);
  const localExists = await hasLocalTag(tag);
  assertReleaseTagAvailable(tag, localExists, remoteExists);
  const checkedHead = await git(["rev-parse", "HEAD"]);

  if (!(await confirmTagPush(tag, version))) {
    process.stdout.write("Tag creation cancelled.\n");
    return;
  }

  const branchAfterConfirmation = await git(["branch", "--show-current"]);
  const headAfterConfirmation = await git(["rev-parse", "HEAD"]);
  const remoteHeadAfterConfirmation = await git([
    "rev-parse",
    "refs/remotes/origin/main",
  ]);
  const worktreeStatusAfterConfirmation = await git([
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  const projectVersionAfterConfirmation = await readProjectVersion();
  assertReleaseTagContextIsUnchanged(
    branchAfterConfirmation,
    headAfterConfirmation,
    remoteHeadAfterConfirmation,
    worktreeStatusAfterConfirmation,
    checkedHead,
    projectVersion,
    projectVersionAfterConfirmation,
  );

  await git(["tag", "-a", tag, checkedHead, "-m", `Release ${version}`]);
  await git(["push", "--no-follow-tags", "origin", `refs/tags/${tag}`]);
  process.stdout.write(`Created and pushed ${tag}.\n`);
}

/** @param {unknown} error */
function getErrorMessage(error) {
  if (error && typeof error === "object" && "stderr" in error) {
    const stderr = String(error.stderr).trim();
    if (stderr) return stderr;
  }
  return error instanceof Error ? error.message : String(error);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const command = process.argv[2] ?? "";
  const requestedVersion = process.argv[3] ?? "";
  const operation =
    command === "preflight" && process.argv.length === 3
      ? prepareReleaseStart()
      : command === "tag" && process.argv.length <= 4
        ? createAndPushReleaseTag(requestedVersion)
        : Promise.reject(
            new Error(
              "Usage: node scripts/release-start.mjs preflight | tag [YYYY.M.MICRO]",
            ),
          );
  operation.catch((error) => {
    process.stderr.write(`${getErrorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
