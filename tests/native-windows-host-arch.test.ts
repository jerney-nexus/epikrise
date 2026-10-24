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
        path.join(binDir, "powershell.exe"),
        "#!/usr/bin/env bash\nprintf 'Arm64\\n'\n",
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
            EPIKRISE_RUNNER_ARCH: "ARM64",
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

  it("uses physical Windows architecture instead of Actions runner metadata", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "epikrise-msvc-physical-arm64-"),
    );
    const binDir = path.join(directory, "bin");
    const curlLog = path.join(directory, "curl.log");
    const cacheRoot = path.join(directory, "cache");
    const target = "x86_64-pc-windows-msvc";

    try {
      await mkdir(binDir);
      await writeExecutable(
        path.join(binDir, "uname"),
        "#!/usr/bin/env bash\nprintf 'MINGW64_NT\\n'\n",
      );
      await writeExecutable(
        path.join(binDir, "powershell.exe"),
        "#!/usr/bin/env bash\nprintf 'Arm64\\n'\n",
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
            EPIKRISE_RUNNER_ARCH: "X64",
            VSCMD_ARG_TGT_ARCH: "x64",
            VSCMD_ARG_HOST_ARCH: "x64",
            CURL_LOG: curlLog,
            EPIKRISE_NATIVE_WINDOWS_OCR_CACHE: cacheRoot,
          },
        }),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining(
          "does not match detected physical Windows architecture aarch64",
        ),
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
    const msvcToolsetDir = path.join(directory, "msvc-bin", toolset);
    const msvcBinDir = path.join(msvcToolsetDir, "bin", "Hostx64", "x64");
    const msvcIncludeDir = path.join(msvcToolsetDir, "include");
    const msvcLibDir = path.join(msvcToolsetDir, "lib", "x64");

    try {
      await mkdir(binDir);
      await mkdir(msvcBinDir, { recursive: true });
      await mkdir(msvcIncludeDir, { recursive: true });
      await mkdir(msvcLibDir, { recursive: true });
      await writeFile(path.join(msvcIncludeDir, "vcruntime.h"), "mock runtime header");
      await writeFile(path.join(msvcLibDir, "libcmt.lib"), "mock static runtime");
      await writeExecutable(
        path.join(binDir, "uname"),
        "#!/usr/bin/env bash\nprintf 'MINGW64_NT\\n'\n",
      );
      await writeExecutable(
        path.join(binDir, "powershell.exe"),
        "#!/usr/bin/env bash\nprintf 'X64\\n'\n",
      );
      await writeExecutable(
        path.join(binDir, "rustc"),
        `#!/usr/bin/env bash\nprintf 'host: ${target}\\n'\n`,
      );
      for (const tool of ["cmake", "ninja", "tar", "grep"]) {
        await writeExecutable(path.join(binDir, tool), "#!/usr/bin/env bash\nexit 0\n");
      }
      for (const tool of ["cl.exe", "dumpbin.exe"]) {
        await writeExecutable(
          path.join(msvcBinDir, tool),
          "#!/usr/bin/env bash\nexit 0\n",
        );
      }
      await writeExecutable(
        path.join(binDir, "cygpath"),
        '#!/usr/bin/env bash\ncase "$1" in\n  -u) printf "%s\\n" "$MSVC_CL_PATH" ;;\n  -w) if [[ "$2" == "$MSVC_INCLUDE_DIR" ]]; then printf "%s\\n" "$MSVC_INCLUDE_PATH"; else printf "%s\\n" "$MSVC_LIB_PATH"; fi ;;\n  *) exit 2 ;;\nesac\n',
      );
      await writeExecutable(
        path.join(binDir, "curl"),
        '#!/usr/bin/env bash\nprintf "called\\n" >> "$CURL_LOG"\nprintf "%s\\n%s\\n%s\\n" "$MSYS2_ENV_CONV_EXCL" "$INCLUDE" "$LIB" > "$MSYS_ENV_LOG"\nexit 1\n',
      );

      await expect(
        execFile("bash", [builderPath, target], {
          env: {
            ...process.env,
            PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
            EPIKRISE_RUNNER_ARCH: "X64",
            VSCMD_ARG_TGT_ARCH: "x64",
            VSCMD_ARG_HOST_ARCH: "x64",
            EPIKRISE_MSVC_CL_EXE: `C:\\Visual Studio\\VC\\Tools\\MSVC\\${toolset}\\bin\\Hostx64\\x64\\cl.exe`,
            MSVC_CL_PATH: path.join(msvcBinDir, "cl.exe"),
            MSVC_INCLUDE_DIR: msvcIncludeDir,
            MSVC_INCLUDE_PATH: `C:\\Visual Studio\\VC\\Tools\\MSVC\\${toolset}\\include`,
            MSVC_LIB_PATH: `C:\\Visual Studio\\VC\\Tools\\MSVC\\${toolset}\\lib\\x64`,
            CURL_LOG: curlLog,
            MSYS_ENV_LOG: path.join(directory, "msys-env.log"),
            EPIKRISE_NATIVE_WINDOWS_OCR_CACHE: cacheRoot,
          },
        }),
      ).rejects.toThrow();

      const [conversionExclusions, includeSearchPath, libSearchPath] = (
        await readFile(path.join(directory, "msys-env.log"), "utf8")
      )
        .trimEnd()
        .split(/\r?\n/);
      expect(conversionExclusions.trim().split(";")).toEqual(
        expect.arrayContaining(["INCLUDE=", "LIB=", "LIBPATH="]),
      );
      expect(libSearchPath.split(";")[0]).toBe(
        `C:\\Visual Studio\\VC\\Tools\\MSVC\\${toolset}\\lib\\x64`,
      );
      expect(includeSearchPath.split(";")[0]).toBe(
        `C:\\Visual Studio\\VC\\Tools\\MSVC\\${toolset}\\include`,
      );
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
