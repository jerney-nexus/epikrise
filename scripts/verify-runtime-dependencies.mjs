import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);

export function assertResolvedLinuxDependencies(binaryPath, output) {
  const missingLibraries = output
    .split(/\r?\n/)
    .filter((line) => /=>\s+not found\s*$/.test(line))
    .map((line) => line.trim().split(/\s+/)[0]);

  if (missingLibraries.length > 0) {
    throw new Error(
      `Unresolved runtime dependencies for ${binaryPath}: ${missingLibraries.join(", ")}.`,
    );
  }
}

export function assertSystemOnlyMachODependencies(binaryPath, output) {
  const externalLibraries = output
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+\(/)[0])
    .filter(Boolean)
    .filter(
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
      output = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
      if (!output.includes("not a dynamic executable")) {
        throw new Error(
          `Could not inspect runtime dependencies for ${binaryPath}: ${output.trim()}`,
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
        `Could not inspect runtime dependencies for ${binaryPath}: ${(error.stderr ?? error.message).trim()}`,
        { cause: error },
      );
    }

    assertSystemOnlyMachODependencies(binaryPath, output);
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
      `Usage: node ${path.basename(fileURLToPath(import.meta.url))} <linux-target> <binary> [<binary> ...]`,
    );
    process.exitCode = 2;
  } else {
    try {
      if (target.endsWith("-unknown-linux-gnu")) {
        await verifyLinuxRuntimeDependencies(target, binaryPaths);
      } else if (target.endsWith("-apple-darwin")) {
        await verifyMacOSRuntimeDependencies(target, binaryPaths);
      } else {
        throw new Error(`Runtime dependency checks do not support target ${target}.`);
      }
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
