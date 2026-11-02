import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * @typedef {{
 *   id: number,
 *   event: string,
 *   head_sha: string,
 *   head_branch: string,
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
    throw new Error(
      `GitHub Actions API request failed (${response.status}): ${detail || response.statusText}`,
    );
  }
  return response.json();
}

/** @param {string} baseUrl @param {string} owner @param {string} repo @param {string} path */
function apiUrl(baseUrl, owner, repo, path) {
  return `${baseUrl.replace(/\/+$/, "")}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${path}`;
}

/**
 * @param {{
 *   apiBaseUrl: string,
 *   owner: string,
 *   repo: string,
 *   headSha: string,
 *   headRef: string,
 *   token: string,
 *   fetchImpl?: typeof fetch,
 * }} options
 * @returns {Promise<WorkflowRun[]>}
 */
export async function findMatchingSmokeRuns({
  apiBaseUrl,
  owner,
  repo,
  headSha,
  headRef,
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

  return runs
    .filter(
      (run) =>
        run.event === "pull_request" &&
        run.head_sha === headSha &&
        run.head_branch === headRef,
    )
    .sort(
      (left, right) =>
        Date.parse(right.created_at) - Date.parse(left.created_at) ||
        right.run_number - left.run_number,
    );
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
 *   headSha: string,
 *   headRef: string,
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
  headSha,
  headRef,
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

  while (true) {
    const runs = await findMatchingSmokeRuns({
      apiBaseUrl,
      owner,
      repo,
      headSha,
      headRef,
      token,
      fetchImpl,
    });
    latestRun = runs[0];

    if (latestRun) {
      const jobs = await listRunJobs({
        apiBaseUrl,
        owner,
        repo,
        runId: latestRun.id,
        token,
        fetchImpl,
      });
      const result = evaluateSmokeRun(latestRun, jobs);
      if (result.state === "passed") {
        console.log(result.message);
        return;
      }
      if (result.state === "failed") {
        throw new Error(result.message);
      }
      lastPendingMessage = `${result.message}: ${latestRun.html_url}`;
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

/** @returns {Promise<void>} */
async function main() {
  const [owner, repo, ...extra] = requiredEnv("GITHUB_REPOSITORY").split("/");
  if (!owner || !repo || extra.length > 0) {
    throw new Error("GITHUB_REPOSITORY must be in owner/repository format.");
  }

  await waitForMacosSmoke({
    apiBaseUrl: process.env.GITHUB_API_URL || "https://api.github.com",
    owner,
    repo,
    headSha: requiredEnv("PR_HEAD_SHA"),
    headRef: requiredEnv("PR_HEAD_REF"),
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
