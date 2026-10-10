import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertSystemOnlyPEDependencies,
  verifyLinuxRuntimeDependencies,
} from "../scripts/verify-runtime-dependencies.mjs";

describe("runtime dependency regressions", () => {
  it("accepts DirectWrite as a Windows system dependency", () => {
    expect(() =>
      assertSystemOnlyPEDependencies(
        "pdfium.dll",
        "Image has the following dependencies:\n    DWRITE.dll",
      ),
    ).not.toThrow();
  });

  if (process.platform === "linux") {
    it("accepts ldd's static-link diagnostic", async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "epikrise-static-ldd-"));
      const binDir = path.join(directory, "bin");
      const lddPath = path.join(binDir, "ldd");
      const previousPath = process.env.PATH;

      try {
        await mkdir(binDir);
        await writeFile(lddPath, '#!/bin/sh\nprintf "statically linked\\n"\nexit 1\n');
        await chmod(lddPath, 0o755);
        process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;

        await expect(
          verifyLinuxRuntimeDependencies("x86_64-unknown-linux-gnu", ["fixture"]),
        ).resolves.toBeUndefined();
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});
