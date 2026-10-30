import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const outputScriptPath = path.join(repoRoot, "scripts/tauri-build-output.sh");

function toGitBashPath(filePath: string) {
  if (process.platform !== "win32") return filePath;
  const normalized = filePath.replaceAll("\\", "/");
  const drivePath = normalized.match(/^([A-Za-z]):\/(.*)$/);
  return drivePath ? `/${drivePath[1].toLowerCase()}/${drivePath[2]}` : normalized;
}

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
      "equals short target option",
      "x86_64-unknown-linux-gnu",
      ["-t=x86_64-unknown-linux-gnu"],
      undefined,
      "release",
      "x86_64-unknown-linux-gnu/",
    ],
    [
      "attached short target option",
      "x86_64-unknown-linux-gnu",
      ["-tx86_64-unknown-linux-gnu"],
      undefined,
      "release",
      "x86_64-unknown-linux-gnu/",
    ],
    [
      "clustered short target option",
      "x86_64-unknown-linux-gnu",
      ["-vt", "x86_64-unknown-linux-gnu"],
      undefined,
      "release",
      "x86_64-unknown-linux-gnu/",
    ],
    [
      "attached clustered short target option",
      "x86_64-unknown-linux-gnu",
      ["-vtx86_64-unknown-linux-gnu"],
      undefined,
      "release",
      "x86_64-unknown-linux-gnu/",
    ],
    [
      "debug cluster with split target",
      "x86_64-unknown-linux-gnu",
      ["-dt", "x86_64-unknown-linux-gnu"],
      undefined,
      "debug",
      "x86_64-unknown-linux-gnu/",
    ],
    [
      "debug cluster with attached target",
      "x86_64-unknown-linux-gnu",
      ["-dvtx86_64-unknown-linux-gnu"],
      undefined,
      "debug",
      "x86_64-unknown-linux-gnu/",
    ],
    [
      "clustered feature value containing target shorthand",
      "x86_64-unknown-linux-gnu",
      ["-vfdirect-release-updater"],
      undefined,
      "release",
      "",
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
    [
      "clustered verbose debug profile",
      "x86_64-unknown-linux-gnu",
      ["-vd"],
      undefined,
      "debug",
      "",
    ],
    [
      "clustered debug verbose profile",
      "x86_64-unknown-linux-gnu",
      ["-dv"],
      undefined,
      "debug",
      "",
    ],
    [
      "debug profile with Tauri runner option",
      "x86_64-unknown-linux-gnu",
      ["build", "--debug", "-r", "cargo"],
      undefined,
      "debug",
      "",
    ],
    [
      "forwarded custom profile",
      "x86_64-unknown-linux-gnu",
      ["build", "--", "--profile", "custom"],
      undefined,
      "custom",
      "",
    ],
    [
      "forwarded equals custom profile",
      "x86_64-unknown-linux-gnu",
      ["build", "--", "--profile=custom"],
      undefined,
      "custom",
      "",
    ],
    [
      "forwarded dev profile",
      "x86_64-unknown-linux-gnu",
      ["build", "--", "--profile", "dev"],
      undefined,
      "debug",
      "",
    ],
    [
      "forwarded test profile",
      "x86_64-unknown-linux-gnu",
      ["build", "--", "--profile", "test"],
      undefined,
      "debug",
      "",
    ],
    [
      "forwarded bench profile",
      "x86_64-unknown-linux-gnu",
      ["build", "--", "--profile", "bench"],
      undefined,
      "release",
      "",
    ],
    [
      "forwarded release profile",
      "x86_64-unknown-linux-gnu",
      ["build", "--", "--profile", "release"],
      undefined,
      "release",
      "",
    ],
    [
      "forwarded release short option",
      "x86_64-unknown-linux-gnu",
      ["build", "--", "-r"],
      undefined,
      "release",
      "",
    ],
    [
      "forwarded clustered release option overrides debug",
      "x86_64-unknown-linux-gnu",
      ["build", "--debug", "--", "-vr"],
      undefined,
      "release",
      "",
    ],
    [
      "forwarded release option at start of cluster overrides debug",
      "x86_64-unknown-linux-gnu",
      ["build", "--debug", "--", "-rv"],
      undefined,
      "release",
      "",
    ],
    [
      "forwarded target",
      "x86_64-unknown-linux-gnu",
      ["build", "--", "--target", "x86_64-unknown-linux-gnu"],
      undefined,
      "release",
      "x86_64-unknown-linux-gnu/",
    ],
    [
      "forwarded target equals custom profile",
      "x86_64-unknown-linux-gnu",
      ["build", "--", "--target=x86_64-unknown-linux-gnu", "--profile=custom"],
      undefined,
      "custom",
      "x86_64-unknown-linux-gnu/",
    ],
    [
      "Windows forwarded custom profile",
      "aarch64-pc-windows-msvc",
      ["build", "--", "--profile", "custom"],
      undefined,
      "custom",
      "",
    ],
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
        path.posix.join(
          toGitBashPath(repoRoot),
          "src-tauri/target",
          `host-${host}`,
          targetSuffix,
          profile,
          executable,
        ),
      );
    },
  );

  it.each([
    ["project Cargo config", ["build"], "project"],
    [
      "forwarded Cargo --config override",
      ["build", "--", "--config", 'build.target = "x86_64-unknown-linux-gnu"'],
      "override",
    ],
  ])(
    "includes the target directory from %s in the verified output path",
    async (_description, args, configSource) => {
      const directory = await mkdtemp(
        path.join(tmpdir(), "epikrise-build-output-config-"),
      );
      const cargoHome = path.join(directory, "cargo-home");
      const host = "x86_64-unknown-linux-gnu";

      try {
        await mkdir(cargoHome);
        if (configSource === "project") {
          await mkdir(path.join(directory, ".cargo"));
          await writeFile(
            path.join(directory, ".cargo/config.toml"),
            `[build]\ntarget = "${host}"\n`,
          );
        }

        const { stdout } = await execFile("bash", [outputScriptPath, host, ...args], {
          cwd: directory,
          env: { ...process.env, CARGO_HOME: cargoHome },
        });

        expect(stdout).toBe(
          path.posix.join(
            toGitBashPath(repoRoot),
            "src-tauri/target",
            `host-${host}`,
            `${host}/`,
            "release",
            "epikrise",
          ),
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
