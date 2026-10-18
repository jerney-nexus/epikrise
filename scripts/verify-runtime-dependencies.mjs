import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);

/** @param {unknown} error */
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** @param {unknown} error */
function getChildProcessOutput(error) {
  if (typeof error !== "object" || error === null) return "";

  const stdout =
    "stdout" in error && typeof error.stdout === "string" ? error.stdout : "";
  const stderr =
    "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
  return `${stdout}\n${stderr}`;
}

/** @param {string} binaryPath @param {string} output */
export function assertResolvedLinuxDependencies(binaryPath, output) {
  const lines = output.split(/\r?\n/);
  const missingLibraries = lines
    .filter((line) => /=>\s+not found\s*$/.test(line))
    .map((line) => line.trim().split(/\s+/)[0]);

  if (missingLibraries.length > 0) {
    throw new Error(
      `Unresolved runtime dependencies for ${binaryPath}: ${missingLibraries.join(", ")}.`,
    );
  }

  const unavailableLibraryVersions = lines.filter((line) =>
    /\bversion\s+(?:'[^']+'|"[^"]+"|`[^']+')\s+not found\b/i.test(line),
  );
  if (unavailableLibraryVersions.length > 0) {
    throw new Error(
      `Unresolved runtime library versions for ${binaryPath}: ${unavailableLibraryVersions.map((line) => line.trim()).join("; ")}.`,
    );
  }

  const hasDependencyRecord = lines.some((line) =>
    /^\s*\S+\.so(?:\.\S+)*\s+(?:=>\s+\S+|\(0x[0-9a-f]+\))/i.test(line),
  );
  const hasStaticLinkDiagnostic = lines.some((line) =>
    /(?:^|:\s*)(?:not a dynamic executable|statically linked)$/i.test(line.trim()),
  );

  if (!hasDependencyRecord && !hasStaticLinkDiagnostic) {
    throw new Error(`Could not recognize ldd output for ${binaryPath}.`);
  }
}

/** @param {string} binaryPath @param {string} output */
export function assertSystemOnlyMachODependencies(binaryPath, output) {
  const [header, ...outputLines] = output.split(/\r?\n/);
  const dependencyLines = outputLines.filter((line) => line.trim().length > 0);
  if (
    !header?.trim().endsWith(":") ||
    dependencyLines.length === 0 ||
    dependencyLines.some(
      (line) => !/^\s*.+\s+\(compatibility version [^)]+\)\s*$/.test(line),
    )
  ) {
    throw new Error(`Could not recognize otool output for ${binaryPath}.`);
  }

  const libraryPaths = dependencyLines
    .map((line) => line.trim().split(/\s+\(/)[0])
    .filter(Boolean);
  if (
    binaryPath.endsWith(".dylib") &&
    libraryPaths.length > 0 &&
    path.basename(libraryPaths[0]) === path.basename(binaryPath)
  ) {
    libraryPaths.shift();
  }

  const externalLibraries = libraryPaths.filter(
    (libraryPath) =>
      !libraryPath.startsWith("/usr/lib/") &&
      !libraryPath.startsWith("/System/Library/") &&
      !libraryPath.startsWith("/Library/Apple/"),
  );

  if (externalLibraries.length > 0) {
    throw new Error(
      `Non-system runtime dependencies for ${binaryPath}: ${externalLibraries.join(", ")}.`,
    );
  }
}

const windowsSystemLibraries = new Set([
  "advapi32.dll",
  "bcrypt.dll",
  "bcryptprimitives.dll",
  "cfgmgr32.dll",
  "comctl32.dll",
  "comdlg32.dll",
  "combase.dll",
  "crypt32.dll",
  "cryptbase.dll",
  "dwrite.dll",
  "dwmapi.dll",
  "gdi32.dll",
  "gdi32full.dll",
  "imm32.dll",
  "kernel32.dll",
  "kernelbase.dll",
  "msvcp_win.dll",
  "msvcrt.dll",
  "ntdll.dll",
  "ole32.dll",
  "oleacc.dll",
  "oleaut32.dll",
  "rpcrt4.dll",
  "sechost.dll",
  "setupapi.dll",
  "shcore.dll",
  "shell32.dll",
  "shlwapi.dll",
  "ucrtbase.dll",
  "user32.dll",
  "userenv.dll",
  "version.dll",
  "win32u.dll",
  "winmm.dll",
  "wintrust.dll",
  "ws2_32.dll",
]);

/** @param {string} binaryPath @param {string} output */
export function assertSystemOnlyPEDependencies(binaryPath, output) {
  const dependencies = [
    ...new Set(
      [...output.matchAll(/^\s+([a-z0-9_.-]+\.dll)\s*$/gim)].map((match) =>
        match[1].toLowerCase(),
      ),
    ),
  ];
  if (dependencies.length === 0) {
    throw new Error(`Could not find PE runtime dependencies for ${binaryPath}.`);
  }

  const externalLibraries = dependencies.filter(
    (library) =>
      !library.startsWith("api-ms-win-") &&
      !library.startsWith("ext-ms-win-") &&
      !windowsSystemLibraries.has(library),
  );
  if (externalLibraries.length > 0) {
    throw new Error(
      `Non-system runtime dependencies for ${binaryPath}: ${externalLibraries.join(", ")}.`,
    );
  }
}

/** @param {string} target @param {string[]} binaryPaths */
export async function verifyLinuxRuntimeDependencies(target, binaryPaths) {
  if (!target.endsWith("-unknown-linux-gnu")) {
    throw new Error(`Linux runtime dependency checks do not support target ${target}.`);
  }

  for (const binaryPath of binaryPaths) {
    let output;
    try {
      const result = await execFile("ldd", [binaryPath]);
      output = `${result.stdout}\n${result.stderr}`;
    } catch (error) {
      output = getChildProcessOutput(error);
      if (
        !output.includes("not a dynamic executable") &&
        !output.includes("statically linked")
      ) {
        throw new Error(
          `Could not inspect runtime dependencies for ${binaryPath}: ${(output || getErrorMessage(error)).trim()}`,
          {
            cause: error,
          },
        );
      }
    }

    assertResolvedLinuxDependencies(binaryPath, output);
    console.log(`Verified runtime dependencies: ${binaryPath}`);
  }
}

/** @param {string} target @param {string[]} binaryPaths */
export async function verifyMacOSRuntimeDependencies(target, binaryPaths) {
  if (!target.endsWith("-apple-darwin")) {
    throw new Error(`macOS runtime dependency checks do not support target ${target}.`);
  }

  for (const binaryPath of binaryPaths) {
    let output;
    try {
      const result = await execFile("otool", ["-L", binaryPath]);
      output = `${result.stdout}\n${result.stderr}`;
    } catch (error) {
      throw new Error(
        `Could not inspect runtime dependencies for ${binaryPath}: ${(getChildProcessOutput(error) || getErrorMessage(error)).trim()}`,
        { cause: error },
      );
    }

    assertSystemOnlyMachODependencies(binaryPath, output);
    console.log(`Verified runtime dependencies: ${binaryPath}`);
  }
}

/** @param {string} target @param {string[]} binaryPaths */
export async function verifyWindowsRuntimeDependencies(target, binaryPaths) {
  if (!target.endsWith("-pc-windows-msvc")) {
    throw new Error(
      `Windows runtime dependency checks do not support target ${target}.`,
    );
  }

  for (const binaryPath of binaryPaths) {
    let output;
    try {
      const result = await execFile("dumpbin", ["/dependents", binaryPath]);
      output = `${result.stdout}\n${result.stderr}`;
    } catch (error) {
      throw new Error(
        `Could not inspect runtime dependencies for ${binaryPath}: ${(getChildProcessOutput(error) || getErrorMessage(error)).trim()}`,
        { cause: error },
      );
    }

    assertSystemOnlyPEDependencies(binaryPath, output);
    console.log(`Verified runtime dependencies: ${binaryPath}`);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [target, ...binaryPaths] = process.argv.slice(2);
  if (!target || binaryPaths.length === 0) {
    console.error(
      `Usage: node ${path.basename(fileURLToPath(import.meta.url))} <target> <binary> [<binary> ...]`,
    );
    process.exitCode = 2;
  } else {
    try {
      if (target.endsWith("-unknown-linux-gnu")) {
        await verifyLinuxRuntimeDependencies(target, binaryPaths);
      } else if (target.endsWith("-apple-darwin")) {
        await verifyMacOSRuntimeDependencies(target, binaryPaths);
      } else if (target.endsWith("-pc-windows-msvc")) {
        await verifyWindowsRuntimeDependencies(target, binaryPaths);
      } else {
        throw new Error(`Runtime dependency checks do not support target ${target}.`);
      }
    } catch (error) {
      console.error(getErrorMessage(error));
      process.exitCode = 1;
    }
  }
}
