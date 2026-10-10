import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const commandScriptPath = path.join(repoRoot, "scripts/tauri-command.sh");

describe("Tauri command detection", () => {
  it.each([
    [["--verbose", "build"], "build"],
    [["-vv", "build"], "build"],
    [["--help", "build"], ""],
    [["build", "--help"], ""],
  ])("detects build after global options %j", async (args, expected) => {
    const { stdout } = await execFile("bash", [commandScriptPath, ...args]);
    expect(stdout).toBe(expected);
  });
});
