import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
    [["build", "-vh"], ""],
    [["-fhelp", "build"], "build"],
    [["build", "-fhelp"], "build"],
    [["-f", "-h", "build"], "build"],
  ])("detects build after global options %j", async (args, expected) => {
    const { stdout } = await execFile("bash", [commandScriptPath, ...args]);
    expect(stdout).toBe(expected);
  });

  it.each([
    ["dev", ["dev"], true],
    ["build", ["build"], true],
    ["info", ["info"], false],
    ["help", ["--help"], false],
  ])("prepares OCR only for Tauri %s commands", async (_name, args, shouldPrepare) => {
    const directory = await mkdtemp(path.join(tmpdir(), "epikrise-tauri-command-"));
    const binDirectory = path.join(directory, "bin");
    const fakeBash = path.join(binDirectory, "bash");
    const fakeNode = path.join(binDirectory, "node");
    const fakeAppBinary = path.join(directory, "epikrise");
    const preparationLog = path.join(directory, "prepare.log");

    try {
      await mkdir(binDirectory);
      await writeFile(
        fakeBash,
        [
          "#!/bin/bash",
          'script="${1##*/}"',
          'case "$script" in',
          '  tauri-command.sh) exec /bin/bash "$@" ;;',
          "  with-cargo-host-target.sh) exit 0 ;;",
          '  tauri-build-output.sh) printf "%s\\n" "$TAURI_TEST_APP_BINARY" ;;',
          '  prepare-ocr.sh) printf "prepared\\n" >> "$OCR_PREP_LOG" ;;',
          '  *) exec /bin/bash "$@" ;;',
          "esac",
          "",
        ].join("\n"),
      );
      await chmod(fakeBash, 0o755);
      await writeFile(
        fakeNode,
        [
          "#!/bin/bash",
          'case "${1##*/}" in',
          "  verify-binary-architecture.mjs|verify-runtime-dependencies.mjs) exit 0 ;;",
          `  *) exec ${JSON.stringify(process.execPath)} "$@" ;;`,
          "esac",
          "",
        ].join("\n"),
      );
      await chmod(fakeNode, 0o755);
      await writeFile(fakeAppBinary, "synthetic test executable\n");

      await execFile("bash", [path.join(repoRoot, "scripts/tauri.sh"), ...args], {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${binDirectory}${path.delimiter}${process.env.PATH}`,
          OCR_PREP_LOG: preparationLog,
          TAURI_TEST_APP_BINARY: fakeAppBinary,
        },
      });

      const preparation = await readFile(preparationLog, "utf8").catch((error) => {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return "";
        }
        throw error;
      });
      expect(preparation).toBe(shouldPrepare ? "prepared\n" : "");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
