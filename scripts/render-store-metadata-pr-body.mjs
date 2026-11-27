import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

/** @param {{ template: string, runId: string }} input @returns {string} */
export function renderStoreMetadataPullRequestBody({ template, runId }) {
  if (!/^[0-9]+$/.test(runId) || runId !== runId.trim()) {
    throw new Error("Store metadata workflow run ID must be numeric.");
  }

  if ((template.match(/\{\{RUN_ID\}\}/g) ?? []).length !== 2) {
    throw new Error(
      "Store metadata PR template must contain exactly two RUN_ID placeholders.",
    );
  }

  return template.replace(/\{\{RUN_ID\}\}/g, () => runId);
}

/** @param {string[]} args */
async function writeRenderedBody(args) {
  const [templatePath, outputPath, runId, ...extraArgs] = args;
  if (!templatePath || !outputPath || !runId || extraArgs.length > 0) {
    throw new Error(
      "Usage: node scripts/render-store-metadata-pr-body.mjs <template> <output> <run-id>",
    );
  }

  const template = await readFile(templatePath, "utf8");
  await writeFile(outputPath, renderStoreMetadataPullRequestBody({ template, runId }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await writeRenderedBody(process.argv.slice(2));
}
