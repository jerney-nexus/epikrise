import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findGitBash } from "./git-bash.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repoRoot, "scripts", "tauri.sh");
const windowsEnvironmentMarker = "EPIKRISE_NATIVE_WINDOWS_ENV_INITIALIZED";
const windowsArgumentsVariable = "EPIKRISE_TAURI_ARGS_JSON";

/**
 * @typedef {{ status: number | null, error?: Error, stdout?: string | Buffer }} SpawnResult
 * @typedef {(command: string, args: string[], options: import("node:child_process").SpawnSyncOptions) => SpawnResult} Spawn
 * @typedef {{
 *   platform?: string,
 *   resolveGitBash?: () => string | undefined,
 *   spawn?: Spawn,
 *   env?: NodeJS.ProcessEnv
 * }} TauriDependencies
 */

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
 */
function detectWindowsArchitecture(spawn) {
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
  if (result.error || result.status !== 0) {
    console.error(
      `Could not determine the Windows host architecture${result.error ? `: ${result.error.message}` : "."}`,
    );
    return undefined;
  }

  const architecture =
    typeof result.stdout === "string"
      ? result.stdout.trim().toLowerCase()
      : result.stdout?.toString("utf8").trim().toLowerCase();
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

  const architecture = detectWindowsArchitecture(spawn);
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

  return runTauriWithGitBash(args, { resolveGitBash: () => "bash", spawn, env });
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
