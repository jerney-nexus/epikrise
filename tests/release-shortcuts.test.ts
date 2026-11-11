import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertManifestTargets,
  delegatedInvocation,
  selectDispatchedRun,
} from "../scripts/release-shortcuts.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const tag = "v2026.11.5";
const prefix = `https://github.com/jerney-nexus/epikrise/releases/download/${tag}/`;

type WorkflowRun = Parameters<typeof selectDispatchedRun>[0][number];

const expectedSha = "a".repeat(40);
const otherSha = "b".repeat(40);
const requestId = "11111111-2222-4333-8444-555555555555";

function run(overrides: Partial<WorkflowRun>): WorkflowRun {
  return {
    databaseId: 1,
    status: "queued",
    conclusion: "",
    event: "workflow_dispatch",
    headBranch: "main",
    headSha: expectedSha,
    displayTitle: `Windows release workspace ${requestId}`,
    createdAt: "2026-11-11T09:00:05Z",
    url: "https://github.com/jerney-nexus/epikrise/actions/runs/1",
    ...overrides,
  };
}

function selectOptions() {
  return {
    workflow: "windows-release-workspace.yml",
    requestId,
    expectedSha,
  };
}

describe("selectDispatchedRun", () => {
  it("picks the dispatch run that carries our request ID for the expected commit", () => {
    const ours = run({ databaseId: 42 });
    expect(selectDispatchedRun([ours], selectOptions())).toBe(ours);
  });

  it("returns undefined while no matching run has appeared", () => {
    expect(selectDispatchedRun([], selectOptions())).toBeUndefined();
  });

  it("ignores runs dispatched with a different request ID", () => {
    const runs = [
      run({ databaseId: 7, displayTitle: "Windows release workspace other-id" }),
    ];
    expect(selectDispatchedRun(runs, selectOptions())).toBeUndefined();
  });

  it("ignores runs for a different commit than origin main", () => {
    const runs = [run({ databaseId: 8, headSha: otherSha })];
    expect(selectDispatchedRun(runs, selectOptions())).toBeUndefined();
  });

  it("ignores runs not started by workflow_dispatch", () => {
    const runs = [run({ databaseId: 9, event: "push" })];
    expect(selectDispatchedRun(runs, selectOptions())).toBeUndefined();
  });

  it("ignores a teammate's run for the same commit without our request ID", () => {
    const runs = [
      run({ databaseId: 10, displayTitle: "Windows release workspace teammate-id" }),
    ];
    expect(selectDispatchedRun(runs, selectOptions())).toBeUndefined();
  });

  it("fails when two runs carry our request ID", () => {
    const runs = [run({ databaseId: 12 }), run({ databaseId: 13 })];
    expect(() => selectDispatchedRun(runs, selectOptions())).toThrow(
      `More than one windows-release-workspace.yml run carries request ${requestId} for ${expectedSha}`,
    );
  });
});

describe("release shortcuts", () => {
  it("lists each platform target when latest.json points at the tag assets", () => {
    expect(
      assertManifestTargets(
        {
          platforms: {
            "windows-x86_64": { signature: "sig", url: `${prefix}app.msi.zip` },
          },
        },
        tag,
      ),
    ).toEqual([`  windows-x86_64: ${prefix}app.msi.zip`]);
  });

  it("rejects a manifest that targets another release", () => {
    expect(() =>
      assertManifestTargets(
        {
          platforms: {
            "windows-x86_64": {
              signature: "sig",
              url: "https://github.com/jerney-nexus/epikrise/releases/download/v2026.11.4/app.zip",
            },
          },
        },
        tag,
      ),
    ).toThrow("does not target v2026.11.5");
  });

  it("rejects a manifest entry without a signature", () => {
    expect(() =>
      assertManifestTargets(
        { platforms: { "linux-x86_64": { url: `${prefix}a` } } },
        tag,
      ),
    ).toThrow("has no signature");
  });

  it("rejects dot segments that escape the tag's asset directory", () => {
    for (const escape of [
      `${prefix}../v2026.11.4/app.zip`,
      `${prefix}%2e%2e/v2026.11.4/app.zip`,
    ]) {
      expect(() =>
        assertManifestTargets(
          { platforms: { "windows-x86_64": { signature: "sig", url: escape } } },
          tag,
        ),
      ).toThrow("does not target v2026.11.5");
    }
  });

  it("forwards version arguments to the delegated release scripts", () => {
    const scripts = path.join(repoRoot, "scripts");
    expect(delegatedInvocation("prepare", ["2026.11.6"])).toEqual({
      script: path.join(scripts, "prepare-release.mjs"),
      args: ["2026.11.6"],
    });
    expect(delegatedInvocation("prepare-workflow", [])).toEqual({
      script: path.join(scripts, "release-prepare-workflow.mjs"),
      args: [],
    });
    expect(delegatedInvocation("preflight", [])).toEqual({
      script: path.join(scripts, "release-start.mjs"),
      args: ["preflight"],
    });
    expect(delegatedInvocation("tag", ["2026.11.5"])).toEqual({
      script: path.join(scripts, "release-start.mjs"),
      args: ["tag", "2026.11.5"],
    });
  });

  it("returns null for subcommands it does not delegate", () => {
    expect(delegatedInvocation("pull-request", [])).toBeNull();
    expect(delegatedInvocation("constructor", [])).toBeNull();
  });

  it("wires shortcuts and existing release scripts through the dispatcher", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(repoRoot, "package.json"), "utf8"),
    );
    expect(packageJson.scripts["release:prepare"]).toBe(
      "node scripts/release-shortcuts.mjs prepare",
    );
    expect(packageJson.scripts["release:prepare:workflow"]).toBe(
      "node scripts/release-shortcuts.mjs prepare-workflow",
    );
    expect(packageJson.scripts["release:preflight"]).toBe(
      "node scripts/release-shortcuts.mjs preflight",
    );
    expect(packageJson.scripts["release:tag"]).toBe(
      "node scripts/release-shortcuts.mjs tag",
    );
    expect(packageJson.scripts["release:pr"]).toBe(
      "node scripts/release-shortcuts.mjs pull-request",
    );
    expect(packageJson.scripts["release:workspace"]).toBe(
      "node scripts/release-shortcuts.mjs windows-workspace",
    );
    expect(packageJson.scripts["release:draft-status"]).toBe(
      "node scripts/release-shortcuts.mjs draft-status",
    );
    expect(packageJson.scripts["release:published-status"]).toBe(
      "node scripts/release-shortcuts.mjs published-status",
    );
    for (const [name, script] of Object.entries(packageJson.scripts)) {
      if (name.startsWith("release:")) {
        expect(script, name).not.toMatch(/approve|publish-release|git tag|git push/);
      }
    }
  });

  it("adds Epikrise-prefixed VS Code tasks for each shortcut", async () => {
    const tasks = JSON.parse(
      await readFile(path.join(repoRoot, ".vscode/tasks.json"), "utf8"),
    );
    const shortcutArgs = [
      "release:pr",
      "release:workspace",
      "release:draft-status",
      "release:published-status",
    ];
    for (const script of shortcutArgs) {
      expect(tasks.tasks).toContainEqual(
        expect.objectContaining({
          label: expect.stringMatching(/^Epikrise: /),
          command: "pnpm",
          args: [script],
        }),
      );
    }
  });
});
