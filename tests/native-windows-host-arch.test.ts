import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const builderPath = path.join(repoRoot, "scripts/build-native-windows-ocr.sh");

async function writeExecutable(filePath: string, content: string) {
  await writeFile(filePath, content, "utf8");
  await chmod(filePath, 0o755);
}

describe("native Windows MSVC host architecture", () => {
  it("rejects an x64-hosted ARM64 toolchain before downloading", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "epikrise-msvc-host-arch-"));
    const binDir = path.join(directory, "bin");
    const curlLog = path.join(directory, "curl.log");
    const cacheRoot = path.join(directory, "cache");
    const target = "aarch64-pc-windows-msvc";

    try {
      await mkdir(binDir);
      await writeExecutable(
        path.join(binDir, "uname"),
        "#!/usr/bin/env bash\nprintf 'MINGW64_NT\\n'\n",
      );
      await writeExecutable(
        path.join(binDir, "rustc"),
        `#!/usr/bin/env bash\nprintf 'host: ${target}\\n'\n`,
      );
      await writeExecutable(
        path.join(binDir, "curl"),
        '#!/usr/bin/env bash\nprintf "called\\n" >> "$CURL_LOG"\nexit 1\n',
      );

      await expect(
        execFile("bash", [builderPath, target], {
          env: {
            ...process.env,
            PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
            VSCMD_ARG_TGT_ARCH: "arm64",
            VSCMD_ARG_HOST_ARCH: "x64",
            CURL_LOG: curlLog,
            EPIKRISE_NATIVE_WINDOWS_OCR_CACHE: cacheRoot,
          },
        }),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("developer shell hosted on arm64"),
      });
      await expect(readFile(curlLog, "utf8")).rejects.toThrow();
      await expect(readdir(cacheRoot)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("separates caches by MSVC host architecture", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "epikrise-msvc-cache-"));
    const binDir = path.join(directory, "bin");
    const cacheRoot = path.join(directory, "cache");
    const curlLog = path.join(directory, "curl.log");
    const target = "x86_64-pc-windows-msvc";
    const toolset = "14.44.35207";

    try {
      await mkdir(binDir);
      await writeExecutable(
        path.join(binDir, "uname"),
        "#!/usr/bin/env bash\nprintf 'MINGW64_NT\\n'\n",
      );
      await writeExecutable(
        path.join(binDir, "rustc"),
        `#!/usr/bin/env bash\nprintf 'host: ${target}\\n'\n`,
      );
      for (const tool of ["cmake", "ninja", "cl", "dumpbin", "tar", "rg"]) {
        await writeExecutable(path.join(binDir, tool), "#!/usr/bin/env bash\nexit 0\n");
      }
      await writeExecutable(
        path.join(binDir, "curl"),
        '#!/usr/bin/env bash\nprintf "called\\n" >> "$CURL_LOG"\nexit 1\n',
      );

      await expect(
        execFile("bash", [builderPath, target], {
          env: {
            ...process.env,
            PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
            VSCMD_ARG_TGT_ARCH: "x64",
            VSCMD_ARG_HOST_ARCH: "x64",
            VCToolsVersion: toolset,
            CURL_LOG: curlLog,
            EPIKRISE_NATIVE_WINDOWS_OCR_CACHE: cacheRoot,
          },
        }),
      ).rejects.toThrow();

      expect(
        await readdir(path.join(cacheRoot, "build", `msvc-${toolset}-x64`, target)),
      ).toEqual([]);
      expect(
        await readdir(path.join(cacheRoot, "install", `msvc-${toolset}-x64`, target)),
      ).toEqual([]);
      await expect(
        readdir(path.join(cacheRoot, "build", `msvc-${toolset}`, target)),
      ).rejects.toThrow();
      expect(await readFile(curlLog, "utf8")).toBe("called\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
