import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const wrapperPath = path.join(repoRoot, "scripts/with-cargo-host-target.sh");

async function writeExecutable(filePath: string, content: string) {
  await writeFile(filePath, content, "utf8");
  await chmod(filePath, 0o755);
}

describe("non-native Cargo host guard", () => {
  it("does not enforce native-only matching for ordinary Cargo commands", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "epikrise-emulated-host-"));
    const binDir = path.join(directory, "bin");
    const cargoLog = path.join(directory, "cargo.log");

    try {
      await mkdir(binDir);
      await writeExecutable(
        path.join(binDir, "rustc"),
        "#!/usr/bin/env bash\nprintf 'host: x86_64-unknown-linux-gnu\\n'\n",
      );
      await writeExecutable(
        path.join(binDir, "uname"),
        '#!/bin/sh\ncase "$1" in\n  -s) printf "Linux\\n" ;;\n  -m) printf "aarch64\\n" ;;\nesac\n',
      );
      await writeExecutable(
        path.join(binDir, "cargo"),
        '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$CARGO_LOG"\n',
      );

      await execFile("bash", [wrapperPath, "cargo", "check"], {
        env: {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
          CARGO_LOG: cargoLog,
        },
      });

      expect(await readFile(cargoLog, "utf8")).toBe("check\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
