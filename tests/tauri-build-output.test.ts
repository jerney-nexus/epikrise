import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const outputScriptPath = path.join(repoRoot, "scripts/tauri-build-output.sh");

describe("Tauri build output path", () => {
  it.each([
    [
      "host target by default",
      "x86_64-unknown-linux-gnu",
      [],
      undefined,
      "release",
      "",
    ],
    [
      "explicit target",
      "x86_64-unknown-linux-gnu",
      ["--target", "x86_64-unknown-linux-gnu"],
      undefined,
      "release",
      "x86_64-unknown-linux-gnu/",
    ],
    [
      "equals target option",
      "x86_64-unknown-linux-gnu",
      ["--target=aarch64-unknown-linux-gnu"],
      undefined,
      "release",
      "aarch64-unknown-linux-gnu/",
    ],
    [
      "environment target",
      "x86_64-unknown-linux-gnu",
      [],
      "x86_64-unknown-linux-gnu",
      "release",
      "x86_64-unknown-linux-gnu/",
    ],
    ["debug profile", "x86_64-unknown-linux-gnu", ["--debug"], undefined, "debug", ""],
    ["Windows executable", "aarch64-pc-windows-msvc", [], undefined, "release", ""],
  ])(
    "derives the executable path for %s",
    async (_name, host, args, cargoBuildTarget, profile, targetSuffix) => {
      const { stdout } = await execFile("bash", [outputScriptPath, host, ...args], {
        env: {
          ...process.env,
          CARGO_BUILD_TARGET: cargoBuildTarget ?? "",
        },
      });
      const executable = host.endsWith("-pc-windows-msvc")
        ? "epikrise.exe"
        : "epikrise";
      expect(stdout).toBe(
        path.join(
          repoRoot,
          "src-tauri",
          "target",
          `host-${host}`,
          targetSuffix,
          profile,
          executable,
        ),
      );
    },
  );
});
