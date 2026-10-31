import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { validateCalverVersion } from "./prepare-release.mjs";

const execFile = promisify(execFileCallback);
const workflowFile = "release-preparation.yml";
const workflowRef = "main";
const repository = "jerney-nexus/epikrise";

/** @param {string} [version] */
export function buildReleasePreparationWorkflowArgs(version = "") {
  const args = [
    "workflow",
    "run",
    workflowFile,
    "--repo",
    repository,
    "--ref",
    workflowRef,
  ];
  if (version) {
    args.push("-f", `version=${validateCalverVersion(version)}`);
  }
  return args;
}

/**
 * @param {string} [version]
 * @param {(file: string, args: string[]) => Promise<{ stdout: string }>} [run]
 */
export async function dispatchReleasePreparation(
  version = "",
  run = (file, args) => execFile(file, args, { maxBuffer: 1024 * 1024 }),
) {
  const args = buildReleasePreparationWorkflowArgs(version);
  try {
    await run("gh", args);
  } catch (error) {
    const failure =
      /** @type {{ code?: string, stderr?: string, message?: string } | null | undefined} */ (
        error
      );
    if (failure?.code === "ENOENT") {
      throw new Error(
        "GitHub CLI (gh) is not installed or not on PATH. Install it from https://cli.github.com and run `gh auth login`.",
        { cause: error },
      );
    }
    const detail = String(failure?.stderr || failure?.message || "").trim();
    throw new Error(
      `Could not dispatch the release preparation workflow. Check that gh is authenticated (gh auth status) and has access to this repository.\n${detail}`,
      { cause: error },
    );
  }
  return args;
}

async function prepareReleaseWorkflow() {
  const version = process.argv[2] ?? "";
  await dispatchReleasePreparation(version);
  const versionText = version
    ? ` for version ${version}`
    : " for the next CalVer version";
  process.stdout.write(
    `Dispatched the Release preparation workflow${versionText} on ${workflowRef}.\n` +
      `Watch the run: gh run list --repo=${repository} --workflow=${workflowFile} --limit 3\n` +
      "The workflow opens a release pull request when it finishes.\n" +
      `Find it after the run completes: gh pr list --repo=${repository} --state=open --search "head:release/"\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  prepareReleaseWorkflow().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
