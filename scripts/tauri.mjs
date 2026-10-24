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
 *   isSocketPath?: (filePath: string) => boolean,
 *   isAbstractSocketName?: (socketName: string) => boolean
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

/**
 * @param {string} procContents
 * @param {string} socketName
 */
function hasListeningUnixSocket(procContents, socketName) {
  return procContents.split("\n").some((line) => {
    const entry = line.match(/^\s*\S+\s+\S+\s+\S+\s+(\S+)\s+\S+\s+\S+\s+\S+ (.*)$/);
    if (!entry || (Number.parseInt(entry[1], 16) & 0x00010000) === 0) return false;
    return entry[2] === socketName;
  });
}

/**
 * @param {string} socketName
 * @param {(filePath: string) => string} readFile
 */
function isListeningUnixSocket(socketName, readFile) {
  const contents = readOptionalFile("/proc/net/unix", readFile);
  return contents ? hasListeningUnixSocket(contents, socketName) : false;
}

/**
 * @param {string} filePath
 * @param {(filePath: string) => string} readFile
 */
function isUnixSocket(filePath, readFile) {
  try {
    return statSync(filePath).isSocket() && isListeningUnixSocket(filePath, readFile);
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
    isSocketPath = (filePath) => isUnixSocket(filePath, readFile),
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
  if (!address || address.startsWith("autolaunch:") || address.includes("\0")) {
    return undefined;
  }
  let hasLiveUnixSocket = false;
  for (const entry of address.split(";")) {
    const separator = entry.indexOf(":");
    if (separator <= 0) return undefined;
    const transport = entry.slice(0, separator);
    if (!/^[a-z0-9_-]+$/i.test(transport)) return undefined;

    const parameters = new Map();
    const parameterSource = entry.slice(separator + 1);
    if (!parameterSource) return undefined;
    for (const parameter of parameterSource.split(",")) {
      const equals = parameter.indexOf("=");
      if (equals <= 0) return undefined;
      const key = parameter.slice(0, equals);
      const value = parameter.slice(equals + 1);
      if (
        !/^[a-z0-9_-]+$/i.test(key) ||
        parameters.has(key) ||
        /%(?![\da-f]{2})/i.test(value)
      ) {
        return undefined;
      }
      if (key === "guid" && !/^[\da-f]{32}$/i.test(value)) return undefined;
      parameters.set(key, value);
    }

    if (transport !== "unix") continue;
    const socketType = parameters.has("path")
      ? "path"
      : parameters.has("abstract")
        ? "abstract"
        : undefined;
    if (
      !socketType ||
      (socketType === "path" && parameters.has("abstract")) ||
      (socketType === "abstract" && parameters.has("path"))
    ) {
      continue;
    }

    let socketName;
    try {
      socketName = decodeURIComponent(parameters.get(socketType));
    } catch (error) {
      if (error instanceof URIError) return undefined;
      throw error;
    }
    if (socketName.includes("\0")) return undefined;
    hasLiveUnixSocket ||=
      socketType === "path"
        ? isSocketPath(socketName)
        : isListeningUnixSocket(`@${socketName}`, readFile);
  }
  if (!hasLiveUnixSocket) return undefined;

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
  let architecture = (env.PROCESSOR_ARCHITEW6432 || "").trim().toLowerCase();

  if (!architecture) {
    const result = spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        path.join(repoRoot, "scripts/detect-windows-os-architecture.ps1"),
      ],
      { encoding: "utf8", windowsHide: true },
    );
    if (result.error || result.status !== 0) {
      console.error(
        `Could not determine the Windows host architecture${result.error ? `: ${result.error.message}` : "."}`,
      );
      return undefined;
    }
    architecture =
      typeof result.stdout === "string"
        ? result.stdout.trim().toLowerCase()
        : result.stdout?.toString("utf8").trim().toLowerCase() || "";
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
      console.error(`Unsupported Windows host architecture: ${architecture}.`);
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
