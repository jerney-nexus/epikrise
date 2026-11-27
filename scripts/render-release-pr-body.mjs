import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const releaseVersionPlaceholder = "{{RELEASE_VERSION}}";
const storeReleaseNotesPlaceholder = "{{STORE_RELEASE_NOTES_CHECKLIST}}";

/**
 * @param {{ template: string, version: string, storeReleaseNotesChecklist: string }} input
 * @returns {string}
 */
export function renderReleasePullRequestBody({
  template,
  version,
  storeReleaseNotesChecklist,
}) {
  if (!/^\d{4}\.\d{1,2}\.\d+$/.test(version) || version !== version.trim()) {
    throw new Error("Release PR version must use YYYY.M.MICRO format.");
  }

  if (
    (template.match(/\{\{RELEASE_VERSION\}\}/g) ?? []).length !== 1 ||
    (template.match(/\{\{STORE_RELEASE_NOTES_CHECKLIST\}\}/g) ?? []).length !== 1
  ) {
    throw new Error(
      "Release PR template must contain one version and one release-notes placeholder.",
    );
  }

  if (!storeReleaseNotesChecklist.startsWith("## Store listing release notes")) {
    throw new Error("Release notes checklist is missing its expected heading.");
  }

  return template
    .replace(releaseVersionPlaceholder, () => version)
    .replace(storeReleaseNotesPlaceholder, () => storeReleaseNotesChecklist);
}

/** @param {string[]} args */
async function writeRenderedBody(args) {
  const [templatePath, outputPath, version, checklistPath, ...extraArgs] = args;
  if (
    !templatePath ||
    !outputPath ||
    !version ||
    !checklistPath ||
    extraArgs.length > 0
  ) {
    throw new Error(
      "Usage: node scripts/render-release-pr-body.mjs <template> <output> <version> <checklist>",
    );
  }

  const [template, storeReleaseNotesChecklist] = await Promise.all([
    readFile(templatePath, "utf8"),
    readFile(checklistPath, "utf8"),
  ]);
  await writeFile(
    outputPath,
    renderReleasePullRequestBody({
      template,
      version,
      storeReleaseNotesChecklist,
    }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await writeRenderedBody(process.argv.slice(2));
}
