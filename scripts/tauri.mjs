import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findGitBash } from "./git-bash.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repoRoot, "scripts", "tauri.sh");

const bash = process.platform === "win32" ? findGitBash() : "bash";
if (!bash) {
  console.error(
    "Git for Windows Bash is required for native Tauri builds. Install Git for Windows and ensure its Bash is available.",
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
