import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

/**
 * @typedef {{
 *   source: { commit: string, archive_sha256: string },
 *   cache: { key: string, restored: boolean },
 *   tool_versions: Record<string, string>
 * }} BuildProvenance
 */

async function captureBuildToolVersions() {
  /** @type {Record<string, string>} */
  const versions = {};
  /** @type {Array<[string, string, string[]]>} */
  const commands = [
    ["rustc", "rustc", ["--version"]],
    ["cargo", "cargo", ["--version"]],
    ["node", "node", ["--version"]],
    [
      "pnpm",
      process.platform === "win32" ? "cmd.exe" : "pnpm",
      process.platform === "win32"
        ? ["/d", "/s", "/c", "pnpm --version"]
        : ["--version"],
    ],
    [
      "tauri_cli",
      process.platform === "win32" ? "cmd.exe" : "pnpm",
      process.platform === "win32"
        ? ["/d", "/s", "/c", "pnpm exec tauri --version"]
        : ["exec", "tauri", "--version"],
    ],
  ];
  for (const [name, command, args] of commands) {
    const { stdout, stderr } = await execFile(command, args);
    const version = `${stdout}${stderr}`.trim();
    if (!version) throw new Error(`Could not capture ${name} version.`);
    versions[name] = version;
  }
  return versions;
}

/**
 * @param {{ commit: string, sourceArchiveSha256: string, cacheKey: string, cacheRestored: boolean }} options
 * @returns {Promise<BuildProvenance>}
 */
export async function createBuildProvenance({
  commit,
  sourceArchiveSha256,
  cacheKey,
  cacheRestored,
}) {
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error("Build provenance commit must be a full Git SHA.");
  }
  if (!/^[0-9a-f]{64}$/.test(sourceArchiveSha256)) {
    throw new Error("Source archive SHA-256 is invalid.");
  }
  if (!cacheKey.trim()) throw new Error("Native cache key is required.");
  if (typeof cacheRestored !== "boolean") {
    throw new Error("Native cache restore status is invalid.");
  }

  return {
    source: {
      commit,
      archive_sha256: sourceArchiveSha256,
    },
    cache: {
      key: cacheKey,
      restored: cacheRestored,
    },
    tool_versions: await captureBuildToolVersions(),
  };
}

/**
 * @param {unknown} value
 * @param {string} commit
 */
export function assertBuildProvenance(value, commit) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Build provenance is missing.");
  }
  const provenance = /** @type {BuildProvenance} */ (value);
  if (
    provenance.source?.commit !== commit ||
    !/^[0-9a-f]{64}$/.test(provenance.source.archive_sha256)
  ) {
    throw new Error("Source evidence is invalid.");
  }
  if (
    typeof provenance.cache?.key !== "string" ||
    !provenance.cache.key.trim() ||
    typeof provenance.cache.restored !== "boolean"
  ) {
    throw new Error("Cache evidence is invalid.");
  }
  if (
    typeof provenance.tool_versions !== "object" ||
    provenance.tool_versions === null ||
    !["rustc", "cargo", "node", "pnpm", "tauri_cli"].every(
      (name) =>
        typeof provenance.tool_versions[name] === "string" &&
        provenance.tool_versions[name].trim().length > 0,
    )
  ) {
    throw new Error("Build tool version evidence is invalid.");
  }
}
