import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findGitBash } from "./git-bash.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repoRoot, "scripts", "tauri.sh");
const windowsEnvironmentMarker = "EPIKRISE_NATIVE_WINDOWS_ENV_INITIALIZED";
const windowsArgumentsVariable = "EPIKRISE_TAURI_ARGS_JSON";

/**
 * @typedef {{
 *   homeDirectory?: string,
 *   machineIdPath?: string,
 *   readFile?: (filePath: string) => string,
 *   isSocketPath?: (filePath: string) => boolean
 * }} LinuxSessionBusDependencies
 */

/**
 * @typedef {{ status: number | null, error?: Error, stdout?: string | Buffer }} SpawnResult
 * @typedef {(command: string, args: string[], options: import("node:child_process").SpawnSyncOptions) => SpawnResult} Spawn
 * @typedef {{
 *   platform?: string,
 *   resolveGitBash?: () => string | undefined,
 *   resolveLinuxSessionBusAddress?: (env: NodeJS.ProcessEnv) => string | undefined,
 *   spawn?: Spawn,
 *   env?: NodeJS.ProcessEnv
 * }} TauriDependencies
 */

/** @param {unknown} error */
function isMissingFileError(error) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

/**
 * @param {string} filePath
 * @param {(filePath: string) => string} readFile
 * @returns {string | undefined}
 */
function readOptionalFile(filePath, readFile) {
  try {
    return readFile(filePath);
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
}

/** @param {string} filePath */
function isUnixSocket(filePath) {
  try {
    return statSync(filePath).isSocket();
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
}

/**
 * Resolve D-Bus autolaunch placeholders using the address recorded by dbus-launch.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {LinuxSessionBusDependencies} [dependencies]
 */
export function resolveLinuxSessionBusAddress(
  env,
  {
    homeDirectory = env.HOME || homedir(),
    machineIdPath = "/etc/machine-id",
    readFile = (filePath) => readFileSync(filePath, "utf8"),
    isSocketPath = isUnixSocket,
  } = {},
) {
  if (!env.DBUS_SESSION_BUS_ADDRESS?.startsWith("autolaunch:")) return undefined;

  const displayNumber = env.DISPLAY?.match(/(?:^|:)(\d+)(?:\.\d+)?$/)?.[1];
  if (!displayNumber) return undefined;

  const machineId = readOptionalFile(machineIdPath, readFile)?.trim();
  if (!machineId || !/^[\da-f]{32}$/i.test(machineId)) return undefined;

  const sessionBusFile = path.join(
    homeDirectory,
    ".dbus",
    "session-bus",
    `${machineId}-${displayNumber}`,
  );
  const sessionBusContents = readOptionalFile(sessionBusFile, readFile);
  if (!sessionBusContents) return undefined;

  const addressMatch = sessionBusContents.match(
    /^DBUS_SESSION_BUS_ADDRESS=(?:"([^"]+)"|'([^']+)'|([^\r\n]+))$/m,
  );
  const address = addressMatch?.[1] ?? addressMatch?.[2] ?? addressMatch?.[3];
  const socketPath = address?.match(/^unix:path=([^,]+)/)?.[1];
  if (!address || !socketPath || !isSocketPath(decodeURIComponent(socketPath))) {
    return undefined;
  }

  return address;
}

/**
 * @param {string[]} args
 * @param {Pick<TauriDependencies, "resolveGitBash" | "spawn" | "env"> & { stripBootstrapEnvironment?: boolean }} dependencies
 */
function runTauriWithGitBash(
  args,
  {
    resolveGitBash = findGitBash,
    spawn = spawnSync,
    env = process.env,
    stripBootstrapEnvironment = false,
  } = {},
) {
  const bash = resolveGitBash();
  if (!bash) {
    console.error(
      "Git for Windows Bash is required for native Tauri builds. Install Git for Windows and ensure its Bash is available.",
    );
    return 1;
  }

  const childEnv = stripBootstrapEnvironment ? { ...env } : env;
  if (stripBootstrapEnvironment) {
    delete childEnv[windowsEnvironmentMarker];
    delete childEnv[windowsArgumentsVariable];
  }
  const result = spawn(bash, [scriptPath, ...args], {
    cwd: repoRoot,
    env: childEnv,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`Could not start the Tauri build workflow: ${result.error.message}`);
    return 1;
  }

  return result.status ?? 1;
}

/**
 * @param {Spawn} spawn
 * @param {NodeJS.ProcessEnv} env
 */
function detectWindowsArchitecture(spawn, env) {
  let architecture = (env.EPIKRISE_RUNNER_ARCH || env.PROCESSOR_ARCHITEW6432 || "")
    .trim()
    .toLowerCase();

  if (!architecture) {
    const result = spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture",
      ],
      { encoding: "utf8", windowsHide: true },
    );
    if (!result.error && result.status === 0) {
      architecture =
        typeof result.stdout === "string"
          ? result.stdout.trim().toLowerCase()
          : result.stdout?.toString("utf8").trim().toLowerCase() || "";
    }
  }

  if (!architecture) {
    architecture = (env.RUNNER_ARCH || env.PROCESSOR_ARCHITECTURE || "")
      .trim()
      .toLowerCase();
  }
  if (!architecture) {
    console.error("Could not determine the Windows host architecture.");
    return undefined;
  }

  switch (architecture) {
    case "x64":
    case "amd64":
      return "x64";
    case "arm64":
      return "arm64";
    default:
      console.error(
        `Unsupported Windows host architecture reported by PowerShell: ${architecture || "no output"}.`,
      );
      return undefined;
  }
}

/**
 * @param {string[]} args
 * @param {TauriDependencies} dependencies
 */
function runTauriWithWindowsEnvironment(
  args,
  { resolveGitBash = findGitBash, spawn = spawnSync, env = process.env } = {},
) {
  if (!resolveGitBash()) {
    console.error(
      "Git for Windows Bash is required for native Tauri builds. Install Git for Windows and ensure its Bash is available.",
    );
    return 1;
  }

  const architecture = detectWindowsArchitecture(spawn, env);
  if (!architecture) {
    return 1;
  }

  const batchPath = path.join(repoRoot, "scripts", "build-native-windows.cmd");
  const result = spawn(
    env.ComSpec || "cmd.exe",
    ["/d", "/s", "/c", `call "${batchPath}" ${architecture} tauri`],
    {
      cwd: repoRoot,
      env: { ...env, [windowsArgumentsVariable]: JSON.stringify(args) },
      stdio: "inherit",
      windowsHide: true,
      windowsVerbatimArguments: true,
    },
  );
  if (result.error) {
    console.error(
      `Could not initialize the Visual Studio environment for Tauri: ${result.error.message}`,
    );
    return 1;
  }

  return result.status ?? 1;
}

/**
 * @param {string[]} args
 * @param {TauriDependencies} [dependencies]
 */
export function runTauri(
  args,
  {
    platform = process.platform,
    resolveGitBash = findGitBash,
    resolveLinuxSessionBusAddress:
      resolveSessionBusAddress = resolveLinuxSessionBusAddress,
    spawn = spawnSync,
    env = process.env,
  } = {},
) {
  if (platform === "win32") {
    if (env[windowsEnvironmentMarker] === "1") {
      return runTauriWithGitBash(args, {
        resolveGitBash,
        spawn,
        env,
        stripBootstrapEnvironment: true,
      });
    }

    return runTauriWithWindowsEnvironment(args, {
      resolveGitBash,
      spawn,
      env,
    });
  }

  const childEnv = { ...env };
  if (platform === "linux" && env.DBUS_SESSION_BUS_ADDRESS?.startsWith("autolaunch:")) {
    let sessionBusAddress;
    let discoveryFailed = false;
    try {
      sessionBusAddress = resolveSessionBusAddress(env);
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      discoveryFailed = true;
      console.warn(
        `Could not resolve the desktop D-Bus session address: ${details}. Credential listing may fail in the launched app.`,
      );
    }
    if (sessionBusAddress) {
      childEnv.DBUS_SESSION_BUS_ADDRESS = sessionBusAddress;
    } else if (!discoveryFailed) {
      console.warn(
        "Could not resolve the desktop D-Bus session address; credential listing may fail in the launched app.",
      );
    }
  }

  return runTauriWithGitBash(args, {
    resolveGitBash: () => "bash",
    spawn,
    env: childEnv,
  });
}

function readWindowsTauriArguments() {
  try {
    const parsed = JSON.parse(process.env[windowsArgumentsVariable] || "");
    if (
      Array.isArray(parsed) &&
      parsed.every((argument) => typeof argument === "string")
    ) {
      return parsed;
    }
  } catch (error) {
    console.error(
      `Could not read Tauri arguments from the Windows build launcher: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }

  console.error("The Windows build launcher supplied invalid Tauri arguments.");
  return undefined;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (
    process.argv[2] === "--run-with-msvc-env" &&
    process.env[windowsEnvironmentMarker] === "1"
  ) {
    const args = readWindowsTauriArguments();
    process.exitCode = args
      ? runTauriWithGitBash(args, {
          resolveGitBash: () => process.env.EPIKRISE_GIT_BASH_EXE || findGitBash(),
          stripBootstrapEnvironment: true,
        })
      : 1;
  } else {
    process.exitCode = runTauri(process.argv.slice(2));
  }
}
