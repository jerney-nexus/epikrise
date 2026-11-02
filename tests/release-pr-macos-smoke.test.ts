import { describe, expect, it, vi } from "vitest";
import {
  assertSmokeWorkflowUnmodified,
  evaluateSmokeRun,
  findMatchingSmokeRuns,
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

describe("release PR macOS updater smoke gate", () => {
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
    ).rejects.toThrow("smoke workflow differs from the PR base");
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
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ sha: "workflow-sha" }))
      .mockResolvedValueOnce(response({ sha: "workflow-sha" }))
      .mockResolvedValueOnce(response({ workflow_runs: [] }));

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
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ sha: "workflow-sha" }))
      .mockResolvedValueOnce(response({ sha: "workflow-sha" }))
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
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(elapsedMs).toBe(1_000);
  });

  it("fails promptly for permanent API permission errors", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ sha: "workflow-sha" }))
      .mockResolvedValueOnce(response({ sha: "workflow-sha" }))
      .mockResolvedValueOnce(
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
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("retries network failures reported by fetch", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ sha: "workflow-sha" }))
      .mockResolvedValueOnce(response({ sha: "workflow-sha" }))
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
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it("fails immediately on programming errors thrown as TypeError", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ sha: "workflow-sha" }))
      .mockResolvedValueOnce(response({ sha: "workflow-sha" }))
      .mockRejectedValueOnce(new TypeError("Cannot read properties of undefined"));

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
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("honors Retry-After when GitHub asks the gate to back off", async () => {
    const sleeps: number[] = [];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ sha: "workflow-sha" }))
      .mockResolvedValueOnce(response({ sha: "workflow-sha" }))
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
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ sha: "workflow-sha" }))
      .mockResolvedValueOnce(response({ sha: "workflow-sha" }))
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
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it("retries request timeouts reported as AbortError or TimeoutError", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ sha: "workflow-sha" }))
      .mockResolvedValueOnce(response({ sha: "workflow-sha" }))
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
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it("times out with the transient cause when retries exhaust the deadline", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ sha: "workflow-sha" }))
      .mockResolvedValueOnce(response({ sha: "workflow-sha" }))
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }));

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

  it("keeps polling a pending run until both jobs pass", async () => {
    const sleeps: number[] = [];
    const pendingJobs = successfulJobs.map((job) => ({
      ...job,
      status: "in_progress",
      conclusion: null,
    }));
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ sha: "workflow-sha" }))
      .mockResolvedValueOnce(response({ sha: "workflow-sha" }))
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
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });
});
