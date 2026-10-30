import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { verifyLinuxHostArchitecture } from "../scripts/verify-linux-host-architecture.mjs";

const execFile = promisify(execFileCallback);
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const wrapperPath = path.join(repoRoot, "scripts/with-cargo-host-target.sh");

async function writeExecutable(filePath: string, content: string) {
  await writeFile(filePath, content, "utf8");
  await chmod(filePath, 0o755);
}

describe("non-native Cargo host guard", () => {
  it("rejects emulated Linux when Rust and uname agree but the host CPU differs", () => {
    const x86CpuInfo =
      "processor : 0\nvendor_id : GenuineIntel\nmodel name : Intel Xeon\n";

    expect(() =>
      verifyLinuxHostArchitecture("aarch64-unknown-linux-gnu", "aarch64", x86CpuInfo),
    ).toThrow(
      "Linux uname architecture aarch64 does not match detected physical host x86_64",
    );
  });

  it("fails closed when the Linux host architecture cannot be established", () => {
    expect(() =>
      verifyLinuxHostArchitecture("x86_64-unknown-linux-gnu", "x86_64", ""),
    ).toThrow(
      "Could not establish the native Linux host architecture from /proc/cpuinfo",
    );
  });

  it.each([
    [
      "x86_64-unknown-linux-gnu",
      "x86_64",
      "processor : 0\nvendor_id : GenuineIntel\nmodel name : Intel Xeon\n",
      "x86_64",
    ],
    [
      "aarch64-unknown-linux-gnu",
      "aarch64",
      "processor : 0\nCPU architecture : 8\nFeatures : fp asimd aes\n",
      "aarch64",
    ],
  ])(
    "accepts native Linux architecture %s",
    (rustHostTriple, unameArchitecture, cpuInfo, expectedArchitecture) => {
      expect(
        verifyLinuxHostArchitecture(rustHostTriple, unameArchitecture, cpuInfo),
      ).toBe(expectedArchitecture);
    },
  );

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
