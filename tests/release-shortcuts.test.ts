import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertManifestTargets } from "../scripts/release-shortcuts.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const tag = "v2026.11.5";
const prefix = `https://github.com/jerney-nexus/epikrise/releases/download/${tag}/`;

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

  it("wires shortcuts to package scripts without publishing or tagging", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(repoRoot, "package.json"), "utf8"),
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
