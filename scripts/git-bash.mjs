import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/** @param {string} executable */
function isGitBash(executable) {
  const result = spawnSync(executable, ["-c", "uname -s"], {
    encoding: "utf8",
    windowsHide: true,
  });
  return (
    !result.error && result.status === 0 && /^(MINGW|MSYS)/.test(result.stdout.trim())
  );
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {(path: string) => boolean} [exists]
 * @param {(executable: string) => boolean} [verify]
 */
export function findGitBash(
  env = process.env,
  exists = existsSync,
  verify = isGitBash,
) {
  const gitRoots = [env.ProgramFiles, env["ProgramFiles(x86)"]]
    .filter((directory) => typeof directory === "string")
    .map((directory) => path.win32.join(directory, "Git"));
  const gitCandidates = gitRoots.flatMap((directory) => [
    path.win32.join(directory, "bin", "bash.exe"),
    path.win32.join(directory, "usr", "bin", "bash.exe"),
  ]);
  const pathCandidates = (env.PATH ?? "")
    .split(path.win32.delimiter)
    .flatMap((directory) => [
      path.win32.join(directory, "bash.exe"),
      path.win32.join(directory, "bash"),
    ]);

  return [...gitCandidates, ...pathCandidates].find(
    (candidate) => exists(candidate) && verify(candidate),
  );
}
