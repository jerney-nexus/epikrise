import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import TOML from "@iarna/toml";
import { describe, expect, it } from "vitest";
import {
  assertStoreVersionAdvances,
  createReleasedChangelog,
  deriveReleaseVersions,
  nextCalverVersion,
  prepareReleaseBuildInputs,
  releaseVersionFromProtocolVersion,
  validateCalverVersion,
} from "../scripts/prepare-release.mjs";
import {
  assertDispatchPreconditions,
  assertSuccessfulJobs,
  desktopTargets,
  selectMatchingRun,
  stagePackages,
  verifyArtifactSet,
} from "../scripts/desktop-builds.mjs";
import {
  assertRecoverableReleaseDraft,
  createLatestManifest,
  releaseTargets,
  shouldPromoteLatest,
  stageReleaseArtifacts,
  validateReleaseTag,
  verifyUploadedReleaseAssets,
} from "../scripts/release-artifacts.mjs";

const execFile = promisify(execFileCallback);
const repoRoot = fileURLToPath(new URL("../", import.meta.url));

const windowsOcrTargets = [
  {
    target: "x86_64-pc-windows-msvc",
    archive: "pdfium-win-x64.tgz",
    checksum: "739a57d597d864297909cc40a2411eba728490c76a0fa25e3ea299c7f6b07020",
  },
  {
    target: "aarch64-pc-windows-msvc",
    archive: "pdfium-win-arm64.tgz",
    checksum: "5d04b6d0281e78613ef836dea2e0fefe6831f3ae92b3573e8fdf55330de67d3d",
  },
];

describe("CalVer release versions", () => {
  it("increments the patch within the current month", () => {
    expect(nextCalverVersion("2026.10.2", new Date("2026-10-01T12:00:00Z"))).toBe(
      "2026.10.3",
    );
  });

  it("starts a new month at patch zero", () => {
    expect(nextCalverVersion("2026.09.4", new Date("2026-10-01T12:00:00Z"))).toBe(
      "2026.10.0",
    );
  });

  it("rejects invalid dates and versions earlier than the project version", () => {
    expect(() => validateCalverVersion("2026.13.0")).toThrow();
    expect(() =>
      nextCalverVersion("2026.10.0", new Date("2026-09-30T12:00:00Z")),
    ).toThrow();
  });

  it.each([
    ["2026.01.0", "2026.1.0", "26.1.0", "2026.1.0.0"],
    ["2026.09.4", "2026.9.4", "26.9.4", "2026.9.4.0"],
    ["2026.10.0", "2026.10.0", "26.10.0", "2026.10.0.0"],
    ["2027.01.0", "2027.1.0", "27.1.0", "2027.1.0.0"],
  ])(
    "derives bounded protocol/package versions from %s without changing its tag",
    (releaseVersion, protocolVersion, msiVersion, msixVersion) => {
      expect(deriveReleaseVersions(releaseVersion)).toEqual({
        releaseVersion,
        updateProtocolVersion: protocolVersion,
        msiProductVersion: msiVersion,
        msixIdentityVersion: msixVersion,
      });
      expect(releaseVersionFromProtocolVersion(protocolVersion)).toBe(releaseVersion);
    },
  );

  it("rejects unrepresentable installer versions and Store downgrades", () => {
    expect(() => deriveReleaseVersions("1999.12.0")).toThrow("MSI");
    expect(() => deriveReleaseVersions("2256.01.0")).toThrow("MSI");
    expect(() => deriveReleaseVersions("2026.01.65536")).toThrow("65535");
    expect(() => releaseVersionFromProtocolVersion("2026.00.0")).toThrow();
    expect(() => releaseVersionFromProtocolVersion("2026.09.0")).toThrow();
    expect(() => releaseVersionFromProtocolVersion("0001.1.0")).toThrow();
    expect(() => releaseVersionFromProtocolVersion("2026.1.65536")).toThrow();
    expect(assertStoreVersionAdvances("2026.10.0", "2026.9.4.0")).toBe("2026.10.0.0");
    expect(() => assertStoreVersionAdvances("2026.09.4", "2026.9.4.0")).toThrow(
      "must be greater",
    );
    expect(() => assertStoreVersionAdvances("2026.10.0", "2026.9.65536.0")).toThrow(
      "Invalid published Store version",
    );
  });

  it.each([
    ["2026.01.0", "2026.1.0", "26.1.0"],
    ["2026.09.4", "2026.9.4", "26.9.4"],
  ])(
    "builds disposable Cargo and Tauri inputs with --locked for %s",
    async (releaseVersion, protocolVersion, msiVersion) => {
      const directory = await mkdtemp(path.join(tmpdir(), "epikrise-release-inputs-"));
      const tauriDirectory = path.join(directory, "src-tauri");
      const sourcePackage = JSON.parse(
        await readFile(path.join(repoRoot, "package.json"), "utf8"),
      );

      try {
        await expect(prepareReleaseBuildInputs(repoRoot)).rejects.toThrow(
          "disposable workspace",
        );
        await cp(
          path.join(repoRoot, "package.json"),
          path.join(directory, "package.json"),
        );
        await cp(path.join(repoRoot, "src-tauri"), tauriDirectory, {
          recursive: true,
          filter: (source) =>
            !["target", "gen", "WixTools"].some((excluded) =>
              source.split(path.sep).includes(excluded),
            ),
        });

        const packagePath = path.join(directory, "package.json");
        const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
        packageJson.version = releaseVersion;
        await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

        const cargoManifestPath = path.join(tauriDirectory, "Cargo.toml");
        const cargoManifest = (await readFile(cargoManifestPath, "utf8")).replaceAll(
          sourcePackage.version,
          releaseVersion,
        );
        await writeFile(cargoManifestPath, cargoManifest);
        const tauriConfigPath = path.join(tauriDirectory, "tauri.conf.json");
        const tauriConfig = JSON.parse(await readFile(tauriConfigPath, "utf8"));
        tauriConfig.version = releaseVersion;
        await writeFile(tauriConfigPath, `${JSON.stringify(tauriConfig, null, 2)}\n`);

        await expect(prepareReleaseBuildInputs(directory)).resolves.toMatchObject({
          releaseVersion,
          updateProtocolVersion: protocolVersion,
        });
        const normalizedCargo = TOML.parse(await readFile(cargoManifestPath, "utf8"));
        expect(normalizedCargo).toMatchObject({
          package: { version: protocolVersion },
          workspace: { package: { version: protocolVersion } },
        });
        const normalizedLock = TOML.parse(
          await readFile(path.join(tauriDirectory, "Cargo.lock"), "utf8"),
        );
        expect(normalizedLock.package).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: "epikrise", version: protocolVersion }),
            expect.objectContaining({
              name: "epikrise-core",
              version: protocolVersion,
            }),
            expect.objectContaining({
              name: "epikrise-ingest",
              version: protocolVersion,
            }),
            expect.objectContaining({ name: "epikrise-llm", version: protocolVersion }),
          ]),
        );
        expect(JSON.parse(await readFile(tauriConfigPath, "utf8"))).toMatchObject({
          version: protocolVersion,
          bundle: { windows: { wix: { version: msiVersion } } },
        });

        const { stdout: rustcInfo } = await execFile("rustc", ["-vV"]);
        const host = rustcInfo.match(/^host: (.+)$/m)?.[1];
        expect(host).toBeDefined();
        await execFile(
          "cargo",
          [
            "check",
            "--locked",
            "--offline",
            "--manifest-path",
            cargoManifestPath,
            "--package",
            "epikrise",
            "--lib",
          ],
          {
            cwd: directory,
            env: {
              ...process.env,
              CARGO_TARGET_DIR: path.join(repoRoot, "src-tauri/target", `host-${host}`),
            },
            maxBuffer: 10 * 1024 * 1024,
          },
        );

        expect(
          JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"))
            .version,
        ).toBe(sourcePackage.version);
        expect(
          await readFile(path.join(repoRoot, "src-tauri/Cargo.toml"), "utf8"),
        ).toContain(`version = "${sourcePackage.version}"`);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    300_000,
  );

  it("moves unreleased and generated notes into a dated release section", () => {
    const changelog = [
      "# Changelog",
      "",
      "## [Unreleased]",
      "",
      "### Added",
      "",
      "- Authored release note.",
      "",
      "[Unreleased]: https://github.com/jerney-nexus/epikrise/compare/HEAD",
      "",
    ].join("\n");
    const generatedNotes = [
      "## [2026.10.1] - 2026-10-01",
      "",
      "### Fixed",
      "",
      "- Generated release note.",
    ].join("\n");

    const result = createReleasedChangelog(
      changelog,
      generatedNotes,
      "2026.10.1",
      "2026.10.0",
    );

    expect(result).toMatch(/## \[2026\.10\.1\] - \d{4}-\d{2}-\d{2}/);
    expect(result).toContain("- Authored release note.");
    expect(result).toContain("- Generated release note.");
    expect(result).toContain(
      "[2026.10.1]: https://github.com/jerney-nexus/epikrise/compare/v2026.10.0...v2026.10.1",
    );
    expect(result).toContain(
      "[Unreleased]: https://github.com/jerney-nexus/epikrise/compare/v2026.10.1...HEAD",
    );
  });
});

describe("Windows cross-build versions", () => {
  it("uses the same available CRT version for setup and builds", async () => {
    const setupScript = await readFile(
      path.join(repoRoot, "scripts/windows-setup.sh"),
      "utf8",
    );
    const buildScript = await readFile(
      path.join(repoRoot, "scripts/build-windows.sh"),
      "utf8",
    );
    const setupSdkVersion = setupScript.match(/sdk_version="([^"]+)"/)?.[1];
    const setupCrtVersion = setupScript.match(/crt_version="([^"]+)"/)?.[1];

    expect(setupSdkVersion).toBe("10.0.26100");
    expect(setupCrtVersion).toBe("14.44.17.14");
    expect(buildScript).toContain(`sdk_version="${setupSdkVersion}"`);
    expect(buildScript).toContain(`crt_version="${setupCrtVersion}"`);
  });

  it("requires explicit license approval before entering the CI setup path", async () => {
    const setupScript = path.join(repoRoot, "scripts/windows-setup.sh");

    for (const approval of [undefined, "false", "yes"]) {
      await expect(
        execFile("bash", [setupScript, "--ci"], {
          env: {
            ...process.env,
            EPIKRISE_WINDOWS_SDK_LICENSE_APPROVED: approval,
          },
        }),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("EPIKRISE_WINDOWS_SDK_LICENSE_APPROVED"),
      });
    }
    await expect(
      execFile("bash", [setupScript, "--ci", "unexpected"], {
        env: {
          ...process.env,
          EPIKRISE_WINDOWS_SDK_LICENSE_APPROVED: "true",
        },
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Usage:"),
    });
  });
});

describe("Windows setup noninteractive behavior", () => {
  it("downloads only in approved CI mode and keeps local acceptance interactive", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "epikrise-windows-setup-"));
    const binDir = path.join(directory, "bin");
    const setupScript = path.join(directory, "windows-setup.sh");
    const headerPath = path.join(directory, "RestartManager.nsh");
    const cargoLog = path.join(directory, "cargo.log");
    const cacheRoot = path.join(directory, "cache");

    try {
      await mkdir(binDir);
      await writeFile(headerPath, "synthetic header");
      const source = await readFile(
        path.join(repoRoot, "scripts/windows-setup.sh"),
        "utf8",
      );
      await writeFile(
        setupScript,
        source.replace("/usr/share/nsis/Include/Win/RestartManager.nsh", headerPath),
      );
      await writeExecutable(
        path.join(binDir, "uname"),
        '#!/usr/bin/env bash\nif [[ "$1" == "-s" ]]; then printf "Linux\\n"; else printf "aarch64\\n"; fi\n',
      );
      await writeExecutable(
        path.join(binDir, "cargo"),
        '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$CARGO_LOG"\n',
      );
      for (const tool of [
        "rustup",
        "clang",
        "llvm-rc",
        "llvm-ar",
        "lld-link",
        "cmake",
        "ninja",
        "makensis",
      ]) {
        await writeExecutable(path.join(binDir, tool), "#!/usr/bin/env bash\nexit 0\n");
      }
      const env = {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
        XDG_CACHE_HOME: cacheRoot,
        CARGO_LOG: cargoLog,
        EPIKRISE_WINDOWS_SDK_LICENSE_APPROVED: "true",
      };

      await expect(execFile("bash", [setupScript], { env })).rejects.toMatchObject({
        stderr: expect.stringContaining("interactive terminal"),
      });
      expect(await readFile(cargoLog, "utf8")).not.toContain("cache xwin");

      const { stdout } = await execFile("bash", [setupScript, "--ci"], { env });
      expect(stdout).toContain("Windows cross-build tools are ready.");
      expect(stdout).not.toContain("Type ACCEPT");
      expect(await readFile(cargoLog, "utf8")).toContain(
        "cache xwin --xwin-version 17 --xwin-sdk-version 10.0.26100 --xwin-crt-version 14.44.17.14",
      );
      expect(
        await readFile(
          path.join(
            cacheRoot,
            "epikrise/windows/sdk-license-accepted-17-10.0.26100-14.44.17.14",
          ),
          "utf8",
        ),
      ).toBe("");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("six-target desktop build tooling", () => {
  const commit = "a".repeat(40);
  const requestId = "12345678-1234-4234-8234-123456789abc";

  it("requires a clean, pushed branch or tag containing the workflow", () => {
    const valid = {
      clean: true,
      branch: "development",
      tag: "",
      commit,
      workflowPresent: true,
      pushedCommit: commit,
    };
    expect(() => assertDispatchPreconditions(valid)).not.toThrow();
    expect(() => assertDispatchPreconditions({ ...valid, clean: false })).toThrow(
      "worktree must be clean",
    );
    expect(() => assertDispatchPreconditions({ ...valid, branch: "" })).toThrow(
      "pushed branch or tag",
    );
    expect(() =>
      assertDispatchPreconditions({ ...valid, workflowPresent: false }),
    ).toThrow("does not contain");
    expect(() =>
      assertDispatchPreconditions({ ...valid, pushedCommit: "b".repeat(40) }),
    ).toThrow("must be pushed");
    expect(() =>
      assertDispatchPreconditions({ ...valid, branch: "", tag: "v2026.10.0" }),
    ).not.toThrow();
    expect(() =>
      assertDispatchPreconditions({ ...valid, branch: "", tag: "" }),
    ).toThrow("pushed branch or tag");
  });

  it("selects only the unique manually dispatched run for its request and commit", () => {
    const title = `Desktop builds ${requestId} @ ${commit}`;
    const run = {
      databaseId: 42,
      displayTitle: title,
      headSha: commit,
      event: "workflow_dispatch",
    };
    expect(
      selectMatchingRun(
        [{ ...run, databaseId: 41, displayTitle: "older build" }, run],
        requestId,
        commit,
      ),
    ).toEqual(run);
    expect(selectMatchingRun([], requestId, commit)).toBeNull();
    expect(() =>
      selectMatchingRun([{ ...run, headSha: "b".repeat(40) }], requestId, commit),
    ).toThrow("different commit");
    expect(() => selectMatchingRun([run, run], requestId, commit)).toThrow(
      "More than one Actions run",
    );
    expect(() =>
      selectMatchingRun([{ ...run, event: "push" }], requestId, commit),
    ).toThrow("not manually dispatched");
  });

  it("requires all six target jobs to succeed", () => {
    const jobs = desktopTargets.map((target) => ({
      name: `Build ${target}`,
      conclusion: "success",
    }));
    expect(() => assertSuccessfulJobs(jobs)).not.toThrow();
    expect(() => assertSuccessfulJobs(jobs.slice(1))).toThrow("did not succeed");
    expect(() =>
      assertSuccessfulJobs(jobs.map((job) => ({ ...job, conclusion: "failure" }))),
    ).toThrow("did not succeed");
  });

  it("stages architecture-specific packages with a commit and checksum manifest", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "epikrise-desktop-stage-"));
    const bundleRoot = path.join(directory, "bundle");
    const stageRoot = path.join(directory, "stage");
    const target = desktopTargets[0];
    const packageContents = ["deb", "rpm", "AppImage"];

    try {
      await mkdir(bundleRoot, { recursive: true });
      for (const extension of packageContents) {
        await writeFile(
          path.join(bundleRoot, `epikrise.${extension}`),
          `synthetic ${extension}`,
        );
      }
      const manifest = await stagePackages({
        target,
        commit,
        requestId,
        bundleRoot,
        stageRoot,
      });

      expect(manifest).toMatchObject({
        schema_version: 1,
        request_id: requestId,
        commit,
        target,
        signed: false,
      });
      expect(manifest.files).toHaveLength(3);
      expect(manifest.files.map((file) => file.sha256).sort()).toEqual(
        packageContents
          .map((extension) =>
            createHash("sha256").update(`synthetic ${extension}`).digest("hex"),
          )
          .sort(),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects missing, stale, tampered, and unmanifested downloads", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "epikrise-desktop-download-"));
    const version = JSON.parse(
      await readFile(path.join(repoRoot, "package.json"), "utf8"),
    ).version;

    try {
      for (const target of desktopTargets) {
        const targetDirectory = path.join(directory, target);
        const filesDirectory = path.join(targetDirectory, "files");
        await mkdir(filesDirectory, { recursive: true });
        const extensions = target.includes("unknown-linux")
          ? ["deb", "rpm", "AppImage"]
          : target.includes("apple-darwin")
            ? ["dmg"]
            : ["exe"];
        const files = [];
        for (const extension of extensions) {
          const name = `${target}.${extension}`;
          const contents = `synthetic ${target} ${extension}`;
          const filePath = path.join(filesDirectory, name);
          await writeFile(filePath, contents);
          files.push({
            path: `files/${name}`,
            size_bytes: Buffer.byteLength(contents),
            sha256: createHash("sha256").update(contents).digest("hex"),
          });
        }
        await writeFile(
          path.join(targetDirectory, "manifest.json"),
          JSON.stringify({
            schema_version: 1,
            request_id: requestId,
            commit,
            target,
            version,
            signed: false,
            files,
          }),
        );
      }

      const expected = { requestId, commit, version };
      expect(await verifyArtifactSet(directory, expected)).toHaveLength(6);
      await expect(
        verifyArtifactSet(path.join(directory, "missing"), expected),
      ).rejects.toThrow();

      const firstManifestPath = path.join(
        directory,
        desktopTargets[0],
        "manifest.json",
      );
      const firstManifest: {
        files: Array<{ path: string }>;
        [key: string]: unknown;
      } = JSON.parse(await readFile(firstManifestPath, "utf8"));
      await writeFile(
        firstManifestPath,
        JSON.stringify({ ...firstManifest, commit: "b".repeat(40) }),
      );
      await expect(verifyArtifactSet(directory, expected)).rejects.toThrow(
        "commit SHA does not match",
      );
      await writeFile(firstManifestPath, JSON.stringify(firstManifest));

      const firstManifestFiles: Array<{ path: string }> = firstManifest.files;
      const incompleteManifest = {
        ...firstManifest,
        files: firstManifestFiles.filter((file) => !file.path.endsWith(".rpm")),
      };
      await writeFile(firstManifestPath, JSON.stringify(incompleteManifest));
      await expect(verifyArtifactSet(directory, expected)).rejects.toThrow(
        "missing the required .rpm",
      );
      await writeFile(firstManifestPath, JSON.stringify(firstManifest));

      const tamperedFile = path.join(
        directory,
        desktopTargets[0],
        "files",
        `${desktopTargets[0]}.deb`,
      );
      const originalContents = `synthetic ${desktopTargets[0]} deb`;
      await writeFile(tamperedFile, originalContents.replace("synthetic", "tamperedd"));
      await expect(verifyArtifactSet(directory, expected)).rejects.toThrow(
        "SHA-256 verification failed",
      );
      await writeFile(tamperedFile, originalContents);
      await writeFile(
        path.join(directory, desktopTargets[0], "files", "extra.txt"),
        "unlisted",
      );
      await expect(verifyArtifactSet(directory, expected)).rejects.toThrow(
        "not declared in its manifest",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps the workflow manual, read-only, and fixed to the six planned runners", async () => {
    const workflow = await readFile(
      path.join(repoRoot, ".github/workflows/desktop-builds.yml"),
      "utf8",
    );
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toMatch(/^\s+(push|pull_request):/m);
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("vars.EPIKRISE_WINDOWS_SDK_LICENSE_APPROVED");
    expect(workflow).toContain(
      "src-tauri/target/host-$host_target/$TARGET/release/bundle",
    );
    expect(workflow).not.toContain("~/.cache/epikrise/windows\n");
    expect(workflow).toContain("actions/upload-artifact@v7");
    expect(workflow).toContain("${{ runner.arch }}");
    expect(workflow).toContain("ubuntu-22.04-arm");
    expect(workflow).toContain("ubuntu-22.04");
    expect(workflow).toContain("macos-15-intel");
    expect(workflow).toContain("macos-15");
    for (const target of desktopTargets) expect(workflow).toContain(target);
  });
});

describe("signed release artifacts", () => {
  const targetSuffixes: Record<string, string[]> = {
    "x86_64-unknown-linux-gnu": [".deb", ".rpm", ".AppImage", ".AppImage.sig"],
    "aarch64-unknown-linux-gnu": [".deb", ".rpm", ".AppImage", ".AppImage.sig"],
    "x86_64-apple-darwin": [".dmg", ".app.tar.gz", ".app.tar.gz.sig"],
    "aarch64-apple-darwin": [".dmg", ".app.tar.gz", ".app.tar.gz.sig"],
    "x86_64-pc-windows-msvc": [".exe", ".exe.sig"],
    "aarch64-pc-windows-msvc": [".exe", ".exe.sig"],
  };
  const releaseCommit = "0123456789abcdef0123456789abcdef01234567";

  async function createOcrFixture(root: string, target: string) {
    const resourceRoot = path.join(root, "resources", "ocr");
    const binaryRoot = path.join(root, "binaries");
    const pdfiumName = target.includes("apple-darwin")
      ? "libpdfium.dylib"
      : target.includes("windows-msvc")
        ? "pdfium.dll"
        : "libpdfium.so";
    const tesseractName = target.includes("windows-msvc")
      ? `tesseract-${target}.exe`
      : `tesseract-${target}`;

    await mkdir(path.join(resourceRoot, "pdfium"), { recursive: true });
    await mkdir(path.join(resourceRoot, "tessdata"), { recursive: true });
    await mkdir(binaryRoot, { recursive: true });
    await writeFile(path.join(resourceRoot, "pdfium", pdfiumName), `pdfium-${target}`);
    await writeFile(
      path.join(resourceRoot, "tessdata", "deu.traineddata"),
      `deu-${target}`,
    );
    await writeFile(
      path.join(resourceRoot, "tessdata", "eng.traineddata"),
      `eng-${target}`,
    );
    await writeFile(path.join(binaryRoot, tesseractName), `tesseract-${target}`);
    return { resourceRoot, binaryRoot };
  }

  it("requires the padded tag to match the package and normalizes protocol SemVer", () => {
    expect(validateReleaseTag("v2026.09.4", "2026.09.4")).toEqual({
      tag: "v2026.09.4",
      releaseVersion: "2026.09.4",
      updateProtocolVersion: "2026.9.4",
    });
    expect(() => validateReleaseTag("v2026.9.4", "2026.09.4")).toThrow(
      "vYYYY.MM.PATCH",
    );
    expect(() => validateReleaseTag("v2026.09.4", "2026.09.3")).toThrow(
      "match package.json",
    );
  });

  it("promotes only releases that are not older than the current latest", () => {
    expect(shouldPromoteLatest("v2026.10.0", undefined)).toBe(true);
    expect(shouldPromoteLatest("v2026.10.0", "v2026.09.99")).toBe(true);
    expect(shouldPromoteLatest("v2027.01.0", "v2026.12.99")).toBe(true);
    expect(shouldPromoteLatest("v2026.09.4", "v2026.09.4")).toBe(true);
    expect(shouldPromoteLatest("v2026.09.3", "v2026.09.4")).toBe(false);
    expect(() => shouldPromoteLatest("v2026.09.4", "v2026.9.4")).toThrow(
      "not padded CalVer",
    );
  });

  it("recovers only drafts created for the same tag and commit", () => {
    const tag = "v2026.10.0";
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const release = {
      isDraft: true,
      tagName: tag,
      body: `<!-- epikrise-signed-release-commit:${commit} -->\nRelease notes`,
    };

    expect(() => assertRecoverableReleaseDraft(release, tag, commit)).not.toThrow();
    expect(() =>
      assertRecoverableReleaseDraft({ ...release, isDraft: false }, tag, commit),
    ).toThrow("Only an existing draft release can be recovered.");
    expect(() =>
      assertRecoverableReleaseDraft({ ...release, tagName: "v2026.09.4" }, tag, commit),
    ).toThrow("Existing draft tag does not match.");
    expect(() =>
      assertRecoverableReleaseDraft(
        { ...release, body: "<!-- epikrise-signed-release-commit:other -->" },
        tag,
        commit,
      ),
    ).toThrow("Existing draft was not created for this commit.");
  });

  it("keeps signed release publication separate from diagnostic builds", async () => {
    const releaseWorkflow = await readFile(
      path.join(repoRoot, ".github/workflows/signed-release.yml"),
      "utf8",
    );
    const diagnosticWorkflow = await readFile(
      path.join(repoRoot, ".github/workflows/desktop-builds.yml"),
      "utf8",
    );
    const qualityWorkflows = [
      "ui-tests.yml",
      "rust-tests.yml",
      "playwright-tests.yml",
      "security-audit.yml",
      "quality-checks.yml",
    ];
    const qualityWorkflow = await readFile(
      path.join(repoRoot, ".github/workflows/quality-checks.yml"),
      "utf8",
    );
    const cargoManifest = TOML.parse(
      await readFile(path.join(repoRoot, "src-tauri/Cargo.toml"), "utf8"),
    );
    const tauriConfig = JSON.parse(
      await readFile(path.join(repoRoot, "src-tauri/tauri.conf.json"), "utf8"),
    );
    const releaseTauriConfig = JSON.parse(
      await readFile(path.join(repoRoot, "src-tauri/tauri.release.conf.json"), "utf8"),
    );

    expect(releaseWorkflow).toContain('      - "v*"');
    expect(releaseWorkflow).toContain("ref: ${{ github.sha }}");
    expect(releaseWorkflow).toMatch(
      /build:\s+needs:\s+- validate\s+- verify-ui\s+- verify-rust\s+- verify-playwright\s+- verify-security\s+- verify-quality/,
    );
    expect(qualityWorkflow).toContain(
      "run: pnpm lint && pnpm format:check && pnpm build",
    );
    expect(qualityWorkflow).toMatch(
      /pull_request:\s+branches:\s+\[main, development\]/,
    );
    expect(qualityWorkflow).toMatch(/push:\s+branches:\s+\[main, development\]/);
    for (const workflow of qualityWorkflows) {
      const workflowSource = await readFile(
        path.join(repoRoot, ".github/workflows", workflow),
        "utf8",
      );
      expect(releaseWorkflow).toContain(`uses: ./.github/workflows/${workflow}`);
      expect(workflowSource).toContain("workflow_call:");
      expect(workflowSource).toContain("ref: ${{ github.sha }}");
      expect(workflowSource).toMatch(
        /pull_request:\s+branches:\s+\[main, development\]/,
      );
      expect(workflowSource).toMatch(/push:\s+branches:\s+\[main, development\]/);
    }
    expect(releaseWorkflow).toContain(
      "TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}",
    );
    expect(releaseWorkflow).toContain("environment: release");
    expect(releaseWorkflow).toContain("--bundles appimage");
    expect(releaseWorkflow).toContain("--bundles deb rpm");
    expect(releaseWorkflow).toContain('"features":[]');
    expect(releaseWorkflow).toMatch(/features":\[\]\}\}' \\\s*--bundles deb rpm/);
    expect(cargoManifest).toMatchObject({ features: { default: [] } });
    expect(tauriConfig.build.features ?? []).not.toContain("direct-release-updater");
    expect(releaseTauriConfig.plugins.updater.requireSignedVersion).toBe(true);
    expect(diagnosticWorkflow).not.toContain("tauri.release.conf.json");
    expect(diagnosticWorkflow).not.toContain("--features");
    expect(releaseWorkflow).toContain("EPIKRISE_WINDOWS_INSTALLER_FAMILY: nsis");
    expect(releaseWorkflow).toContain("--draft");
    expect(releaseWorkflow).toContain("validate-draft");
    expect(releaseWorkflow).toContain("--clobber");
    expect(releaseWorkflow).toContain("epikrise-signed-release-commit:");
    expect(releaseWorkflow).toContain("Verify staged OCR architectures");
    expect(releaseWorkflow).toMatch(
      /Verify staged OCR architectures[\s\S]*Stage and verify updater packages/,
    );
    expect(releaseWorkflow).toContain("--resource-root src-tauri/resources/ocr");
    expect(releaseWorkflow).toContain("--binary-root src-tauri/binaries");
    expect(releaseWorkflow).toContain("Install Minisign verifier");
    expect(releaseWorkflow).toContain("should-promote-latest");
    expect(releaseWorkflow).toContain(
      "gh release list --json tagName,isDraft --limit 1000",
    );
    expect(releaseWorkflow).toContain(
      "if (releases.some((release) => !release.isDraft))",
    );
    expect(releaseWorkflow).toContain(
      "Could not determine the latest published release.",
    );
    expect(releaseWorkflow).toContain("make_latest=");
    expect(releaseWorkflow).toContain("gh release download");
    expect(releaseWorkflow).toContain("verify-uploaded");
    expect(releaseWorkflow).toMatch(
      /verify-uploaded[\s\S]*should-promote-latest[\s\S]*gh api --method PATCH/,
    );
    expect(releaseWorkflow).toContain("group: updater-release");
    expect(releaseWorkflow).not.toContain("--draft=false --latest");
    expect(releaseWorkflow).toContain("gh api --method PATCH");
    expect(releaseWorkflow).toContain("contents: write");
    expect(diagnosticWorkflow).toContain("contents: read");
    expect(diagnosticWorkflow).not.toContain("TAURI_SIGNING_PRIVATE_KEY");
    expect(diagnosticWorkflow).not.toContain("gh release create");
  });

  it("requires a signing key before starting a Windows release build", async () => {
    const cacheRoot = await mkdtemp(path.join(tmpdir(), "epikrise-windows-release-"));
    const windowsCache = path.join(cacheRoot, "epikrise", "windows");

    try {
      await mkdir(windowsCache, { recursive: true });
      await writeFile(
        path.join(windowsCache, "sdk-license-accepted-17-10.0.26100-14.44.17.14"),
        "",
      );
      await expect(
        execFile("bash", ["scripts/build-windows.sh", "x64", "release"], {
          cwd: repoRoot,
          env: {
            ...process.env,
            XDG_CACHE_HOME: cacheRoot,
            EPIKRISE_WINDOWS_INSTALLER_FAMILY: "nsis",
            TAURI_SIGNING_PRIVATE_KEY: "",
            TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "",
          },
        }),
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("TAURI_SIGNING_PRIVATE_KEY is required"),
      });
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it.each([undefined, "both"])(
    "rejects missing or conflicting signed Windows installer-family selection: %s",
    async (family) => {
      const cacheRoot = await mkdtemp(path.join(tmpdir(), "epikrise-windows-family-"));
      const windowsCache = path.join(cacheRoot, "epikrise", "windows");
      const environment: NodeJS.ProcessEnv = {
        ...process.env,
        XDG_CACHE_HOME: cacheRoot,
        TAURI_SIGNING_PRIVATE_KEY: "synthetic-test-key",
        TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "",
      };

      if (family === undefined) {
        delete environment.EPIKRISE_WINDOWS_INSTALLER_FAMILY;
      } else {
        environment.EPIKRISE_WINDOWS_INSTALLER_FAMILY = family;
      }

      try {
        await mkdir(windowsCache, { recursive: true });
        await writeFile(
          path.join(windowsCache, "sdk-license-accepted-17-10.0.26100-14.44.17.14"),
          "",
        );
        await expect(
          execFile("bash", ["scripts/build-windows.sh", "x64", "release"], {
            cwd: repoRoot,
            env: environment,
          }),
        ).rejects.toMatchObject({
          code: 2,
          stderr: expect.stringContaining(
            "EPIKRISE_WINDOWS_INSTALLER_FAMILY must be set to nsis or msi",
          ),
        });
      } finally {
        await rm(cacheRoot, { recursive: true, force: true });
      }
    },
  );

  it("stages all platform packages and builds a signed static updater manifest", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "epikrise-signed-release-"));
    const artifactsRoot = path.join(directory, "artifacts");
    const pubDate = "2026-10-03T12:00:00.000Z";

    try {
      for (const target of releaseTargets) {
        const bundleRoot = path.join(directory, "bundles", target);
        await mkdir(bundleRoot, { recursive: true });
        for (const suffix of targetSuffixes[target]) {
          await writeFile(
            path.join(bundleRoot, `epikrise${suffix}`),
            suffix.endsWith(".sig") ? `signature-${target}` : `bundle-${target}`,
          );
        }
        const { resourceRoot, binaryRoot } = await createOcrFixture(directory, target);
        await stageReleaseArtifacts({
          target,
          bundleRoot,
          stageRoot: path.join(artifactsRoot, `release-${target}`),
          commit: releaseCommit,
          version: "2026.09.4",
          resourceRoot,
          binaryRoot,
        });
      }

      const verifiedSignatures: string[] = [];
      const manifest = await createLatestManifest({
        tag: "v2026.09.4",
        packageVersion: "2026.09.4",
        repository: "owner/repo",
        artifactsRoot,
        commit: releaseCommit,
        pubDate,
        signatureVerifier: async (_bundlePath, signature, publicKey) => {
          verifiedSignatures.push(signature);
          expect(publicKey).toContain("minisign public key");
        },
      });

      expect(manifest.version).toBe("2026.9.4");
      expect(manifest.pub_date).toBe(pubDate);
      expect(manifest.platforms).toMatchObject({
        "linux-x86_64": {
          signature: "signature-x86_64-unknown-linux-gnu",
          url: expect.stringContaining("v2026.09.4/"),
        },
        "linux-aarch64": {
          signature: "signature-aarch64-unknown-linux-gnu",
        },
        "darwin-x86_64": {
          signature: "signature-x86_64-apple-darwin",
        },
        "darwin-aarch64": {
          signature: "signature-aarch64-apple-darwin",
        },
        "windows-x86_64": {
          signature: "signature-x86_64-pc-windows-msvc",
        },
        "windows-aarch64": {
          signature: "signature-aarch64-pc-windows-msvc",
        },
      });
      expect(Object.keys(manifest.platforms)).toHaveLength(6);
      expect(verifiedSignatures).toHaveLength(6);
      const linuxIntegrity = JSON.parse(
        await readFile(
          path.join(
            artifactsRoot,
            `release-${releaseTargets[0]}`,
            `${releaseTargets[0]}-manifest.json`,
          ),
          "utf8",
        ),
      );
      expect(linuxIntegrity).toMatchObject({
        target: releaseTargets[0],
        architecture: "x86_64",
        architecture_verified: true,
        commit: releaseCommit,
        version: "2026.09.4",
      });
      expect(linuxIntegrity.assets).toHaveLength(
        targetSuffixes[releaseTargets[0]].length,
      );
      expect(linuxIntegrity.resources).toHaveLength(4);

      const latestPath = path.join(directory, "latest.json");
      const uploadedRoot = path.join(directory, "uploaded");
      await writeFile(latestPath, JSON.stringify(manifest));
      await mkdir(uploadedRoot, { recursive: true });
      for (const target of releaseTargets) {
        const targetDirectory = path.join(artifactsRoot, `release-${target}`);
        for (const name of await readdir(targetDirectory)) {
          await cp(path.join(targetDirectory, name), path.join(uploadedRoot, name));
        }
      }
      await cp(latestPath, path.join(uploadedRoot, "latest.json"));
      const uploadedNames = await readdir(uploadedRoot);
      const releaseAssets = await Promise.all(
        uploadedNames
          .filter((name) => name !== "latest.json")
          .map(async (name) => ({
            name,
            size: (await lstat(path.join(uploadedRoot, name))).size,
          })),
      );
      releaseAssets.push({
        name: "latest.json",
        size: (await lstat(path.join(uploadedRoot, "latest.json"))).size,
      });
      await expect(
        verifyUploadedReleaseAssets({
          artifactsRoot,
          latestPath,
          uploadedRoot,
          releaseAssets,
        }),
      ).resolves.toBeUndefined();

      const uploadedBundleName = uploadedNames.find((name) =>
        name.endsWith(".AppImage"),
      );
      expect(uploadedBundleName).toBeDefined();
      const uploadedBundle = path.join(uploadedRoot, uploadedBundleName!);
      const uploadedContents = await readFile(uploadedBundle, "utf8");
      await writeFile(uploadedBundle, "altered after upload");
      await expect(
        verifyUploadedReleaseAssets({
          artifactsRoot,
          latestPath,
          uploadedRoot,
          releaseAssets,
        }),
      ).rejects.toThrow("does not match staged bytes");
      await writeFile(uploadedBundle, uploadedContents);
      await expect(
        verifyUploadedReleaseAssets({
          artifactsRoot,
          latestPath,
          uploadedRoot,
          releaseAssets: [...releaseAssets, { name: "unexpected.bin", size: 1 }],
        }),
      ).rejects.toThrow("names do not match staged assets");

      const linuxArtifacts = path.join(artifactsRoot, `release-${releaseTargets[0]}`);
      const appImage = (await readdir(linuxArtifacts)).find((name) =>
        name.endsWith(".AppImage"),
      );
      expect(appImage).toBeDefined();
      const appImagePath = path.join(linuxArtifacts, appImage!);
      await writeFile(appImagePath, "tampered updater payload");
      await expect(
        createLatestManifest({
          tag: "v2026.09.4",
          packageVersion: "2026.09.4",
          repository: "owner/repo",
          artifactsRoot,
          commit: releaseCommit,
          pubDate,
          signatureVerifier: async () => {},
        }),
      ).rejects.toThrow("Release asset integrity check failed");
      await writeFile(appImagePath, `bundle-${releaseTargets[0]}`);

      await expect(
        createLatestManifest({
          tag: "v2026.09.4",
          packageVersion: "2026.09.4",
          repository: "owner/repo",
          artifactsRoot,
          commit: releaseCommit,
          pubDate,
          signatureVerifier: async () => {
            throw new Error("Invalid updater signature");
          },
        }),
      ).rejects.toThrow("Invalid updater signature");

      const unexpectedAsset = path.join(linuxArtifacts, "unexpected.txt");
      await writeFile(unexpectedAsset, "unlisted");
      await expect(
        createLatestManifest({
          tag: "v2026.09.4",
          packageVersion: "2026.09.4",
          repository: "owner/repo",
          artifactsRoot,
          commit: releaseCommit,
          pubDate,
          signatureVerifier: async () => {},
        }),
      ).rejects.toThrow("Integrity manifest asset set does not match");
      await rm(unexpectedAsset);

      const debPackage = (await readdir(linuxArtifacts)).find((name) =>
        name.endsWith(".deb"),
      );
      expect(debPackage).toBeDefined();
      await rm(path.join(linuxArtifacts, debPackage!));
      await expect(
        createLatestManifest({
          tag: "v2026.09.4",
          packageVersion: "2026.09.4",
          repository: "owner/repo",
          artifactsRoot,
          commit: releaseCommit,
          pubDate,
          signatureVerifier: async () => {},
        }),
      ).rejects.toThrow("Expected exactly one .deb asset");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a target missing its updater signature", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "epikrise-missing-signature-"));
    const bundleRoot = path.join(directory, "bundle");
    try {
      await mkdir(bundleRoot, { recursive: true });
      for (const suffix of targetSuffixes[releaseTargets[0]].filter(
        (value) => !value.endsWith(".sig"),
      )) {
        await writeFile(path.join(bundleRoot, `epikrise${suffix}`), "bundle");
      }
      await expect(
        stageReleaseArtifacts({
          target: releaseTargets[0],
          bundleRoot,
          stageRoot: path.join(directory, "staged"),
          commit: releaseCommit,
          version: "2026.09.4",
          resourceRoot: path.join(directory, "resources", "ocr"),
          binaryRoot: path.join(directory, "binaries"),
        }),
      ).rejects.toThrow(".AppImage.sig");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("Tauri localization contract", () => {
  it("keeps command failures structured and serializable for frontend localization", async () => {
    const rustSource = await readFile(
      path.join(repoRoot, "src-tauri/src/lib.rs"),
      "utf8",
    );
    const commandBlocks = rustSource.split("#[tauri::command]").slice(1);

    for (const block of commandBlocks) {
      const functionMatch = block.match(/\b(?:async\s+)?fn\s+([a-z_]\w*)\s*\(/);
      expect(
        functionMatch,
        "each command annotation must define a function",
      ).not.toBeNull();
      const functionStart = functionMatch!.index!;
      const bodyStart = block.indexOf("{", functionStart);
      const signature = block.slice(functionStart, bodyStart);
      const returnType = signature.match(/->\s*([\s\S]+)$/)?.[1].trim();

      expect(returnType, functionMatch![1]).toMatch(/^Result</);
      expect(returnType, functionMatch![1]).toMatch(
        /,\s*(?:TemplateError|LlmError|epikrise_ingest::IngestError)>$/,
      );
    }

    expect(rustSource).not.toMatch(/\bErr\s*\(\s*["']/);

    const structuredErrors = [
      [
        "src-tauri/crates/epikrise-core/src/lib.rs",
        'tag = "key", content = "value", rename_all = "snake_case"',
        "TemplateError",
      ],
      [
        "src-tauri/crates/epikrise-ingest/src/lib.rs",
        'tag = "key", rename_all = "snake_case"',
        "IngestError",
      ],
      [
        "src-tauri/crates/epikrise-llm/src/lib.rs",
        'tag = "key", rename_all = "snake_case"',
        "LlmError",
      ],
    ] as const;

    for (const [file, serdeTag, errorType] of structuredErrors) {
      const source = await readFile(path.join(repoRoot, file), "utf8");
      expect(source).toContain(`#[serde(${serdeTag})]\npub enum ${errorType}`);
    }
  });
});

async function writeExecutable(filePath: string, contents: string) {
  await writeFile(filePath, contents, "utf8");
  await chmod(filePath, 0o755);
}

async function createWindowsOcrFixture(
  directory: string,
  expectedChecksum: string,
  mockChecksumCommand = true,
) {
  const binDir = path.join(directory, "bin");
  const tessdataDir = path.join(directory, "tessdata");
  const resourceDir = path.join(directory, "resources");
  const binaryDir = path.join(directory, "binaries");
  const cacheRoot = path.join(directory, "cache");
  const curlLog = path.join(directory, "curl.log");
  const tarLog = path.join(directory, "tar.log");
  const builderPath = path.join(directory, "build-ocr.sh");
  await Promise.all([
    mkdir(binDir, { recursive: true }),
    mkdir(tessdataDir, { recursive: true }),
  ]);
  await writeFile(path.join(tessdataDir, "deu.traineddata"), "deu", "utf8");
  await writeFile(path.join(tessdataDir, "eng.traineddata"), "eng", "utf8");
  await writeExecutable(
    path.join(binDir, "tesseract"),
    '#!/usr/bin/env bash\nprintf \'List of available languages in "%s":\\n\' "$TESSDATA_DIR"\n',
  );
  await writeExecutable(
    path.join(binDir, "curl"),
    [
      "#!/usr/bin/env bash",
      'output=""',
      'url=""',
      "while [[ $# -gt 0 ]]; do",
      '  if [[ "$1" == "-o" ]]; then output="$2"; shift 2; else url="$1"; shift; fi',
      "done",
      'printf "%s\\n" "$url" >> "$CURL_LOG"',
      'printf "fake pdfium archive" > "$output"',
      "",
    ].join("\n"),
  );
  await writeExecutable(
    path.join(binDir, "tar"),
    [
      "#!/usr/bin/env bash",
      'destination=""',
      'member=""',
      "while [[ $# -gt 0 ]]; do",
      '  if [[ "$1" == "-C" ]]; then destination="$2"; shift 2; else member="$1"; shift; fi',
      "done",
      'mkdir -p "$destination/$(dirname "$member")"',
      'printf "fake pdfium dll" > "$destination/$member"',
      'printf "%s" "$member" > "$TAR_LOG"',
      "",
    ].join("\n"),
  );
  if (mockChecksumCommand) {
    await writeExecutable(
      path.join(binDir, "sha256sum"),
      '#!/usr/bin/env bash\nprintf "%s  %s\\n" "$EXPECTED_CHECKSUM" "$1"\n',
    );
    await writeExecutable(
      path.join(binDir, "shasum"),
      '#!/usr/bin/env bash\nprintf "%s  %s\\n" "$EXPECTED_CHECKSUM" "$2"\n',
    );
  }
  await writeExecutable(
    builderPath,
    [
      "#!/usr/bin/env bash",
      'mkdir -p "$EPIKRISE_OCR_BINARY_DIR"',
      'printf "fake tesseract exe" > "$EPIKRISE_OCR_BINARY_DIR/tesseract-$1.exe"',
      "",
    ].join("\n"),
  );

  return {
    binDir,
    builderPath,
    cacheRoot,
    curlLog,
    resourceDir,
    binaryDir,
    tarLog,
    tessdataDir,
    environment: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      TESSDATA_DIR: tessdataDir,
      EXPECTED_CHECKSUM: expectedChecksum,
      CURL_LOG: curlLog,
      TAR_LOG: tarLog,
      EPIKRISE_OCR_RESOURCE_DIR: resourceDir,
      EPIKRISE_OCR_BINARY_DIR: binaryDir,
      EPIKRISE_WINDOWS_OCR_CACHE: cacheRoot,
      EPIKRISE_WINDOWS_OCR_BUILDER: builderPath,
    },
  };
}

describe("frontend test harness", () => {
  it("executes Vitest with the project configuration", () => {
    expect(true).toBe(true);
  });

  it("converts a text prompt into a TOML template", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "epikrise-template-"));
    const inputPath = path.join(directory, "prompt.txt");
    const outputPath = path.join(directory, "converted.epitpl");
    const scriptPath = fileURLToPath(
      new URL("../scripts/convert-prompt.mjs", import.meta.url),
    );

    try {
      await writeFile(inputPath, "Synthetic test prompt", "utf8");
      await execFile(process.execPath, [scriptPath, inputPath, outputPath]);

      const template = TOML.parse(await readFile(outputPath, "utf8"));
      expect(template.system_prompt).toBe("Synthetic test prompt");
      expect(template.sections).toHaveLength(1);
      expect(template.schema_version).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

if (process.platform !== "win32") {
  describe("Windows OCR preparation", () => {
    const prepareScript = path.join(repoRoot, "scripts/prepare-ocr.sh");

    for (const targetCase of windowsOcrTargets) {
      it(`stages the matching PDFium and Tesseract for ${targetCase.target}`, async () => {
        const directory = await mkdtemp(path.join(tmpdir(), "epikrise-ocr-"));
        try {
          const fixture = await createWindowsOcrFixture(directory, targetCase.checksum);
          await execFile("bash", [prepareScript, "--target", targetCase.target], {
            cwd: repoRoot,
            env: fixture.environment,
          });

          expect(await readFile(fixture.tarLog, "utf8")).toBe("bin/pdfium.dll");
          expect(
            await readFile(path.join(fixture.resourceDir, "pdfium/pdfium.dll"), "utf8"),
          ).toBe("fake pdfium dll");
          expect(
            await readFile(
              path.join(fixture.resourceDir, "tessdata/deu.traineddata"),
              "utf8",
            ),
          ).toBe("deu");
          expect(
            await readFile(
              path.join(fixture.resourceDir, "tessdata/eng.traineddata"),
              "utf8",
            ),
          ).toBe("eng");
          expect(
            await readFile(
              path.join(fixture.binaryDir, `tesseract-${targetCase.target}.exe`),
              "utf8",
            ),
          ).toBe("fake tesseract exe");
          expect(await readFile(fixture.curlLog, "utf8")).toContain(targetCase.archive);
          expect(
            await readFile(
              path.join(
                fixture.cacheRoot,
                "pdfium",
                targetCase.target,
                targetCase.archive,
              ),
              "utf8",
            ),
          ).toBe("fake pdfium archive");
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      });
    }

    it("invalidates a corrupt cached archive and rejects a bad download", async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "epikrise-ocr-cache-"));
      const { target, archive, checksum } = windowsOcrTargets[0];
      try {
        const fixture = await createWindowsOcrFixture(directory, checksum, false);
        const cachePath = path.join(fixture.cacheRoot, "pdfium", target, archive);
        await mkdir(path.dirname(cachePath), { recursive: true });
        await writeFile(cachePath, "corrupt cached archive", "utf8");

        await expect(
          execFile("bash", [prepareScript, "--target", target], {
            cwd: repoRoot,
            env: fixture.environment,
          }),
        ).rejects.toMatchObject({
          stderr: expect.stringContaining("PDFium checksum mismatch"),
        });
        expect(await readFile(fixture.curlLog, "utf8")).toContain(archive);
        await expect(readFile(cachePath)).rejects.toThrow();
        await expect(
          readFile(path.join(fixture.resourceDir, "pdfium/pdfium.dll")),
        ).rejects.toThrow();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    it("rejects targets without a configured OCR asset mapping", async () => {
      await expect(
        execFile("bash", [prepareScript, "--target", "wasm32-unknown-unknown"]),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("OCR asset preparation is not configured"),
      });
    });
  });
}
