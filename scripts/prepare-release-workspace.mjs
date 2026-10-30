import { createHash } from "node:crypto";
import { spawn, execFile as execFileCallback } from "node:child_process";
import { lstat, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prepareReleaseBuildInputs } from "./prepare-release.mjs";

const execFile = promisify(execFileCallback);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** @param {string} commit */
async function hashGitArchive(commit) {
  const hash = createHash("sha256");
  const archive = spawn("git", ["archive", "--format=tar", commit], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const exit = new Promise((resolve, reject) => {
    archive.once("error", reject);
    archive.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `git archive failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}.`,
          ),
        );
      }
    });
  });

  const hashing = (async () => {
    for await (const chunk of archive.stdout) {
      hash.update(chunk);
    }
  })();
  await Promise.all([hashing, exit]);
  return hash.digest("hex");
}

/** @param {string} buildRoot */
async function assertWorkspaceDoesNotExist(buildRoot) {
  try {
    await lstat(buildRoot);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error(`Release workspace already exists: ${buildRoot}.`);
}

/** @param {string} commit @param {string} buildRoot */
export async function prepareReleaseWorkspace(commit, buildRoot) {
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error("Release commit must be a full lowercase Git SHA.");
  }

  const resolvedBuildRoot = path.resolve(buildRoot);
  if (resolvedBuildRoot === repoRoot) {
    throw new Error("Release workspace must be separate from the source checkout.");
  }
  await assertWorkspaceDoesNotExist(resolvedBuildRoot);

  const sourceArchiveSha256 = await hashGitArchive(commit);
  await execFile("git", ["worktree", "add", "--detach", resolvedBuildRoot, commit], {
    cwd: repoRoot,
    maxBuffer: 10 * 1024 * 1024,
  });

  try {
    await prepareReleaseBuildInputs(resolvedBuildRoot);
    const { stdout } = await execFile(
      "git",
      ["-C", resolvedBuildRoot, "rev-parse", "HEAD"],
      { cwd: repoRoot, maxBuffer: 10 * 1024 * 1024 },
    );
    if (stdout.trim() !== commit) {
      throw new Error("Release workspace does not match the requested commit.");
    }

    const gitMarker = path.join(resolvedBuildRoot, ".git");
    if (!(await lstat(gitMarker)).isFile()) {
      throw new Error("Release workspace has an unexpected Git metadata layout.");
    }
    await unlink(gitMarker);
  } catch (error) {
    try {
      await execFile("git", ["worktree", "remove", "--force", resolvedBuildRoot], {
        cwd: repoRoot,
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (cleanupError) {
      const preparationMessage = error instanceof Error ? error.message : String(error);
      const cleanupMessage =
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      throw new AggregateError(
        [error, cleanupError],
        `Release workspace preparation failed: ${preparationMessage}. Cleanup also failed: ${cleanupMessage}.`,
        { cause: error },
      );
    }
    throw error;
  }

  return sourceArchiveSha256;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const [commit, buildRoot, ...unexpectedArgs] = process.argv.slice(2);
  if (!commit || !buildRoot || unexpectedArgs.length > 0) {
    process.stderr.write(
      "Usage: node scripts/prepare-release-workspace.mjs <commit-sha> <workspace-path>\n",
    );
    process.exitCode = 2;
  } else {
    prepareReleaseWorkspace(commit, buildRoot)
      .then((sourceArchiveSha256) => {
        process.stdout.write(`${sourceArchiveSha256}\n`);
      })
      .catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
      });
  }
}
