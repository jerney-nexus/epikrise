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
    it("runs ldd in the C locale to recognize static-link diagnostics", async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "epikrise-static-ldd-"));
      const binDir = path.join(directory, "bin");
      const lddPath = path.join(binDir, "ldd");
      const previousPath = process.env.PATH;
      const previousLocale = process.env.LC_ALL;

      try {
        await mkdir(binDir);
        await writeFile(
          lddPath,
          '#!/bin/sh\nif [ "$LC_ALL" = "C" ]; then printf "statically linked\\n"; else printf "Das Programm ist nicht dynamisch gelinkt.\\n"; fi\nexit 1\n',
        );
        await chmod(lddPath, 0o755);
        process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
        process.env.LC_ALL = "de_DE.UTF-8";

        await expect(
          verifyLinuxRuntimeDependencies("x86_64-unknown-linux-gnu", ["fixture"]),
        ).resolves.toBeUndefined();
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        if (previousLocale === undefined) delete process.env.LC_ALL;
        else process.env.LC_ALL = previousLocale;
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});
