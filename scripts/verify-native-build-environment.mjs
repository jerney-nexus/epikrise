import path from "node:path";
import { fileURLToPath } from "node:url";

const targetSpecifications = {
  "x86_64-unknown-linux-gnu": { os: "linux", architecture: "x86_64" },
  "aarch64-unknown-linux-gnu": { os: "linux", architecture: "aarch64" },
  "x86_64-apple-darwin": { os: "darwin", architecture: "x86_64" },
  "aarch64-apple-darwin": { os: "darwin", architecture: "aarch64" },
  "x86_64-pc-windows-msvc": { os: "windows", architecture: "x86_64" },
  "aarch64-pc-windows-msvc": { os: "windows", architecture: "aarch64" },
};

/** @param {string} target @returns {target is keyof typeof targetSpecifications} */
function isSupportedTarget(target) {
  return Object.hasOwn(targetSpecifications, target);
}

/** @param {string} value */
function normalizeOS(value) {
  switch (value.toLowerCase()) {
    case "linux":
      return "linux";
    case "darwin":
    case "macos":
      return "darwin";
    case "windows":
      return "windows";
    default:
      throw new Error(`Unsupported native build OS: ${value}.`);
  }
}

/** @param {string} value */
function normalizeArchitecture(value) {
  switch (value.toLowerCase()) {
    case "x64":
    case "amd64":
    case "x86_64":
      return "x86_64";
    case "arm64":
    case "aarch64":
      return "aarch64";
    default:
      throw new Error(`Unsupported native build architecture: ${value}.`);
  }
}

/**
 * @param {{ runnerOS: string, runnerArch: string, rustHost: string, target: string, buildMode: string }} evidence
 */
export function assertNativeBuildMetadata(evidence) {
  const { runnerOS, runnerArch, rustHost, target, buildMode } = evidence;
  if (!isSupportedTarget(target)) {
    throw new Error(`Unsupported native build target: ${target}.`);
  }
  const specification = targetSpecifications[target];
  if (normalizeOS(runnerOS) !== specification.os) {
    throw new Error(`Actions runner OS ${runnerOS} does not match target ${target}.`);
  }
  if (normalizeArchitecture(runnerArch) !== specification.architecture) {
    throw new Error(
      `Actions runner architecture ${runnerArch} does not match target ${target}.`,
    );
  }
  if (rustHost !== target) {
    throw new Error(`Rust host ${rustHost} does not match selected target ${target}.`);
  }
  if (!["diagnostic", "signed-release"].includes(buildMode)) {
    throw new Error(`Unsupported native build mode: ${buildMode}.`);
  }

  return {
    runner_os: runnerOS,
    runner_arch: runnerArch,
    rust_host: rustHost,
    target,
    build_mode: buildMode,
  };
}

/**
 * @param {{ runnerOS: string, runnerArch: string, physicalOS: string, physicalArch: string, rustHost: string, target: string, buildMode: string }} evidence
 */
export function verifyNativeBuildEnvironment(evidence) {
  const metadata = assertNativeBuildMetadata(evidence);
  if (!isSupportedTarget(evidence.target)) {
    throw new Error(`Unsupported native build target: ${evidence.target}.`);
  }
  const specification = targetSpecifications[evidence.target];
  if (normalizeOS(evidence.physicalOS) !== specification.os) {
    throw new Error(
      `Physical host OS ${evidence.physicalOS} does not match target ${evidence.target}.`,
    );
  }
  if (normalizeArchitecture(evidence.physicalArch) !== specification.architecture) {
    throw new Error(
      `Physical host architecture ${evidence.physicalArch} does not match target ${evidence.target}.`,
    );
  }
  return metadata;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [runnerOS, runnerArch, physicalOS, physicalArch, rustHost, target, buildMode] =
    process.argv.slice(2);
  if (
    !runnerOS ||
    !runnerArch ||
    !physicalOS ||
    !physicalArch ||
    !rustHost ||
    !target ||
    !buildMode
  ) {
    console.error(
      `Usage: node ${path.basename(fileURLToPath(import.meta.url))} <runner-os> <runner-arch> <physical-os> <physical-arch> <rust-host> <target> <build-mode>`,
    );
    process.exitCode = 2;
  } else {
    try {
      const evidence = verifyNativeBuildEnvironment({
        runnerOS,
        runnerArch,
        physicalOS,
        physicalArch,
        rustHost,
        target,
        buildMode,
      });
      console.log(`Verified native build environment for ${evidence.target}.`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
