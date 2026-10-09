import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repoRoot, "scripts", "tauri.sh");

function findBash() {
  if (process.platform !== "win32") return "bash";

  const pathCandidates = (process.env.PATH ?? "")
    .split(path.delimiter)
    .flatMap((directory) => [
      path.join(directory, "bash.exe"),
      path.join(directory, "bash"),
    ]);
  const gitRoots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]
    .filter(Boolean)
    .map((directory) => path.join(directory, "Git"));
  const gitCandidates = gitRoots.flatMap((directory) => [
    path.join(directory, "bin", "bash.exe"),
    path.join(directory, "usr", "bin", "bash.exe"),
  ]);
  return [...pathCandidates, ...gitCandidates].find(existsSync);
}

const bash = findBash();
if (!bash) {
  console.error(
    "Git for Windows Bash is required for native Tauri builds. Install Git for Windows or add bash.exe to PATH.",
  );
  process.exit(1);
}

const result = spawnSync(bash, [scriptPath, ...process.argv.slice(2)], {
  cwd: repoRoot,
  env: process.env,
  stdio: "inherit",
});
if (result.error) {
  console.error(`Could not start the Tauri build workflow: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
