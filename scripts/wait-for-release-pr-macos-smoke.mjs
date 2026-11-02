import { posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * @typedef {{
 *   id: number,
 *   event: string,
 *   head_sha: string,
 *   head_branch: string,
 *   display_title: string,
 *   status: string,
 *   conclusion: string | null,
 *   html_url: string,
 *   created_at: string,
 *   run_number: number,
 * }} WorkflowRun
 */
/**
 * @typedef {{
 *   name: string,
 *   status: string,
 *   conclusion: string | null,
 * }} WorkflowJob
 */

const requiredJobs = ["Build x86_64-apple-darwin", "Build aarch64-apple-darwin"];
const workflowFile = "macos-updater-bundle-smoke.yml";
const timeoutMs = 60 * 60 * 1000;
const pollIntervalMs = 60 * 1000;
const requestTimeoutMs = 30 * 1000;
const workflowPath = ".github/workflows/macos-updater-bundle-smoke.yml";
/**
 * Files the smoke job executes or reads; a PR must not change them. Release
 * preparation legitimately changes the version fields of package.json,
 * Cargo.toml, Cargo.lock, and tauri.conf.json, so those are compared with
 * version-only normalization.
 */
export const smokeTrustedPaths = [
  workflowPath,
  "scripts/with-cargo-host-target.sh",
  "scripts/detect-windows-os-architecture.sh",
  "scripts/detect-windows-os-architecture.ps1",
  "scripts/validate-native-cargo-target.mjs",
  "scripts/verify-native-build-environment.mjs",
  "scripts/verify-linux-host-architecture.mjs",
  "scripts/prepare-ocr.sh",
  "scripts/build-native-ocr.sh",
  "scripts/build-native-windows-ocr.sh",
  "scripts/build-windows-ocr.sh",
  "scripts/patch-windows-ocr-cmake.sh",
  "scripts/verify-binary-architecture.mjs",
  "scripts/verify-runtime-dependencies.mjs",
  "src-tauri/tauri.release.conf.json",
  "src-tauri/tauri.conf.json",
  "src-tauri/Cargo.lock",
  "package.json",
  "src-tauri/build.rs",
  "src-tauri/src/windows_updater_features.rs",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".npmrc",
  ".pnpmfile.cjs",
  "vite.config.js",
  "svelte.config.js",
  "rust-toolchain",
  "rust-toolchain.toml",
  "src-tauri/rust-toolchain",
  "src-tauri/rust-toolchain.toml",
  ".cargo/config",
  ".cargo/config.toml",
  "src-tauri/.cargo/config",
  "src-tauri/.cargo/config.toml",
  "src-tauri/Info.plist",
];

/**
 * Directories whose tracked files are bundled into the smoke build. Every file
 * under them is trusted, including files a PR adds. Only blob shas are compared
 * for them, so binary assets such as icons are safe to hash.
 */
export const smokeTrustedDirectories = [
  "src/",
  "static/",
  "locales/",
  "src-tauri/capabilities/",
  "src-tauri/resources/",
];

/**
 * @param {string} path
 * @returns {boolean}
 */
export function isSmokeTrustedInput(path) {
  return (
    smokeTrustedPaths.includes(path) ||
    smokeTrustedDirectories.some((directory) => path.startsWith(directory))
  );
}

/** Inputs that must exist at both refs; a 404 here means the ref or access is broken. */
export const requiredSmokePaths = [workflowPath, "src-tauri/build.rs"];

class GitHubApiError extends Error {
  /**
   * @param {number} status
   * @param {string} detail
   * @param {number | undefined} retryAfterMs
   * @param {boolean} retryable
   */
  constructor(status, detail, retryAfterMs, retryable) {
    super(`GitHub Actions API request failed (${status}): ${detail}`);
    this.name = "GitHubApiError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.retryable = retryable;
  }
}

/** @param {string} name */
function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} is missing.`);
  }
  return value;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is WorkflowRun} */
function isWorkflowRun(value) {
  return (
    isRecord(value) &&
    typeof value.id === "number" &&
    typeof value.event === "string" &&
    typeof value.head_sha === "string" &&
    typeof value.head_branch === "string" &&
    typeof value.display_title === "string" &&
    typeof value.status === "string" &&
    (typeof value.conclusion === "string" || value.conclusion === null) &&
    typeof value.html_url === "string" &&
    typeof value.created_at === "string" &&
    typeof value.run_number === "number"
  );
}

/** @param {unknown} value @returns {value is WorkflowJob} */
function isWorkflowJob(value) {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.status === "string" &&
    (typeof value.conclusion === "string" || value.conclusion === null)
  );
}

/**
 * @param {Response} response
 * @param {boolean} isRateLimited
 */
function retryAfterMs(response, isRateLimited) {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }

  if (!isRateLimited) return undefined;
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) {
    return Math.max(0, reset * 1000 - Date.now());
  }
  return undefined;
}

/**
 * @param {string} url
 * @param {string} token
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<unknown>}
 */
async function requestJson(url, token, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: ["Bearer", token].join(" "),
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!response.ok) {
    const detail = await response.text();
    const isRateLimited =
      response.status === 403 &&
      (response.headers.get("x-ratelimit-remaining") === "0" ||
        /rate limit/i.test(detail));
    const status = response.status;
    throw new GitHubApiError(
      status,
      detail || response.statusText,
      retryAfterMs(response, isRateLimited),
      status === 408 || status === 429 || status >= 500 || isRateLimited,
    );
  }
  return response.json();
}

/** @param {string} baseUrl @param {string} owner @param {string} repo @param {string} path */
function apiUrl(baseUrl, owner, repo, path) {
  return `${baseUrl.replace(/\/+$/, "")}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${path}`;
}

/**
 * Release preparation only rewrites the top-level `version` in these files, so
 * a release PR may change them as long as nothing else differs.
 */
const versionOnlyJsonPaths = new Set(["package.json", "src-tauri/tauri.conf.json"]);

/**
 * @param {Record<string, unknown>} payload contents API response
 * @param {string} path
 * @returns {string} canonical JSON with the top-level `version` removed
 */
function versionlessJson(payload, path) {
  if (payload.encoding !== "base64" || typeof payload.content !== "string") {
    throw new Error(`GitHub API did not return ${path} content.`);
  }
  const value = JSON.parse(Buffer.from(payload.content, "base64").toString("utf8"));
  if (!isRecord(value)) {
    throw new Error(`${path} is not a JSON object.`);
  }
  delete value.version;
  return JSON.stringify(value);
}

/** @param {Record<string, unknown> | null} payload @param {string} path */
function decodeContent(payload, path) {
  if (
    !payload ||
    payload.encoding !== "base64" ||
    typeof payload.content !== "string"
  ) {
    throw new Error(`GitHub API did not return ${path} content.`);
  }
  return Buffer.from(payload.content, "base64").toString("utf8");
}

/** @param {string} contents */
function versionlessCargoManifest(contents) {
  let section = "";
  return contents
    .split("\n")
    .map((line) => {
      const heading = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
      if (heading) section = heading[1];
      return (section === "package" || section === "workspace.package") &&
        /^\s*version\s*=/.test(line)
        ? line.replace(/(\bversion\s*=\s*).*/, "$1<release-version>")
        : line;
    })
    .join("\n");
}

/**
 * Normalizes only local (source-less) lock packages, the entries release
 * preparation rewrites, so registry or git package changes still differ.
 * @param {string} contents
 */
function versionlessCargoLock(contents) {
  return contents
    .split(/^(?=\[\[package\]\])/m)
    .map((block) =>
      block.startsWith("[[package]]") && !/^\s*source\s*=/m.test(block)
        ? block.replace(/^(\s*version\s*=\s*).*$/m, "$1<release-version>")
        : block,
    )
    .join("");
}

/** @param {string} key */
function tomlKeySegments(key) {
  return key.split(".").map((part) => part.trim().replace(/^["']|["']$/g, ""));
}

/**
 * Finds the package build script in a Cargo manifest. Fails closed on any
 * `build` assignment it cannot parse so the smoke inputs are never under-read.
 * @param {string} contents @param {string} manifestPath
 */
export function cargoBuildScriptPath(contents, manifestPath) {
  /** @type {string[]} */
  let section = [];
  /** @type {string | null | undefined} */
  let buildValue;
  for (const line of contents.split("\n")) {
    const arrayTable = line.match(/^\s*\[\[([^\]]+)\]\]\s*(?:#.*)?$/);
    if (arrayTable) {
      section = [`[[${arrayTable[1]}]]`];
      continue;
    }
    const heading = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (heading) {
      section = tomlKeySegments(heading[1]);
      continue;
    }
    const assignment = line.match(/^\s*([^=#]+?)\s*=\s*(.*?)\s*(?:#.*)?$/);
    if (!assignment) continue;
    const keyPath = [...section, ...tomlKeySegments(assignment[1])];
    const value = assignment[2];
    if (keyPath[0] === "package" && keyPath.length === 2 && keyPath[1] === "build") {
      buildValue = parseCargoBuildValue(value, manifestPath);
    } else if (keyPath.length === 1 && keyPath[0] === "package") {
      if (value.startsWith("{") && !value.endsWith("}")) {
        throw new Error(
          `${manifestPath} uses an unsupported multi-line package table.`,
        );
      }
      const inline = value.match(/\bbuild\s*=\s*(.*?)\s*(?:,|\}|$)/);
      if (inline) buildValue = parseCargoBuildValue(inline[1], manifestPath);
    }
  }
  return buildValue ?? null;
}

/** @param {string} value @param {string} manifestPath */
function parseCargoBuildValue(value, manifestPath) {
  if (value === "false") return null;
  const quoted = value.match(/^(["'])([^"']+)\1$/);
  if (!quoted) {
    throw new Error(`${manifestPath} has an unsupported package build value.`);
  }
  return posix.normalize(posix.join(posix.dirname(manifestPath), quoted[2]));
}

/**
 * @param {{
 *   apiBaseUrl: string,
 *   owner: string,
 *   repo: string,
 *   baseSha: string,
 *   headSha: string,
 *   token: string,
 *   fetchImpl?: typeof fetch,
 * }} options
 */
export async function assertSmokeWorkflowUnmodified({
  apiBaseUrl,
  owner,
  repo,
  baseSha,
  headSha,
  token,
  fetchImpl = fetch,
}) {
  /**
   * Returns null when the path does not exist at `ref`, so an optional config
   * file added by a pull request is detected as a change.
   * @param {string} path
   * @param {string} ref
   */
  async function getContents(path, ref) {
    const params = new URLSearchParams({ ref });
    let payload;
    try {
      payload = await requestJson(
        apiUrl(
          apiBaseUrl,
          owner,
          repo,
          `/contents/${path.split("/").map(encodeURIComponent).join("/")}?${params}`,
        ),
        token,
        fetchImpl,
      );
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return null;
      throw error;
    }
    if (!isRecord(payload) || typeof payload.sha !== "string") {
      throw new Error(`GitHub API did not return ${path} at ${ref}.`);
    }
    return payload;
  }

  // Confirms both commits exist first, so an unresolvable ref cannot pass as "no inputs changed".
  /**
   * @param {string} label
   * @param {string} sha
   */
  async function assertCommitResolves(label, sha) {
    try {
      await requestJson(
        apiUrl(apiBaseUrl, owner, repo, `/git/commits/${encodeURIComponent(sha)}`),
        token,
        fetchImpl,
      );
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) {
        throw new Error(
          `${label} commit ${sha} cannot be resolved; the gate cannot verify the macOS updater bundle smoke inputs.`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  await assertCommitResolves("PR base", baseSha);
  await assertCommitResolves("PR head", headSha);

  /**
   * Cargo manifests and Rust sources under src-tauri/, the only Rust workspace,
   * plus every tracked file in the smoke-trusted directories.
   * @param {string} sha
   */
  async function getTreeInputPaths(sha) {
    const tree = await requestJson(
      apiUrl(
        apiBaseUrl,
        owner,
        repo,
        `/git/trees/${encodeURIComponent(sha)}?recursive=1`,
      ),
      token,
      fetchImpl,
    );
    if (!isRecord(tree) || tree.truncated === true || !Array.isArray(tree.tree)) {
      throw new Error(`GitHub API could not enumerate smoke inputs at ${sha}.`);
    }
    const paths = new Set();
    for (const entry of tree.tree) {
      if (!isRecord(entry) || entry.type !== "blob") continue;
      if (typeof entry.path !== "string") continue;
      const path = entry.path;
      const isRustInput =
        path.startsWith("src-tauri/") &&
        (path.endsWith("/Cargo.toml") || path.endsWith(".rs"));
      const isTrustedDirectoryInput = smokeTrustedDirectories.some((directory) =>
        path.startsWith(directory),
      );
      if (isRustInput || isTrustedDirectoryInput) paths.add(path);
    }
    for (const path of paths) {
      if (!path.endsWith("Cargo.toml")) continue;
      const manifest = await getContents(path, sha);
      if (manifest === null) {
        throw new Error(`${path} disappeared while checking smoke inputs at ${sha}.`);
      }
      const buildScript = cargoBuildScriptPath(decodeContent(manifest, path), path);
      if (buildScript) paths.add(buildScript);
    }
    return paths;
  }

  const [baseTreeInputs, headTreeInputs] = await Promise.all([
    getTreeInputPaths(baseSha),
    getTreeInputPaths(headSha),
  ]);
  const treeInputPaths = new Set([...baseTreeInputs, ...headTreeInputs]);

  // Sequential so each path's base and head requests stay in a deterministic order.
  for (const path of new Set([...smokeTrustedPaths, ...treeInputPaths])) {
    const base = await getContents(path, baseSha);
    const head = await getContents(path, headSha);
    if (requiredSmokePaths.includes(path) && (base === null || head === null)) {
      throw new Error(
        `${path} is missing at the PR base or head; the gate cannot verify the macOS updater bundle smoke inputs.`,
      );
    }
    if (base === null && head === null) {
      if (treeInputPaths.has(path)) {
        throw new Error(
          `${path} was listed in the source tree but could not be read at either PR commit; the gate will not trust its results.`,
        );
      }
      continue;
    }
    if (base !== null && head !== null && base.sha === head.sha) continue;
    if (
      base !== null &&
      head !== null &&
      path.startsWith("src-tauri/") &&
      path.endsWith("Cargo.toml") &&
      versionlessCargoManifest(decodeContent(base, path)) ===
        versionlessCargoManifest(decodeContent(head, path))
    ) {
      continue;
    }
    if (
      base !== null &&
      head !== null &&
      path === "src-tauri/Cargo.lock" &&
      versionlessCargoLock(decodeContent(base, path)) ===
        versionlessCargoLock(decodeContent(head, path))
    ) {
      continue;
    }
    if (
      base === null ||
      head === null ||
      !versionOnlyJsonPaths.has(path) ||
      versionlessJson(base, path) !== versionlessJson(head, path)
    ) {
      throw new Error(
        `${path} differs from the PR base; the macOS updater bundle smoke inputs are untrusted and the gate will not trust its results.`,
      );
    }
  }
}

/**
 * @param {{
 *   apiBaseUrl: string,
 *   owner: string,
 *   repo: string,
 *   headSha: string,
 *   token: string,
 *   fetchImpl?: typeof fetch,
 * }} options
 * @returns {Promise<WorkflowRun[]>}
 */
async function fetchSmokeRunsForHead({
  apiBaseUrl,
  owner,
  repo,
  headSha,
  token,
  fetchImpl = fetch,
}) {
  const params = new URLSearchParams({
    head_sha: headSha,
    event: "pull_request",
    per_page: "100",
  });
  const url = apiUrl(
    apiBaseUrl,
    owner,
    repo,
    `/actions/workflows/${workflowFile}/runs?${params}`,
  );
  const payload = await requestJson(url, token, fetchImpl);
  if (!isRecord(payload) || !Array.isArray(payload.workflow_runs)) {
    throw new Error("GitHub Actions API response did not contain workflow_runs.");
  }
  const rawRuns = payload.workflow_runs;
  const runs = rawRuns.filter(isWorkflowRun);
  if (runs.length !== rawRuns.length) {
    throw new Error("GitHub Actions API returned a malformed workflow run.");
  }
  return runs;
}

/**
 * @param {WorkflowRun[]} runs
 * @param {{
 *   pullRequestNumber: number,
 *   headSha: string,
 *   headRef: string,
 *   baseSha: string,
 * }} expected
 * @returns {WorkflowRun[]}
 */
function selectMatchingSmokeRuns(
  runs,
  { pullRequestNumber, headSha, headRef, baseSha },
) {
  return runs
    .filter(
      (run) =>
        run.event === "pull_request" &&
        run.conclusion !== "skipped" &&
        run.head_sha === headSha &&
        run.head_branch === headRef &&
        run.display_title === smokeRunTitle(pullRequestNumber, headSha, baseSha),
    )
    .sort(
      (left, right) =>
        Date.parse(right.created_at) - Date.parse(left.created_at) ||
        right.run_number - left.run_number,
    );
}

/**
 * Finds a smoke run for the same PR head whose base SHA differs from the
 * expected one, which happens when the base moved after the release commit.
 * @param {WorkflowRun[]} runs
 * @param {{
 *   pullRequestNumber: number,
 *   headSha: string,
 *   headRef: string,
 *   baseSha: string,
 * }} expected
 * @returns {WorkflowRun | undefined}
 */
function findBaseMismatchRun(runs, { pullRequestNumber, headSha, headRef, baseSha }) {
  const prefix = `${smokeRunTitle(pullRequestNumber, headSha, "")}`;
  return runs.find(
    (run) =>
      run.event === "pull_request" &&
      run.conclusion !== "skipped" &&
      run.head_sha === headSha &&
      run.head_branch === headRef &&
      run.display_title.startsWith(prefix) &&
      run.display_title !== smokeRunTitle(pullRequestNumber, headSha, baseSha),
  );
}

/**
 * @param {{
 *   apiBaseUrl: string,
 *   owner: string,
 *   repo: string,
 *   pullRequestNumber: number,
 *   headSha: string,
 *   headRef: string,
 *   baseSha: string,
 *   token: string,
 *   fetchImpl?: typeof fetch,
 * }} options
 * @returns {Promise<WorkflowRun[]>}
 */
export async function findMatchingSmokeRuns({
  apiBaseUrl,
  owner,
  repo,
  pullRequestNumber,
  headSha,
  headRef,
  baseSha,
  token,
  fetchImpl = fetch,
}) {
  const runs = await fetchSmokeRunsForHead({
    apiBaseUrl,
    owner,
    repo,
    headSha,
    token,
    fetchImpl,
  });
  return selectMatchingSmokeRuns(runs, {
    pullRequestNumber,
    headSha,
    headRef,
    baseSha,
  });
}

/**
 * Must match the `run-name` format in macos-updater-bundle-smoke.yml.
 * @param {number} pullRequestNumber
 * @param {string} headSha
 * @param {string} baseSha
 */
export function smokeRunTitle(pullRequestNumber, headSha, baseSha) {
  return `macOS updater bundle smoke | PR #${pullRequestNumber} | head ${headSha} | base ${baseSha}`;
}

/** @param {WorkflowRun} run @param {WorkflowJob[]} jobs */
export function evaluateSmokeRun(run, jobs) {
  const runUrl = run.html_url || "the macOS updater bundle smoke run";
  if (run.status === "completed" && run.conclusion !== "success") {
    return {
      state: "failed",
      message: `Smoke workflow concluded ${run.conclusion || "without success"}: ${runUrl}`,
    };
  }

  const pending = [];
  for (const name of requiredJobs) {
    const job = jobs.find((candidate) => candidate.name === name);
    if (!job) {
      if (run.status === "completed") {
        return {
          state: "failed",
          message: `Completed smoke run is missing required job "${name}": ${runUrl}`,
        };
      }
      pending.push(`waiting for job "${name}" to appear`);
      continue;
    }

    if (job.status === "completed" && job.conclusion !== "success") {
      return {
        state: "failed",
        message: `Required smoke job "${name}" concluded ${job.conclusion || "without success"}: ${runUrl}`,
      };
    }
    if (run.status === "completed" && job.status !== "completed") {
      return {
        state: "failed",
        message: `Smoke run completed before required job "${name}" finished: ${runUrl}`,
      };
    }
    if (job.status !== "completed") {
      pending.push(`job "${name}" is ${job.status}`);
    } else if (job.conclusion !== "success") {
      pending.push(`job "${name}" has no successful conclusion`);
    }
  }

  if (run.status === "completed" && pending.length === 0) {
    return { state: "passed", message: "Both required macOS smoke jobs passed." };
  }

  return {
    state: "pending",
    message: pending.join("; ") || `workflow run is ${run.status}`,
  };
}

/**
 * @param {{
 *   apiBaseUrl: string,
 *   owner: string,
 *   repo: string,
 *   runId: number,
 *   token: string,
 *   fetchImpl: typeof fetch,
 * }} options
 * @returns {Promise<WorkflowJob[]>}
 */
async function listRunJobs({ apiBaseUrl, owner, repo, runId, token, fetchImpl }) {
  const url = apiUrl(
    apiBaseUrl,
    owner,
    repo,
    `/actions/runs/${runId}/jobs?per_page=100`,
  );
  const payload = await requestJson(url, token, fetchImpl);
  if (!isRecord(payload) || !Array.isArray(payload.jobs)) {
    throw new Error("GitHub Actions API response did not contain jobs.");
  }
  const jobs = payload.jobs.filter(isWorkflowJob);
  if (jobs.length !== payload.jobs.length) {
    throw new Error("GitHub Actions API returned a malformed workflow job.");
  }
  return jobs;
}

/**
 * @param {{
 *   apiBaseUrl: string,
 *   owner: string,
 *   repo: string,
 *   pullRequestNumber: number,
 *   headSha: string,
 *   headRef: string,
 *   baseSha: string,
 *   token: string,
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 *   sleep?: (duration: number) => Promise<unknown>,
 *   maxWaitMs?: number,
 *   intervalMs?: number,
 * }} options
 */
export async function waitForMacosSmoke({
  apiBaseUrl,
  owner,
  repo,
  pullRequestNumber,
  headSha,
  headRef,
  baseSha,
  token,
  fetchImpl = fetch,
  now = Date.now,
  sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
  maxWaitMs = timeoutMs,
  intervalMs = pollIntervalMs,
}) {
  const deadline = now() + maxWaitMs;
  let latestRun;
  let lastPendingMessage = "no matching smoke workflow run has appeared";
  let consecutiveApiFailures = 0;
  let smokeWorkflowVerified = false;

  while (true) {
    try {
      if (!smokeWorkflowVerified) {
        await assertSmokeWorkflowUnmodified({
          apiBaseUrl,
          owner,
          repo,
          baseSha,
          headSha,
          token,
          fetchImpl,
        });
        smokeWorkflowVerified = true;
      }

      const smokeRuns = await fetchSmokeRunsForHead({
        apiBaseUrl,
        owner,
        repo,
        headSha,
        token,
        fetchImpl,
      });
      const runs = selectMatchingSmokeRuns(smokeRuns, {
        pullRequestNumber,
        headSha,
        headRef,
        baseSha,
      });
      latestRun = undefined;
      /** @type {WorkflowJob[]} */
      let latestJobs = [];
      for (const candidate of runs) {
        const candidateJobs = await listRunJobs({
          apiBaseUrl,
          owner,
          repo,
          runId: candidate.id,
          token,
          fetchImpl,
        });
        if (
          candidateJobs.some(
            (job) => requiredJobs.includes(job.name) && job.conclusion !== "skipped",
          )
        ) {
          latestRun = candidate;
          latestJobs = candidateJobs;
          break;
        }
      }

      if (!latestRun) {
        const mismatchRun = findBaseMismatchRun(smokeRuns, {
          pullRequestNumber,
          headSha,
          headRef,
          baseSha,
        });
        if (mismatchRun) {
          lastPendingMessage = `a smoke run exists for head ${headSha} but was created for a different base (${mismatchRun.display_title}); the PR base likely moved after the release commit, so re-run the gate on the current base: ${mismatchRun.html_url}`;
        }
      }

      if (latestRun) {
        const result = evaluateSmokeRun(latestRun, latestJobs);
        if (result.state === "passed") {
          console.log(result.message);
          return;
        }
        if (result.state === "failed") {
          throw new Error(result.message);
        }
        lastPendingMessage = `${result.message}: ${latestRun.html_url}`;
      }

      consecutiveApiFailures = 0;
    } catch (error) {
      if (!isRetryableApiError(error)) throw error;

      const remainingMs = deadline - now();
      if (remainingMs <= 0) {
        throw new Error(
          `Timed out waiting for macOS updater bundle smoke results on ${headRef} at ${headSha} after a transient GitHub API failure: ${error.message}`,
          { cause: error },
        );
      }
      const fallbackDelay = Math.min(
        pollIntervalMs,
        1000 * 2 ** Math.min(consecutiveApiFailures, 6),
      );
      const requestedDelay =
        error instanceof GitHubApiError && error.retryAfterMs !== undefined
          ? error.retryAfterMs
          : fallbackDelay;
      const delayMs = Math.min(Math.max(requestedDelay, 1000), remainingMs);
      consecutiveApiFailures += 1;
      console.warn(
        `Transient GitHub API failure; retrying in ${delayMs} ms: ${error.message}`,
      );
      await sleep(delayMs);
      continue;
    }

    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      throw new Error(
        `Timed out after ${Math.ceil(maxWaitMs / 60_000)} minutes waiting for both macOS updater bundle smoke jobs on ${headRef} at ${headSha}: ${lastPendingMessage}`,
      );
    }
    await sleep(Math.min(intervalMs, remainingMs));
  }
}

/** @param {unknown} error @returns {error is Error} */
function isRetryableApiError(error) {
  if (error instanceof GitHubApiError) return error.retryable;
  if (error instanceof TypeError) {
    // fetch reports network failures as TypeError with a cause; other TypeErrors are bugs.
    return error.cause !== undefined;
  }
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

/** @returns {Promise<void>} */
async function main() {
  const [owner, repo, ...extra] = requiredEnv("GITHUB_REPOSITORY").split("/");
  if (!owner || !repo || extra.length > 0) {
    throw new Error("GITHUB_REPOSITORY must be in owner/repository format.");
  }
  const pullRequestNumber = Number(requiredEnv("PR_NUMBER"));
  if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1) {
    throw new Error("PR_NUMBER must be a positive integer.");
  }

  await waitForMacosSmoke({
    apiBaseUrl: process.env.GITHUB_API_URL || "https://api.github.com",
    owner,
    repo,
    pullRequestNumber,
    headSha: requiredEnv("PR_HEAD_SHA"),
    headRef: requiredEnv("PR_HEAD_REF"),
    baseSha: requiredEnv("PR_BASE_SHA"),
    token: requiredEnv("GITHUB_TOKEN"),
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
