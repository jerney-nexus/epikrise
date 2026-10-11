import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findGitBash } from "./git-bash.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repoRoot, "scripts", "tauri.sh");

/**
 * @typedef {{ status: number | null, error?: Error }} SpawnResult
 * @typedef {(command: string, args: string[], options: import("node:child_process").SpawnSyncOptions) => SpawnResult} Spawn
 */

/**
 * @param {string[]} args
 * @param {{ platform?: string, resolveGitBash?: () => string | null, spawn?: Spawn }} [dependencies]
 */
export function runTauri(
  args,
  { platform = process.platform, resolveGitBash = findGitBash, spawn = spawnSync } = {},
) {
  const bash = platform === "win32" ? resolveGitBash() : "bash";
  if (!bash) {
    console.error(
      "Git for Windows Bash is required for native Tauri builds. Install Git for Windows and ensure its Bash is available.",
    );
    return 1;
  }

  const result = spawn(bash, [scriptPath, ...args], {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`Could not start the Tauri build workflow: ${result.error.message}`);
    return 1;
  }

  return result.status ?? 1;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = runTauri(process.argv.slice(2));
}
