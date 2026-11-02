import { describe, expect, it, vi } from "vitest";
import {
  evaluateSmokeRun,
  findMatchingSmokeRuns,
  waitForMacosSmoke,
} from "../scripts/wait-for-release-pr-macos-smoke.mjs";

const successfulRun = {
  id: 123,
  event: "pull_request",
  head_sha: "release-sha",
  head_branch: "release/2026.11.0",
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
  it("finds the workflow run for the exact release head SHA and branch", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        workflow_runs: [
          successfulRun,
          { ...successfulRun, id: 122, head_sha: "old-sha" },
          { ...successfulRun, id: 121, head_branch: "release/other" },
        ],
      }),
    );

    const runs = await findMatchingSmokeRuns({
      apiBaseUrl: "https://api.github.com",
      owner: "owner",
      repo: "repo",
      headSha: "release-sha",
      headRef: "release/2026.11.0",
      token: "test-token",
      fetchImpl,
    });

    expect(runs).toEqual([successfulRun]);
    expect(fetchImpl.mock.calls[0][0]).toContain(
      "head_sha=release-sha&event=pull_request",
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
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ workflow_runs: [] }));

    await expect(
      waitForMacosSmoke({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        headSha: "release-sha",
        headRef: "release/2026.11.0",
        token: "test-token",
        fetchImpl,
        now: () => 1_000,
        maxWaitMs: 0,
      }),
    ).rejects.toThrow("no matching smoke workflow run has appeared");
  });
});
