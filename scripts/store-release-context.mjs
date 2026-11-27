#!/usr/bin/env node
// Carries the release package identity from Store submission to metadata sync.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { deriveReleaseVersions } from "./store-version.mjs";

const RELEASE_TAG = /^v(\d{4}\.(?:[1-9]|1[0-2])\.(?:0|[1-9]\d*))$/;
const RELEASE_SHA = /^[0-9a-f]{40}$/;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {string} releaseTag @param {string} releaseSha */
export function createStoreReleaseContext(releaseTag, releaseSha) {
  const match = RELEASE_TAG.exec(releaseTag);
  if (!match) {
    throw new Error(`Invalid Store release tag: ${releaseTag}.`);
  }
  if (!RELEASE_SHA.test(releaseSha)) {
    throw new Error("The Store release commit must be a full lowercase SHA.");
  }
  return {
    releaseSha,
    releaseTag,
    packageVersion: deriveReleaseVersions(match[1]).msixIdentityVersion,
  };
}

/** @param {unknown} value */
export function validateStoreReleaseContext(value) {
  if (!isRecord(value)) {
    throw new Error("The Store release context is not an object.");
  }
  const expected = createStoreReleaseContext(
    typeof value.releaseTag === "string" ? value.releaseTag : "",
    typeof value.releaseSha === "string" ? value.releaseSha : "",
  );
  if (value.packageVersion !== expected.packageVersion) {
    throw new Error(
      "The Store release context package version does not match its tag.",
    );
  }
  return expected;
}

/**
 * @param {{ ref: string, refName: string, sha: string, releaseTag: string }} dispatch
 * @param {{ getRelease: (tag: string) => unknown, getTagSha: (tag: string) => string }} github
 */
export function resolveManualStoreRelease(dispatch, github) {
  if (dispatch.ref.startsWith("refs/tags/")) {
    if (
      dispatch.ref !== `refs/tags/${dispatch.refName}` ||
      (dispatch.releaseTag && dispatch.releaseTag !== dispatch.refName)
    ) {
      throw new Error("The release tag input must match the dispatched tag.");
    }
    return createStoreReleaseContext(dispatch.refName, dispatch.sha);
  }
  if (dispatch.ref !== "refs/heads/main") {
    throw new Error("Manual Store metadata sync must use main or a release tag.");
  }

  // Validate before passing the tag to GitHub CLI or embedding it in an API path.
  createStoreReleaseContext(dispatch.releaseTag, dispatch.sha);
  const release = github.getRelease(dispatch.releaseTag);
  if (
    !isRecord(release) ||
    release.tagName !== dispatch.releaseTag ||
    release.isDraft !== false ||
    release.isPrerelease !== false
  ) {
    throw new Error(
      "The selected tag must have a published, non-prerelease GitHub release.",
    );
  }
  return createStoreReleaseContext(
    dispatch.releaseTag,
    github.getTagSha(dispatch.releaseTag),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === "create" && args.length === 3) {
      const context = createStoreReleaseContext(args[0], args[1]);
      writeFileSync(args[2], `${JSON.stringify(context)}\n`);
    } else if (command === "resolve-manual" && args.length === 6) {
      const [ref, refName, sha, releaseTag, repository, output] = args;
      const context = resolveManualStoreRelease(
        { ref, refName, sha, releaseTag },
        {
          getRelease: (tag) =>
            JSON.parse(
              execFileSync(
                "gh",
                [
                  "release",
                  "view",
                  tag,
                  "--repo",
                  repository,
                  "--json",
                  "tagName,isDraft,isPrerelease",
                ],
                { encoding: "utf8" },
              ),
            ),
          getTagSha: (tag) =>
            execFileSync(
              "gh",
              ["api", `repos/${repository}/commits/refs/tags/${tag}`, "--jq", ".sha"],
              {
                encoding: "utf8",
              },
            ).trim(),
        },
      );
      writeFileSync(output, `${JSON.stringify(context)}\n`);
    } else if (command === "read" && args.length === 1) {
      const context = validateStoreReleaseContext(
        JSON.parse(readFileSync(args[0], "utf8")),
      );
      process.stdout.write(
        `sha=${context.releaseSha}\npackage_version=${context.packageVersion}\n`,
      );
    } else {
      throw new Error(
        "usage: store-release-context.mjs create <tag> <sha> <output> | resolve-manual <ref> <ref-name> <sha> <tag> <repo> <output> | read <context.json>",
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`store-release-context: ${message}\n`);
    process.exit(1);
  }
}
