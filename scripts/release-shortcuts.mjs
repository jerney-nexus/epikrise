import { execFile as execFileCallback, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { validateCalverVersion } from "./prepare-release.mjs";
import { shouldPromoteLatest } from "./release-artifacts.mjs";

const execFile = promisify(execFileCallback);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repository = "jerney-nexus/epikrise";
const signedReleaseWorkflow = "signed-release.yml";
const windowsWorkspaceWorkflow = "windows-release-workspace.yml";
const manifestName = "latest.json";
const dispatchPollMs = 3000;
const dispatchTimeoutMs = 3 * 60 * 1000;

/**
 * @typedef {{ number: number, title: string, headRefName: string, url: string }} PullRequest
 * @typedef {{ databaseId: number, status: string, conclusion: string, event: string, headBranch: string, headSha: string, displayTitle: string, createdAt: string, url: string }} WorkflowRun
 * @typedef {{ tagName: string, isDraft: boolean, publishedAt: string | null }} Release
 */

/** @param {string[]} args */
async function gh(args) {
  try {
    const { stdout } = await execFile("gh", args, {
      cwd: repoRoot,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    throw ghError(args, error);
  }
}

/** @param {string[]} args */
async function ghJson(args) {
  return JSON.parse(await gh(args));
}

/** @param {string[]} args @param {unknown} error */
function ghError(args, error) {
  const commandError =
    /** @type {{ code?: string, stderr?: string, message?: string } | null} */ (error);
  if (commandError?.code === "ENOENT") {
    return new Error(
      "GitHub CLI (gh) is not installed or not on PATH. Install it from https://cli.github.com and run `gh auth login`.",
      { cause: error },
    );
  }
  const detail = String(commandError?.stderr || commandError?.message || "").trim();
  return new Error(
    `gh ${args.slice(0, 2).join(" ")} failed. Check that gh is authenticated (gh auth status) and has access to ${repository}.\n${detail}`,
    { cause: error },
  );
}

async function ensureAuthenticated() {
  await gh(["auth", "status"]);
}

async function readProjectVersion() {
  const packageJson = JSON.parse(
    await readFile(path.join(repoRoot, "package.json"), "utf8"),
  );
  return validateCalverVersion(packageJson.version);
}

/** @param {string} tag */
function releaseUrl(tag) {
  return `https://github.com/${repository}/releases/tag/${encodeURIComponent(tag)}`;
}

/**
 * @param {string} workflow
 * @param {string} branch
 * @returns {Promise<WorkflowRun[]>}
 */
async function listWorkflowRuns(workflow, branch) {
  return ghJson([
    "run",
    "list",
    "--repo",
    repository,
    "--workflow",
    workflow,
    "--branch",
    branch,
    "--limit",
    "100",
    "--json",
    "databaseId,status,conclusion,event,headBranch,headSha,displayTitle,createdAt,url",
  ]);
}

/**
 * Lists every release, including drafts, by following all API pages.
 *
 * @returns {Promise<Release[]>}
 */
async function listReleases() {
  const stdout = await gh([
    "api",
    "--paginate",
    "--jq",
    ".[] | {tagName: .tag_name, isDraft: .draft, publishedAt: .published_at}",
    `repos/${repository}/releases`,
  ]);
  return stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

/**
 * Returns the tag GitHub marks as latest, or undefined when no published release exists.
 *
 * @returns {Promise<string | undefined>}
 */
async function latestReleaseTag() {
  try {
    const tag = await gh([
      "api",
      `repos/${repository}/releases/latest`,
      "--jq",
      ".tag_name",
    ]);
    return tag.trim() || undefined;
  } catch (error) {
    if (/HTTP 404|Not Found/.test(String(/** @type {Error} */ (error).message))) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Finds the release preparation pull request.
 *
 * @returns {Promise<string>}
 */
export async function findReleasePullRequests() {
  await ensureAuthenticated();
  /** @type {PullRequest[]} */
  const pulls = await ghJson([
    "pr",
    "list",
    "--repo",
    repository,
    "--state",
    "open",
    "--search",
    "head:release/",
    "--json",
    "number,title,headRefName,url",
  ]);
  if (pulls.length === 0) {
    return "No open release pull request found (head:release/).\n";
  }
  return pulls
    .map((pull) => `#${pull.number} ${pull.title} (${pull.headRefName})\n  ${pull.url}`)
    .join("\n")
    .concat("\n");
}

/**
 * Reads the commit SHA that main points to in the configured repository.
 *
 * @returns {Promise<string>}
 */
async function remoteMainSha() {
  const ref = await ghJson(["api", `repos/${repository}/git/ref/heads/main`]);
  const sha = ref?.object?.sha;
  if (!/^[0-9a-f]{40}$/.test(sha ?? "")) {
    throw new Error(`Could not read the ${repository} main commit from GitHub.`);
  }
  return sha;
}

/**
 * Dispatches the Windows release workspace workflow on main and watches the new run.
 *
 * @returns {Promise<void>}
 */
export async function runWindowsReleaseWorkspace() {
  await ensureAuthenticated();
  const expectedSha = await remoteMainSha();
  const requestId = randomUUID();
  await gh([
    "workflow",
    "run",
    windowsWorkspaceWorkflow,
    "--repo",
    repository,
    "--ref",
    "main",
    "--field",
    `request_id=${requestId}`,
  ]);
  const run = await waitForNewRun(windowsWorkspaceWorkflow, { requestId });
  if (run.headSha !== expectedSha) {
    process.stdout.write(
      `main moved from ${expectedSha.slice(0, 7)} to ${run.headSha.slice(0, 7)} after the request was sent. Watching the run for ${run.headSha.slice(0, 7)}.\n`,
    );
  }
  process.stdout.write(`Watching ${run.url}\n`);
  await streamGh([
    "run",
    "watch",
    String(run.databaseId),
    "--repo",
    repository,
    "--exit-status",
  ]);
}

/**
 * Picks the run created by our dispatch from a listing. The run name carries the
 * request ID that was sent as the workflow input, which is unique per dispatch.
 * Returns undefined when none matches yet and throws when more than one matches.
 *
 * @param {WorkflowRun[]} runs
 * @param {{ workflow: string, requestId: string }} expected
 * @returns {WorkflowRun | undefined}
 */
export function selectDispatchedRun(runs, { workflow, requestId }) {
  const created = runs.filter(
    (run) => run.event === "workflow_dispatch" && run.displayTitle.includes(requestId),
  );
  if (created.length > 1) {
    throw new Error(
      `More than one ${workflow} run carries request ${requestId}. Pick the right one with gh run list --repo=${repository} --workflow=${workflow}.`,
    );
  }
  return created[0];
}

/**
 * @param {string} workflow
 * @param {{ requestId: string }} expected
 */
async function waitForNewRun(workflow, { requestId }) {
  const deadline = Date.now() + dispatchTimeoutMs;
  do {
    const run = selectDispatchedRun(await listWorkflowRuns(workflow, "main"), {
      workflow,
      requestId,
    });
    if (run) return run;
    await new Promise((resolve) => setTimeout(resolve, dispatchPollMs));
  } while (Date.now() < deadline);
  throw new Error(
    `Dispatched ${workflow} with request ${requestId}, but no matching run was listed within 3 minutes. The run may still start, so it is not known to have failed. Look for request ${requestId} with gh run list --repo=${repository} --workflow=${workflow} --branch=main, or open https://github.com/${repository}/actions/workflows/${workflow}.`,
  );
}

/**
 * Runs gh with inherited output so long-running watches stream to the terminal.
 *
 * @param {string[]} args
 */
function streamGh(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { cwd: repoRoot, stdio: "inherit" });
    child.on("error", (error) => reject(ghError(args, error)));
    child.on("exit", (code) => {
      if (code === 0) resolve(undefined);
      else
        reject(new Error(`gh ${args.slice(0, 2).join(" ")} exited with code ${code}.`));
    });
  });
}

/**
 * Shows the latest signed-release run and whether the draft release exists.
 *
 * @returns {Promise<string>}
 */
export async function reportDraftStatus() {
  await ensureAuthenticated();
  const version = await readProjectVersion();
  const tag = `v${version}`;
  const [runs, releases] = await Promise.all([
    ghJson([
      "run",
      "list",
      "--repo",
      repository,
      "--workflow",
      signedReleaseWorkflow,
      "--limit",
      "3",
      "--json",
      "databaseId,status,conclusion,headBranch,createdAt,url",
    ]),
    listReleases(),
  ]);

  const lines = [
    `Project version: ${version} (tag ${tag})`,
    "",
    "Signed updater release runs:",
  ];
  if (runs.length === 0) lines.push("  none found");
  for (const run of runs) {
    lines.push(
      `  ${run.createdAt} ${run.headBranch} ${run.status}${run.conclusion ? `/${run.conclusion}` : ""} ${run.url}`,
    );
  }

  const release = releases.find((item) => item.tagName === tag);
  lines.push("", `Release for ${tag}:`);
  if (!release) {
    lines.push("  not found yet (the signed release run creates the draft)");
  } else if (release.isDraft) {
    lines.push(
      `  draft, not published. Open https://github.com/${repository}/releases and select ${tag}. Draft releases are visible only to users with write access to the repository.`,
    );
  } else {
    lines.push(`  already published at ${release.publishedAt}: ${releaseUrl(tag)}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Checks that every platform entry in latest.json points at the release assets for tag.
 *
 * @param {{ platforms?: Record<string, { url?: string, signature?: string }> }} manifest
 * @param {string} tag
 * @param {Set<string>} assetNames names of the assets attached to the release
 */
export function assertManifestTargets(manifest, tag, assetNames) {
  const platforms = Object.entries(manifest?.platforms ?? {});
  if (platforms.length === 0) {
    throw new Error(`${manifestName} lists no platforms.`);
  }
  const prefix = new URL(
    `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/`,
  ).href;
  for (const [platform, entry] of platforms) {
    if (!isAssetUnderPrefix(entry?.url, prefix)) {
      throw new Error(`${manifestName} platform ${platform} does not target ${tag}.`);
    }
    if (typeof entry.signature !== "string" || entry.signature.trim() === "") {
      throw new Error(`${manifestName} platform ${platform} has no signature.`);
    }
    const assetName = decodeURIComponent(
      new URL(entry.url ?? "").pathname.split("/").at(-1) ?? "",
    );
    if (!assetNames.has(assetName)) {
      throw new Error(
        `${manifestName} platform ${platform} points at ${assetName}, which is not attached to ${tag}.`,
      );
    }
  }
  return platforms.map(([platform, entry]) => `  ${platform}: ${entry.url}`);
}

/**
 * Compares normalized URLs so dot segments cannot escape the release directory,
 * and requires a named asset below the prefix.
 *
 * @param {string | undefined} url
 * @param {string} prefix normalized prefix ending in "/"
 * @returns {boolean}
 */
function isAssetUnderPrefix(url, prefix) {
  if (!url) return false;
  try {
    const href = new URL(url).href;
    if (!href.startsWith(prefix)) return false;
    return /^[^/?#]+$/.test(href.slice(prefix.length));
  } catch {
    return false;
  }
}

/**
 * Describes the GitHub "latest" marker for tag. An older release may finish after
 * a newer one, in which case the release workflow keeps the marker on the newer tag.
 *
 * @param {string} tag
 * @param {string | undefined} latestTag
 * @returns {string} the line to report
 */
export function latestMarkerStatus(tag, latestTag) {
  if (latestTag === tag) {
    return `GitHub marks ${tag} as the latest release.`;
  }
  if (shouldPromoteLatest(tag, latestTag)) {
    throw new Error(
      `GitHub marks ${latestTag ?? "none"} as the latest release, but ${tag} should be latest. Check the release marker before continuing.`,
    );
  }
  return `GitHub marks ${latestTag} as the latest release, so ${tag} was not promoted. This is expected when a newer release already holds the marker.`;
}

/**
 * Confirms the published release, its latest.json target, and the GitHub "latest" marker.
 *
 * @returns {Promise<string>}
 */
export async function reportPublishedStatus() {
  await ensureAuthenticated();
  const version = await readProjectVersion();
  const tag = `v${version}`;
  const releases = await listReleases();
  const release = releases.find((item) => item.tagName === tag);
  if (!release) {
    throw new Error(
      `No release ${tag} exists yet. Complete the draft and publication steps first.`,
    );
  }
  if (release.isDraft) {
    throw new Error(`Release ${tag} is still a draft. It is not published yet.`);
  }

  const latestTag = await latestReleaseTag();
  const lines = [
    `Release ${tag} is published (${release.publishedAt}): ${releaseUrl(tag)}`,
    latestMarkerStatus(tag, latestTag),
  ];

  /** @type {{ assets: { name: string }[] }} */
  const { assets } = await ghJson([
    "release",
    "view",
    tag,
    "--repo",
    repository,
    "--json",
    "assets",
  ]);
  const assetNames = new Set(assets.map((asset) => asset.name));

  const directory = await mkdtemp(path.join(tmpdir(), "epikrise-release-"));
  try {
    await gh([
      "release",
      "download",
      tag,
      "--repo",
      repository,
      "--pattern",
      manifestName,
      "--dir",
      directory,
      "--clobber",
    ]);
    const manifest = JSON.parse(
      await readFile(path.join(directory, manifestName), "utf8"),
    );
    lines.push(
      `${manifestName} targets:`,
      ...assertManifestTargets(manifest, tag, assetNames),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  return `${lines.join("\n")}\n`;
}

/** @type {Record<string, () => Promise<string | void>>} */
const commands = {
  "pull-request": findReleasePullRequests,
  "windows-workspace": runWindowsReleaseWorkspace,
  "draft-status": reportDraftStatus,
  "published-status": reportPublishedStatus,
};

/**
 * Release scripts that keep their own implementation and are reached through
 * this entry point. Extra arguments are forwarded after `prefix`.
 */
/** @type {Record<string, { script: string, prefix: string[] }>} */
const delegatedCommands = {
  prepare: { script: "prepare-release.mjs", prefix: [] },
  "prepare-workflow": { script: "release-prepare-workflow.mjs", prefix: [] },
  preflight: { script: "release-start.mjs", prefix: ["preflight"] },
  tag: { script: "release-start.mjs", prefix: ["tag"] },
};

const usage = `Usage: node scripts/release-shortcuts.mjs ${[
  ...Object.keys(commands),
  ...Object.keys(delegatedCommands),
].join(" | ")}`;

/**
 * Maps a dispatcher subcommand to the script path and argument list it runs.
 *
 * @param {string} name
 * @param {string[]} forwarded arguments passed after the subcommand
 * @returns {{ script: string, args: string[] } | null}
 */
export function delegatedInvocation(name, forwarded) {
  if (!Object.hasOwn(delegatedCommands, name)) return null;
  const { script, prefix } = delegatedCommands[name];
  return {
    script: path.join(repoRoot, "scripts", script),
    args: [...prefix, ...forwarded],
  };
}

/**
 * Runs a delegated release script with inherited stdio and mirrors its exit code.
 *
 * @param {{ script: string, args: string[] }} invocation
 * @returns {Promise<void>}
 */
function runDelegated({ script, args }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: repoRoot,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      process.exitCode = code ?? 1;
      resolve(undefined);
    });
  });
}

async function main() {
  const name = process.argv[2] ?? "";
  const delegated = delegatedInvocation(name, process.argv.slice(3));
  if (delegated) {
    await runDelegated(delegated);
    return;
  }
  if (!Object.hasOwn(commands, name)) throw new Error(usage);
  if (process.argv.length > 3) {
    throw new Error(`${name} takes no arguments.\n${usage}`);
  }
  const output = await commands[name]();
  if (typeof output === "string") process.stdout.write(output);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
