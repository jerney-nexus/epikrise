import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** @param {string} architecture */
function normalizeArchitecture(architecture) {
  switch (architecture.toLowerCase()) {
    case "amd64":
    case "x86_64":
      return "x86_64";
    case "aarch64":
    case "arm64":
      return "aarch64";
    default:
      throw new Error(`Unsupported Linux architecture: ${architecture}.`);
  }
}

/** @param {string} cpuInfo */
function detectCpuInfoArchitecture(cpuInfo) {
  const x86Architecture = /^(?:vendor_id|model name)\s*:/im.test(cpuInfo);
  const arm64Architecture =
    /^CPU architecture\s*:\s*8\s*$/im.test(cpuInfo) ||
    /^Features\s*:.*\basimd\b/im.test(cpuInfo);

  if (x86Architecture === arm64Architecture) {
    throw new Error(
      "Could not establish the native Linux host architecture from /proc/cpuinfo; refusing possible emulation.",
    );
  }

  return x86Architecture ? "x86_64" : "aarch64";
}

/**
 * @param {string} rustHostTriple
 * @param {string} unameArchitecture
 * @param {string} cpuInfo
 */
export function verifyLinuxHostArchitecture(
  rustHostTriple,
  unameArchitecture,
  cpuInfo,
) {
  const rustHostArchitecture = normalizeArchitecture(rustHostTriple.split("-", 1)[0]);
  const kernelArchitecture = normalizeArchitecture(unameArchitecture);
  const cpuInfoArchitecture = detectCpuInfoArchitecture(cpuInfo);

  if (kernelArchitecture !== cpuInfoArchitecture) {
    throw new Error(
      `Linux uname architecture ${kernelArchitecture} does not match detected physical host ${cpuInfoArchitecture}; refusing possible emulation.`,
    );
  }

  if (rustHostArchitecture !== cpuInfoArchitecture) {
    throw new Error(
      `Rust host architecture ${rustHostArchitecture} does not match detected physical host ${cpuInfoArchitecture}.`,
    );
  }

  return cpuInfoArchitecture;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [rustHostTriple, unameArchitecture] = process.argv.slice(2);
  if (!rustHostTriple || !unameArchitecture) {
    console.error(
      `Usage: node ${path.basename(fileURLToPath(import.meta.url))} <rust-host-triple> <uname-architecture>`,
    );
    process.exitCode = 2;
  } else {
    try {
      const cpuInfo = readFileSync("/proc/cpuinfo", "utf8");
      console.log(
        verifyLinuxHostArchitecture(rustHostTriple, unameArchitecture, cpuInfo),
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
