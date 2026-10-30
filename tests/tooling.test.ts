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
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import TOML from "@iarna/toml";
import { describe, expect, it, vi } from "vitest";
import {
  assertStoreVersionAdvances,
  createReleasedChangelog,
  deriveReleaseVersions,
  nextCalverVersion,
  prepareReleaseBuildInputs,
  releaseVersionFromProtocolVersion,
  updateSourceCargoLockVersions,
  validateCalverVersion,
} from "../scripts/prepare-release.mjs";
import { prepareReleaseWorkspace } from "../scripts/prepare-release-workspace.mjs";
import {
  assertDispatchPreconditions,
  assertSuccessfulJobs,
  desktopTargets,
  selectMatchingRun,
  stagePackages,
  stageStoreReleaseAssets,
  verifyArtifactSet,
  verifyStoreReleaseAssets,
} from "../scripts/desktop-builds.mjs";
import {
  assertRecoverableReleaseDraft,
  createReleaseAssetEvidence,
  createLatestManifest,
  releaseTargets,
  shouldPromoteLatest,
  stageReleaseArtifacts,
  validateReleaseTag,
  verifyUploadedReleaseAssets,
} from "../scripts/release-artifacts.mjs";
import { createWindowsReleaseConfig } from "../scripts/windows-release-config.mjs";
import { resolveLinuxSessionBusAddress, runTauri } from "../scripts/tauri.mjs";
import { verifyBinaryArchitecture } from "../scripts/verify-binary-architecture.mjs";
import {
  assertResolvedLinuxDependencies,
  assertSystemOnlyMachODependencies,
  assertSystemOnlyPEDependencies,
} from "../scripts/verify-runtime-dependencies.mjs";
import {
  prepareStoreMsixLayout,
  verifyStoreMsixLayout,
} from "../scripts/store-msix.mjs";

const execFile = promisify(execFileCallback);
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const runtimeDependenciesScriptPath = path.join(
  repoRoot,
  "scripts/verify-runtime-dependencies.mjs",
);

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

function createBinaryHeader(target: string) {
  const binary = Buffer.alloc(128);
  if (target.endsWith("-unknown-linux-gnu")) {
    binary.write("\x7fELF", 0, "binary");
    binary[4] = 2;
    binary[5] = 1;
    binary.writeUInt16LE(target.startsWith("x86_64-") ? 62 : 183, 18);
  } else if (target.endsWith("-apple-darwin")) {
    binary.set([0xcf, 0xfa, 0xed, 0xfe]);
    binary.writeUInt32LE(target.startsWith("x86_64-") ? 0x01000007 : 0x0100000c, 4);
  } else {
    binary.write("MZ", 0, "ascii");
    binary.writeUInt32LE(64, 0x3c);
    binary.write("PE\0\0", 64, "binary");
    binary.writeUInt16LE(target.startsWith("x86_64-") ? 0x8664 : 0xaa64, 68);
  }
  return binary;
}

function nativeBuildEvidence(
  target: string,
  buildMode: "diagnostic" | "signed-release" = "diagnostic",
) {
  const nativeTarget = target.startsWith("windows-")
    ? `${target.includes("aarch64") ? "aarch64" : "x86_64"}-pc-windows-msvc`
    : target;
  const runnerOS = nativeTarget.includes("unknown-linux")
    ? "Linux"
    : nativeTarget.includes("apple-darwin")
      ? "macOS"
      : "Windows";
  const runnerArch = nativeTarget.startsWith("aarch64-") ? "ARM64" : "X64";
  return {
    runnerOS,
    runnerArch,
    rustHost: nativeTarget,
    target: nativeTarget,
    buildMode,
  };
}

function syntheticBuildProvenance(commit: string) {
  return {
    source: {
      commit,
      archive_sha256: "b".repeat(64),
    },
    cache: {
      key: `synthetic-${commit}`,
      restored: false,
    },
    tool_versions: {
      rustc: "rustc synthetic",
      cargo: "cargo synthetic",
      node: "node synthetic",
      pnpm: "pnpm synthetic",
      tauri_cli: "tauri synthetic",
    },
  };
}

describe("binary architecture verification", () => {
  it.each([
    "x86_64-unknown-linux-gnu",
    "aarch64-unknown-linux-gnu",
    "x86_64-apple-darwin",
    "aarch64-apple-darwin",
    "x86_64-pc-windows-msvc",
    "aarch64-pc-windows-msvc",
  ])("accepts a matching %s binary header", async (target) => {
    const directory = await mkdtemp(path.join(tmpdir(), "epikrise-binary-header-"));
    const binaryPath = path.join(directory, "fixture.bin");
    try {
      await writeFile(binaryPath, createBinaryHeader(target));
      await expect(
        verifyBinaryArchitecture(target, binaryPath),
      ).resolves.toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    {
      label: "ELF32",
      offset: 4,
      value: 1,
      message: "ELF binary must use the 64-bit class",
    },
    {
      label: "big-endian ELF",
      offset: 5,
      value: 2,
      message: "ELF binary must use little-endian byte order",
    },
  ])(
    "rejects $label headers for supported Linux targets",
    async ({ offset, value, message }) => {
      for (const target of ["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu"]) {
        const directory = await mkdtemp(path.join(tmpdir(), "epikrise-binary-header-"));
        const binaryPath = path.join(directory, "fixture.bin");
        const binary = createBinaryHeader(target);
        binary[offset] = value;

        try {
          await writeFile(binaryPath, binary);
          await expect(verifyBinaryArchitecture(target, binaryPath)).rejects.toThrow(
            message,
          );
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
    },
  );

  it("rejects a binary header for the wrong target architecture", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "epikrise-binary-header-"));
    const binaryPath = path.join(directory, "fixture.exe");
    try {
      await writeFile(binaryPath, createBinaryHeader("x86_64-pc-windows-msvc"));
      await expect(
        verifyBinaryArchitecture("aarch64-pc-windows-msvc", binaryPath),
      ).rejects.toThrow("expects PE arm64; found PE x86_64");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("recognizes both architectures in a universal Mach-O header", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "epikrise-universal-header-"));
    const binaryPath = path.join(directory, "universal.bin");
    const binary = Buffer.alloc(48);
    binary.set([0xca, 0xfe, 0xba, 0xbe]);
    binary.writeUInt32BE(2, 4);
    binary.writeUInt32BE(0x01000007, 8);
    binary.writeUInt32BE(3, 12);
    binary.writeUInt32BE(0x0100000c, 28);
    binary.writeUInt32BE(0, 32);

    try {
      await writeFile(binaryPath, binary);
      await expect(
        verifyBinaryArchitecture("x86_64-apple-darwin", binaryPath),
      ).resolves.toBeUndefined();
      await expect(
        verifyBinaryArchitecture("aarch64-apple-darwin", binaryPath),
      ).resolves.toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("Store MSIX layout validation", () => {
  async function createFixture(
    version = "2026.10.0",
    target = "x86_64-pc-windows-msvc",
  ) {
    const root = await mkdtemp(path.join(tmpdir(), "epikrise-store-msix-"));
    const buildDirectory = path.join(root, "build");
    const stageDirectory = path.join(root, "stage");
    const tauriDirectory = path.join(root, "src-tauri");
    await mkdir(buildDirectory);
    await mkdir(path.join(tauriDirectory, "msix"), { recursive: true });
    await mkdir(path.join(tauriDirectory, "binaries"), { recursive: true });
    await mkdir(path.join(tauriDirectory, "icons"), { recursive: true });
    await mkdir(path.join(tauriDirectory, "resources/ocr/pdfium"), {
      recursive: true,
    });
    await mkdir(path.join(tauriDirectory, "resources/ocr/tessdata"), {
      recursive: true,
    });
    await writeFile(path.join(root, "package.json"), JSON.stringify({ version }));
    await writeFile(
      path.join(tauriDirectory, "msix/AppxManifest.xml"),
      await readFile(path.join(repoRoot, "src-tauri/msix/AppxManifest.xml")),
    );
    await writeFile(
      path.join(buildDirectory, "epikrise.exe"),
      createBinaryHeader(target),
    );
    await writeFile(
      path.join(tauriDirectory, `binaries/tesseract-${target}.exe`),
      createBinaryHeader(target),
    );
    await writeFile(
      path.join(tauriDirectory, "resources/ocr/pdfium/pdfium.dll"),
      createBinaryHeader(target),
    );
    await writeFile(
      path.join(tauriDirectory, "resources/ocr/tessdata/deu.traineddata"),
      "German OCR fixture",
    );
    await writeFile(
      path.join(tauriDirectory, "resources/ocr/tessdata/eng.traineddata"),
      "English OCR fixture",
    );
    for (const asset of [
      "StoreLogo.png",
      "Square150x150Logo.png",
      "Square44x44Logo.png",
    ]) {
      await writeFile(path.join(tauriDirectory, "icons", asset), "PNG fixture");
    }
    return {
      root,
      target,
      buildDirectory,
      stageDirectory,
      repoRoot: root,
      async cleanup() {
        await rm(root, { recursive: true, force: true });
      },
    };
  }

  it("stages a complete x64 payload with the reserved identity and derived version", async () => {
    const fixture = await createFixture();
    try {
      const result = await prepareStoreMsixLayout({
        ...fixture,
        architecture: "x64",
      });
      expect(result.version).toBe("2026.10.0.0");
      await expect(
        verifyStoreMsixLayout({
          layoutDirectory: fixture.stageDirectory,
          architecture: "x64",
          target: fixture.target,
          version: result.version,
        }),
      ).resolves.toBeUndefined();
      expect(
        await readFile(path.join(fixture.stageDirectory, "AppxManifest.xml"), "utf8"),
      ).toContain('Name="JerneyNexus.Epikrise"');
    } finally {
      await fixture.cleanup();
    }
  });

  it("stages an ARM64 payload with an ARM64 manifest identity", async () => {
    const fixture = await createFixture("2026.10.0", "aarch64-pc-windows-msvc");
    try {
      const result = await prepareStoreMsixLayout({
        ...fixture,
        architecture: "arm64",
      });
      const manifest = await readFile(
        path.join(fixture.stageDirectory, "AppxManifest.xml"),
        "utf8",
      );
      expect(manifest).toContain('ProcessorArchitecture="arm64"');
      await expect(
        verifyStoreMsixLayout({
          layoutDirectory: fixture.stageDirectory,
          architecture: "arm64",
          target: fixture.target,
          version: result.version,
        }),
      ).resolves.toBeUndefined();
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects a missing OCR language resource", async () => {
    const fixture = await createFixture();
    try {
      await rm(
        path.join(fixture.repoRoot, "src-tauri/resources/ocr/tessdata/eng.traineddata"),
      );
      await expect(
        prepareStoreMsixLayout({ ...fixture, architecture: "x64" }),
      ).rejects.toThrow("Required MSIX source resource is missing");
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects a PE binary for the wrong architecture", async () => {
    const fixture = await createFixture();
    try {
      await writeFile(
        path.join(fixture.buildDirectory, "epikrise.exe"),
        createBinaryHeader("aarch64-pc-windows-msvc"),
      );
      await expect(
        prepareStoreMsixLayout({ ...fixture, architecture: "x64" }),
      ).rejects.toThrow("expects PE x86_64; found PE arm64");
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects an MSIX version component outside the supported range", async () => {
    const fixture = await createFixture("2026.10.65536");
    try {
      await expect(
        prepareStoreMsixLayout({ ...fixture, architecture: "x64" }),
      ).rejects.toThrow("65535");
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects a manifest whose logo reference is not in the staged payload", async () => {
    const fixture = await createFixture();
    try {
      const manifestPath = path.join(
        fixture.repoRoot,
        "src-tauri/msix/AppxManifest.xml",
      );
      const manifest = await readFile(manifestPath, "utf8");
      await writeFile(
        manifestPath,
        manifest.replace("Assets\\Square44x44Logo.png", "Assets\\MissingLogo.png"),
      );
      await expect(
        prepareStoreMsixLayout({ ...fixture, architecture: "x64" }),
      ).rejects.toThrow("MSIX manifest references an unexpected asset");
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([
    [
      "missing Resources element",
      (manifest: string) =>
        manifest.replace(
          '  <Resources>\n    <Resource Language="en-US" />\n  </Resources>\n',
          "",
        ),
    ],
    [
      "a language not used by the manifest strings",
      (manifest: string) => manifest.replace('Language="en-US"', 'Language="fr-FR"'),
    ],
  ])("rejects MSIX manifests with %s", async (_label, updateManifest) => {
    const fixture = await createFixture();
    try {
      const manifestPath = path.join(
        fixture.repoRoot,
        "src-tauri/msix/AppxManifest.xml",
      );
      const manifest = await readFile(manifestPath, "utf8");
      await writeFile(manifestPath, updateManifest(manifest));
      await expect(
        prepareStoreMsixLayout({ ...fixture, architecture: "x64" }),
      ).rejects.toThrow("MSIX manifest must declare an en-US package resource");
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects a package version that does not advance the previous Store version", async () => {
    const fixture = await createFixture();
    try {
      await expect(
        prepareStoreMsixLayout({
          ...fixture,
          architecture: "x64",
          previousStoreVersion: "2026.10.0.0",
        }),
      ).rejects.toThrow("must be greater");
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("Linux runtime dependency verification", () => {
  it("accepts resolved and statically linked binaries", () => {
    expect(() =>
      assertResolvedLinuxDependencies(
        "app",
        "libc.so.6 => /lib/aarch64-linux-gnu/libc.so.6 (0x0)\nnot a dynamic executable",
      ),
    ).not.toThrow();
  });

  it("rejects unresolved runtime libraries", () => {
    expect(() =>
      assertResolvedLinuxDependencies("app", "libwebkit.so => not found"),
    ).toThrow("Unresolved runtime dependencies for app: libwebkit.so.");
  });

  it("rejects unavailable library versions when dependency paths resolve", () => {
    expect(() =>
      assertResolvedLinuxDependencies(
        "app",
        "libc.so.6 => /lib/libc.so.6 (0x0)\napp: /lib/libc.so.6: version 'GLIBC_2.38' not found (required by app)",
      ),
    ).toThrow("Unresolved runtime library versions for app:");
  });

  it("rejects ldd version diagnostics with a backtick and apostrophe", () => {
    expect(() =>
      assertResolvedLinuxDependencies(
        "app",
        "libc.so.6 => /lib/libc.so.6 (0x0)\napp: /lib/libc.so.6: version `GLIBC_2.38' not found (required by app)",
      ),
    ).toThrow("Unresolved runtime library versions for app:");
  });

  it.each(["", "ldd output format changed"])(
    "rejects empty or unrecognized ldd output: %s",
    (output) => {
      expect(() => assertResolvedLinuxDependencies("app", output)).toThrow(
        "Could not recognize ldd output for app.",
      );
    },
  );

  it.each(["statically linked", "app: not a dynamic executable"])(
    "accepts recognized static ldd diagnostics: %s",
    (output) => {
      expect(() => assertResolvedLinuxDependencies("app", output)).not.toThrow();
    },
  );
});

describe("macOS runtime dependency verification", () => {
  it("accepts dependencies from macOS system locations", () => {
    expect(() =>
      assertSystemOnlyMachODependencies(
        "Epikrise",
        "Epikrise:\n\t/System/Library/Frameworks/Cocoa.framework/Cocoa (compatibility version 1.0.0)\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)",
      ),
    ).not.toThrow();
  });

  it.each([
    ["empty output", ""],
    ["header-only output", "Epikrise:\n"],
    ["unrecognized output", "not otool output\n"],
    ["malformed dependency output", "Epikrise:\n\t/usr/lib/libSystem.B.dylib\n"],
  ])("rejects %s", (_description, output) => {
    expect(() => assertSystemOnlyMachODependencies("Epikrise", output)).toThrow(
      "Could not recognize otool output for Epikrise.",
    );
  });

  it("rejects dependencies outside system locations", () => {
    expect(() =>
      assertSystemOnlyMachODependencies(
        "Epikrise",
        "Epikrise:\n\t/opt/homebrew/lib/libexample.dylib (compatibility version 1.0.0)",
      ),
    ).toThrow(
      "Non-system runtime dependencies for Epikrise: /opt/homebrew/lib/libexample.dylib.",
    );
  });

  it("ignores a dylib's own install name but rejects other external libraries", () => {
    expect(() =>
      assertSystemOnlyMachODependencies(
        "/app/libpdfium.dylib",
        "/app/libpdfium.dylib:\n\t./libpdfium.dylib (compatibility version 1.0.0)\n\t/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation (compatibility version 1.0.0)",
      ),
    ).not.toThrow();

    expect(() =>
      assertSystemOnlyMachODependencies(
        "/app/libpdfium.dylib",
        "/app/libpdfium.dylib:\n\t./libpdfium.dylib (compatibility version 1.0.0)\n\t/opt/homebrew/lib/libexample.dylib (compatibility version 1.0.0)",
      ),
    ).toThrow(
      "Non-system runtime dependencies for /app/libpdfium.dylib: /opt/homebrew/lib/libexample.dylib.",
    );
  });
});

describe("Windows runtime dependency verification", () => {
  it("accepts system libraries and Windows API sets", () => {
    expect(() =>
      assertSystemOnlyPEDependencies(
        "Epikrise.exe",
        "Image has the following dependencies:\n    KERNEL32.dll\n    api-ms-win-core-file-l1-2-0.dll\n    ucrtbase.dll",
      ),
    ).not.toThrow();
  });

  it("rejects dependencies that must be bundled", () => {
    expect(() =>
      assertSystemOnlyPEDependencies(
        "pdfium.dll",
        "Image has the following dependencies:\n    KERNEL32.dll\n    VCRUNTIME140.dll",
      ),
    ).toThrow("Non-system runtime dependencies for pdfium.dll: vcruntime140.dll.");
  });

  it("rejects dependency output that cannot be parsed", () => {
    expect(() =>
      assertSystemOnlyPEDependencies("Epikrise.exe", "No dependency table found"),
    ).toThrow("Could not find PE runtime dependencies for Epikrise.exe.");
  });

  it.each([
    ["Linux", "x86_64-unknown-linux-gnu", "ldd"],
    ["macOS", "x86_64-apple-darwin", "otool"],
    ["Windows", "x86_64-pc-windows-msvc", "dumpbin"],
  ])("reports a missing %s inspection tool", async (_platform, target, tool) => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "epikrise-missing-inspection-tool-"),
    );

    try {
      await expect(
        execFile(
          process.execPath,
          [runtimeDependenciesScriptPath, target, "fixture.bin"],
          {
            env: {
              ...process.env,
              PATH: directory,
            },
          },
        ),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining(
          `Could not inspect runtime dependencies for fixture.bin: spawn ${tool} ENOENT`,
        ),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("CalVer release versions", () => {
  it("increments the patch within the current month", () => {
    expect(nextCalverVersion("2026.10.2", new Date("2026-10-01T12:00:00Z"))).toBe(
      "2026.10.3",
    );
  });

  it("starts a new month at patch zero", () => {
    expect(nextCalverVersion("2026.9.4", new Date("2026-10-01T12:00:00Z"))).toBe(
      "2026.10.0",
    );
  });

  it("rejects invalid dates and versions earlier than the project version", () => {
    expect(() => validateCalverVersion("2026.13.0")).toThrow();
    expect(() => validateCalverVersion("2026.01.0")).toThrow();
    expect(() =>
      nextCalverVersion("2026.10.0", new Date("2026-09-30T12:00:00Z")),
    ).toThrow();
  });

  it.each([
    ["2026.1.0", "2026.1.0", "2026.1.0.0"],
    ["2026.9.4", "2026.9.4", "2026.9.4.0"],
    ["2026.10.0", "2026.10.0", "2026.10.0.0"],
    ["2027.1.0", "2027.1.0", "2027.1.0.0"],
  ])(
    "derives bounded protocol/package versions from %s without changing its tag",
    (releaseVersion, protocolVersion, msixVersion) => {
      expect(deriveReleaseVersions(releaseVersion)).toEqual({
        releaseVersion,
        updateProtocolVersion: protocolVersion,
        msixIdentityVersion: msixVersion,
      });
      expect(releaseVersionFromProtocolVersion(protocolVersion)).toBe(releaseVersion);
    },
  );

  it("enforces Store version bounds and rejects Store downgrades", () => {
    expect(() => deriveReleaseVersions("1999.12.0")).toThrow("at least 2000");
    expect(deriveReleaseVersions("2256.1.0").msixIdentityVersion).toBe("2256.1.0.0");
    expect(() => deriveReleaseVersions("2026.1.65536")).toThrow("65535");
    expect(() => releaseVersionFromProtocolVersion("2026.00.0")).toThrow();
    expect(() => releaseVersionFromProtocolVersion("2026.09.0")).toThrow();
    expect(() => releaseVersionFromProtocolVersion("0001.1.0")).toThrow();
    expect(() => releaseVersionFromProtocolVersion("2026.1.65536")).toThrow();
    expect(assertStoreVersionAdvances("2026.10.0", "2026.9.4.0")).toBe("2026.10.0.0");
    expect(() => assertStoreVersionAdvances("2026.9.4", "2026.9.4.0")).toThrow(
      "must be greater",
    );
    expect(() => assertStoreVersionAdvances("2026.10.0", "2026.9.65536.0")).toThrow(
      "Invalid published Store version",
    );
  });

  it.each([
    ["2026.1.0", "2026.1.0"],
    ["2026.9.4", "2026.9.4"],
    ["2026.10.0", "2026.10.0"],
  ])(
    "builds disposable Cargo and Tauri inputs with --locked for %s",
    async (releaseVersion, protocolVersion) => {
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
        expect(
          JSON.parse(
            await readFile(path.join(repoRoot, "src-tauri/tauri.conf.json"), "utf8"),
          ).version,
        ).toBe(sourcePackage.version);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    300_000,
  );

  it("updates source Cargo.lock workspace entries alongside the manifests", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "epikrise-release-lock-"));
    const tauriDirectory = path.join(directory, "src-tauri");
    try {
      await cp(path.join(repoRoot, "src-tauri"), tauriDirectory, {
        recursive: true,
        filter: (source) =>
          !["target", "gen", "WixTools"].some((excluded) =>
            source.split(path.sep).includes(excluded),
          ),
      });

      const sourcePackage = JSON.parse(
        await readFile(path.join(repoRoot, "package.json"), "utf8"),
      );
      const [year, month, patch] = sourcePackage.version.split(".");
      const releaseVersion = `${year}.${month}.${Number(patch) + 1}`;
      const cargoManifestPath = path.join(tauriDirectory, "Cargo.toml");
      const cargoManifest = (await readFile(cargoManifestPath, "utf8")).replaceAll(
        sourcePackage.version,
        releaseVersion,
      );
      await writeFile(cargoManifestPath, cargoManifest);

      const originalPackages = TOML.parse(
        await readFile(path.join(tauriDirectory, "Cargo.lock"), "utf8"),
      ).package as unknown as Array<{ name: string; version: string }>;
      const serdeVersion = originalPackages.find(
        (entry) => entry.name === "serde",
      )?.version;
      expect(serdeVersion).toBeDefined();

      await updateSourceCargoLockVersions(directory, releaseVersion);

      const updatedLock = TOML.parse(
        await readFile(path.join(tauriDirectory, "Cargo.lock"), "utf8"),
      );
      expect(updatedLock.package).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "epikrise", version: releaseVersion }),
          expect.objectContaining({ name: "epikrise-core", version: releaseVersion }),
          expect.objectContaining({ name: "epikrise-ingest", version: releaseVersion }),
          expect.objectContaining({ name: "epikrise-llm", version: releaseVersion }),
          expect.objectContaining({ name: "serde", version: serdeVersion }),
        ]),
      );
      await execFile(
        "cargo",
        [
          "metadata",
          "--format-version",
          "1",
          "--no-deps",
          "--locked",
          "--offline",
          "--manifest-path",
          path.join(tauriDirectory, "Cargo.toml"),
        ],
        { cwd: directory, maxBuffer: 10 * 1024 * 1024 },
      );

      const sourceLock = TOML.parse(
        await readFile(path.join(repoRoot, "src-tauri/Cargo.lock"), "utf8"),
      );
      expect(sourceLock.package).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "epikrise",
            version: sourcePackage.version,
          }),
        ]),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

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

  it("limits generated release notes to unreleased commits", async () => {
    const script = await readFile(
      path.join(repoRoot, "scripts/prepare-release.mjs"),
      "utf8",
    );
    const invocation = script.match(/"git-cliff",\s*\n\s*\[([^\]]+)\]/)?.[1];

    expect(invocation).toBeDefined();
    expect(invocation).toContain('"--unreleased"');
    expect(invocation).toContain('"--tag"');
  });
});

describe("release workspace preparation", () => {
  async function withTemporaryWorkspace(
    test: (temporaryRoot: string, commit: string) => Promise<void>,
  ) {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "epikrise-release-workspace-test-"),
    );
    const { stdout } = await execFile("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
    });

    try {
      await test(temporaryRoot, stdout.trim());
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
      await execFile("git", ["worktree", "prune"], { cwd: repoRoot });
    }
  }

  it("requires a full lowercase commit SHA and a new separate workspace", async () => {
    await withTemporaryWorkspace(async (temporaryRoot, commit) => {
      const workspace = path.join(temporaryRoot, "workspace");
      await expect(
        prepareReleaseWorkspace(commit.slice(0, 7), workspace),
      ).rejects.toThrow("full lowercase Git SHA");
      await expect(lstat(workspace)).rejects.toMatchObject({ code: "ENOENT" });

      await mkdir(workspace);
      await expect(prepareReleaseWorkspace(commit, workspace)).rejects.toThrow(
        "already exists",
      );
      await expect(prepareReleaseWorkspace(commit, repoRoot)).rejects.toThrow(
        "separate from the source checkout",
      );
    });
  });

  it("verifies the requested commit and removes the Git metadata marker", async () => {
    await withTemporaryWorkspace(async (temporaryRoot, commit) => {
      const workspace = path.join(temporaryRoot, "workspace");
      const archiveHash = await prepareReleaseWorkspace(commit, workspace, {
        prepareReleaseBuildInputs: async () => {},
      });

      expect(archiveHash).toMatch(/^[0-9a-f]{64}$/);
      const { stdout: expectedPackageJson } = await execFile(
        "git",
        ["show", `${commit}:package.json`],
        { cwd: repoRoot },
      );
      expect(await readFile(path.join(workspace, "package.json"), "utf8")).toBe(
        expectedPackageJson,
      );
      await expect(lstat(path.join(workspace, ".git"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("removes the worktree when build-input preparation fails", async () => {
    await withTemporaryWorkspace(async (temporaryRoot, commit) => {
      const workspace = path.join(temporaryRoot, "workspace");
      const preparationError = new Error("Build-input preparation failed.");

      await expect(
        prepareReleaseWorkspace(commit, workspace, {
          prepareReleaseBuildInputs: async () => {
            throw preparationError;
          },
        }),
      ).rejects.toBe(preparationError);
      await expect(lstat(workspace)).rejects.toMatchObject({ code: "ENOENT" });
    });
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

  it("does not expose the former CI license-bypass setup path", async () => {
    const setupScript = path.join(repoRoot, "scripts/windows-setup.sh");
    const source = await readFile(setupScript, "utf8");

    await expect(
      execFile("bash", [setupScript, "--ci"], {
        env: clearCiEnvironment({
          ...process.env,
          EPIKRISE_WINDOWS_SDK_LICENSE_APPROVED: "true",
        }),
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Usage:"),
    });
    expect(source).not.toContain("--ci");
    expect(source).not.toContain("EPIKRISE_WINDOWS_SDK_LICENSE_APPROVED");
  });
});

describe("Windows setup noninteractive behavior", () => {
  it.each(["x86_64", "aarch64"])(
    "reaches the interactive license prompt on Linux %s without downloading",
    async (hostArch) => {
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
        await writeMockUname(binDir, `${hostArch}-unknown-linux-gnu`);
        await writeExecutable(
          path.join(binDir, "rustc"),
          `#!/usr/bin/env bash\nprintf 'host: ${hostArch}-unknown-linux-gnu\\n'\n`,
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
          await writeExecutable(
            path.join(binDir, tool),
            "#!/usr/bin/env bash\nexit 0\n",
          );
        }
        const env = clearCiEnvironment({
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
          XDG_CACHE_HOME: cacheRoot,
          CARGO_LOG: cargoLog,
          EPIKRISE_WINDOWS_SDK_LICENSE_APPROVED: "true",
        });

        await expect(execFile("bash", [setupScript], { env })).rejects.toMatchObject({
          stderr: expect.stringContaining("interactive terminal"),
          stdout: expect.stringContaining("Type ACCEPT"),
        });
        await expect(readFile(cargoLog, "utf8")).rejects.toThrow();
        await expect(
          readFile(
            path.join(
              cacheRoot,
              "epikrise/windows/sdk-license-accepted-17-10.0.26100-14.44.17.14",
            ),
            "utf8",
          ),
        ).rejects.toThrow();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ["CI=true", { CI: "true" }],
    ["CI=1", { CI: "1" }],
    ["CI=yes", { CI: "yes" }],
    ["CI=YES", { CI: "YES" }],
    ["CI=On", { CI: "On" }],
    ["GitHub Actions", { GITHUB_ACTIONS: "true" }],
    ["GitLab CI", { GITLAB_CI: "true" }],
  ])("rejects %s even when SDK approval is supplied", async (_name, ciEnvironment) => {
    const setupScript = path.join(repoRoot, "scripts/windows-setup.sh");
    await expect(
      execFile("bash", [setupScript], {
        env: {
          ...clearCiEnvironment({ ...process.env }),
          ...ciEnvironment,
          EPIKRISE_WINDOWS_SDK_LICENSE_APPROVED: "true",
        },
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("cannot run in CI"),
    });
  });
});

describe("manual Linux NSIS cross-build guards", () => {
  it.each(["x86_64", "aarch64"])(
    "routes both Windows NSIS targets through the opted-in Linux %s host",
    async (hostArch) => {
      const directory = await mkdtemp(path.join(tmpdir(), "epikrise-windows-build-"));
      try {
        const fixture = await createWindowsCrossBuildFixture(directory, { hostArch });
        await execFile("bash", [fixture.scriptPath, "all"], {
          cwd: fixture.repoRoot,
          env: fixture.environment,
        });

        const prepareLog = await readFile(fixture.prepareLog, "utf8");
        expect(prepareLog).toContain(
          `--target x86_64-pc-windows-msvc|nsis|${hostArch}|true`,
        );
        expect(prepareLog).toContain(
          `--target aarch64-pc-windows-msvc|nsis|${hostArch}|true`,
        );
        const buildLog = await readFile(fixture.buildLog, "utf8");
        expect(buildLog).toContain('--config {"bundle":{"targets":["nsis"]}}');
        expect(
          buildLog.match(/--target (x86_64|aarch64)-pc-windows-msvc/g),
        ).toHaveLength(2);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each([
    [
      "missing opt-in",
      { EPIKRISE_ALLOW_LINUX_WINDOWS_CROSS_BUILD: "" },
      "EPIKRISE_ALLOW_LINUX_WINDOWS_CROSS_BUILD=true",
    ],
    ["CI=true", { CI: "true" }, "cannot run in CI"],
    ["CI=1", { CI: "1" }, "cannot run in CI"],
    ["CI=yes", { CI: "yes" }, "cannot run in CI"],
    ["CI=YES", { CI: "YES" }, "cannot run in CI"],
    ["CI=On", { CI: "On" }, "cannot run in CI"],
    ["GitHub Actions", { GITHUB_ACTIONS: "true" }, "cannot run in CI"],
    ["GitLab CI", { GITLAB_CI: "true" }, "cannot run in CI"],
    ["release mode", {}, "diagnostic NSIS packages only"],
    ["MSI", { EPIKRISE_WINDOWS_INSTALLER_FAMILY: "msi" }, "NSIS packages only"],
    ["MSIX", { EPIKRISE_WINDOWS_INSTALLER_FAMILY: "msix" }, "NSIS packages only"],
    [
      "other package",
      { EPIKRISE_WINDOWS_INSTALLER_FAMILY: "appimage" },
      "NSIS packages only",
    ],
    ["unsupported OS", { TEST_HOST_OS: "Darwin" }, "only from Linux x64 or ARM64"],
    [
      "unsupported architecture",
      { TEST_HOST_ARCH: "s390x" },
      "native Linux x64 or ARM64",
    ],
  ])(
    "rejects %s before OCR preparation or compilation",
    async (name, environmentOverrides, message) => {
      const directory = await mkdtemp(path.join(tmpdir(), "epikrise-windows-build-"));
      try {
        const fixture = await createWindowsCrossBuildFixture(directory);
        const environment = {
          ...fixture.environment,
          EPIKRISE_ALLOW_LINUX_WINDOWS_CROSS_BUILD: "true",
          ...environmentOverrides,
        };
        const args = [fixture.scriptPath, "x64"];
        if (name === "release mode") args.push("release");

        await expect(
          execFile("bash", args, {
            cwd: fixture.repoRoot,
            env: environment,
          }),
        ).rejects.toMatchObject({
          stderr: expect.stringContaining(message),
        });
        await expect(readFile(fixture.prepareLog, "utf8")).rejects.toThrow();
        await expect(readFile(fixture.buildLog, "utf8")).rejects.toThrow();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});

describe("Linux Windows OCR cross-build toolchain", () => {
  it.each([
    [
      "x86_64",
      "llvm-mingw-20260922-ucrt-ubuntu-22.04-x86_64.tar.xz",
      "bb7bb7654b33d5aa8712acb837c963b2e0c56352560c76105270a3268c665c21",
    ],
    [
      "aarch64",
      "llvm-mingw-20260922-ucrt-ubuntu-22.04-aarch64.tar.xz",
      "07d21263c56bfe9a713db6fdb3f7434bf4c121a005e40397d3b4c0170fb06769",
    ],
  ])(
    "selects the pinned %s-host LLVM-MinGW archive and host/target cache",
    async (hostArch, archive, checksum) => {
      const directory = await mkdtemp(path.join(tmpdir(), "epikrise-windows-ocr-"));
      const repoRoot = path.join(directory, "repo");
      const scriptsDir = path.join(repoRoot, "scripts");
      const binDir = path.join(directory, "bin");
      const cacheRoot = path.join(directory, "ocr-cache");
      const curlLog = path.join(directory, "curl.log");
      const scriptPath = path.join(scriptsDir, "build-windows-ocr.sh");
      const target = "x86_64-pc-windows-msvc";

      try {
        await Promise.all([
          mkdir(scriptsDir, { recursive: true }),
          mkdir(binDir, { recursive: true }),
        ]);
        await writeFile(
          scriptPath,
          await readFile(
            path.join(repoRootForTests(), "scripts/build-windows-ocr.sh"),
            "utf8",
          ),
          "utf8",
        );
        await writeMockUname(binDir, `${hostArch}-unknown-linux-gnu`);
        await writeExecutable(
          path.join(binDir, "rustc"),
          `#!/usr/bin/env bash\nprintf 'host: ${hostArch}-unknown-linux-gnu\\n'\n`,
        );
        await writeExecutable(
          path.join(binDir, "curl"),
          '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$CURL_LOG"\nexit 74\n',
        );
        const environment = clearCiEnvironment({
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          CURL_LOG: curlLog,
          EPIKRISE_ALLOW_LINUX_WINDOWS_CROSS_BUILD: "true",
          EPIKRISE_WINDOWS_CROSS_BUILD_PACKAGE: "nsis",
          EPIKRISE_WINDOWS_HOST_ARCH: hostArch,
          EPIKRISE_WINDOWS_OCR_CACHE: cacheRoot,
          EPIKRISE_OCR_BINARY_DIR: path.join(directory, "binaries"),
        });

        await expect(
          execFile("bash", [scriptPath, target], {
            cwd: repoRoot,
            env: environment,
          }),
        ).rejects.toMatchObject({ code: 1 });
        expect(await readFile(curlLog, "utf8")).toContain(archive);
        const source = await readFile(scriptPath, "utf8");
        expect(source).toContain(checksum);
        await expect(
          lstat(path.join(cacheRoot, `host-${hostArch}`, "build", target)),
        ).resolves.toBeDefined();
        await expect(lstat(path.join(cacheRoot, "build", target))).rejects.toThrow();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("patches zlib and Tesseract's Windows CMake conditions idempotently", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "epikrise-zlib-cmake-"));
    const zlibSource = path.join(directory, "zlib");
    const tesseractSource = path.join(directory, "tesseract");
    const zlibCmakeFile = path.join(zlibSource, "CMakeLists.txt");
    const tesseractCmakeFile = path.join(tesseractSource, "CMakeLists.txt");
    const patchScript = path.join(repoRoot, "scripts/patch-windows-ocr-cmake.sh");
    const buildScript = await readFile(
      path.join(repoRoot, "scripts/build-windows-ocr.sh"),
      "utf8",
    );
    const original = [
      "if(UNIX)",
      '  set_target_properties(zlib PROPERTIES LINK_FLAGS "-Wl,--version-script,zlib.map")',
      "endif()",
      "",
    ].join("\n");
    const patchedZlib = original.replace(
      "if(UNIX)",
      'if(UNIX AND NOT CMAKE_SYSTEM_NAME STREQUAL "Windows")',
    );
    const originalTesseract = [
      "elseif(UNIX)",
      "  set(LIB_pthread pthread)",
      "elseif(WIN32)",
      "  set(LIB_Ws2_32 Ws2_32)",
      "",
    ].join("\n");
    const patchedTesseract = originalTesseract.replace(
      "elseif(UNIX)",
      "elseif(UNIX AND NOT WIN32)",
    );

    try {
      await Promise.all([
        mkdir(zlibSource, { recursive: true }),
        mkdir(tesseractSource, { recursive: true }),
      ]);
      expect(buildScript).toContain(
        'bash "$repo_root/scripts/patch-windows-ocr-cmake.sh" "$zlib_source" "$tesseract_source"',
      );
      await Promise.all([
        writeFile(zlibCmakeFile, original, "utf8"),
        writeFile(tesseractCmakeFile, originalTesseract, "utf8"),
      ]);

      await execFile("bash", [patchScript, zlibSource, tesseractSource]);
      await expect(readFile(zlibCmakeFile, "utf8")).resolves.toBe(patchedZlib);
      await expect(readFile(tesseractCmakeFile, "utf8")).resolves.toBe(
        patchedTesseract,
      );

      await execFile("bash", [patchScript, zlibSource, tesseractSource]);
      await expect(readFile(zlibCmakeFile, "utf8")).resolves.toBe(patchedZlib);
      await expect(readFile(tesseractCmakeFile, "utf8")).resolves.toBe(
        patchedTesseract,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails when zlib's expected platform condition changes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "epikrise-zlib-cmake-"));
    const zlibSource = path.join(directory, "zlib");
    const tesseractSource = path.join(directory, "tesseract");
    const patchScript = path.join(repoRoot, "scripts/patch-windows-ocr-cmake.sh");

    try {
      await Promise.all([
        mkdir(zlibSource, { recursive: true }),
        mkdir(tesseractSource, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(
          path.join(zlibSource, "CMakeLists.txt"),
          "if(UNIX)\nif(UNIX)\n",
          "utf8",
        ),
        writeFile(
          path.join(tesseractSource, "CMakeLists.txt"),
          "elseif(UNIX)\n",
          "utf8",
        ),
      ]);

      await expect(
        execFile("bash", [patchScript, zlibSource, tesseractSource]),
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("Unexpected zlib CMake platform condition"),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not enter the cross-builder from CI or without manual NSIS context", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "epikrise-windows-ocr-guard-"));
    const scriptsDir = path.join(directory, "scripts");
    const binDir = path.join(directory, "bin");
    const curlLog = path.join(directory, "curl.log");
    const scriptPath = path.join(scriptsDir, "build-windows-ocr.sh");

    try {
      await Promise.all([
        mkdir(scriptsDir, { recursive: true }),
        mkdir(binDir, { recursive: true }),
      ]);
      await writeFile(
        scriptPath,
        await readFile(
          path.join(repoRootForTests(), "scripts/build-windows-ocr.sh"),
          "utf8",
        ),
        "utf8",
      );
      await writeMockUname(binDir, "x86_64-unknown-linux-gnu");
      await writeExecutable(
        path.join(binDir, "rustc"),
        "#!/usr/bin/env bash\nprintf 'host: x86_64-unknown-linux-gnu\\n'\n",
      );
      await writeExecutable(
        path.join(binDir, "curl"),
        '#!/usr/bin/env bash\nprintf "called\\n" >> "$CURL_LOG"\n',
      );
      const baseEnvironment = clearCiEnvironment({
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        CURL_LOG: curlLog,
        EPIKRISE_WINDOWS_OCR_CACHE: path.join(directory, "cache"),
      });
      const contextEnvironment = {
        ...baseEnvironment,
        EPIKRISE_ALLOW_LINUX_WINDOWS_CROSS_BUILD: "true",
        EPIKRISE_WINDOWS_CROSS_BUILD_PACKAGE: "nsis",
        EPIKRISE_WINDOWS_HOST_ARCH: "x86_64",
      };

      await expect(
        execFile("bash", [scriptPath, "x86_64-pc-windows-msvc"], {
          cwd: directory,
          env: baseEnvironment,
        }),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("explicitly opted-in manual NSIS build"),
      });
      await expect(
        execFile("bash", [scriptPath, "x86_64-pc-windows-msvc"], {
          cwd: directory,
          env: { ...contextEnvironment, GITHUB_ACTIONS: "true" },
        }),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("cannot run in CI"),
      });
      await expect(readFile(curlLog, "utf8")).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["yes", "YES", "On", "tRuE", "1"])(
    "rejects CI=%s in the direct cross-builder before downloads",
    async (ciValue) => {
      const directory = await mkdtemp(path.join(tmpdir(), "epikrise-windows-ocr-ci-"));
      const scriptsDir = path.join(directory, "scripts");
      const binDir = path.join(directory, "bin");
      const curlLog = path.join(directory, "curl.log");
      const scriptPath = path.join(scriptsDir, "build-windows-ocr.sh");

      try {
        await Promise.all([
          mkdir(scriptsDir, { recursive: true }),
          mkdir(binDir, { recursive: true }),
        ]);
        await writeFile(
          scriptPath,
          await readFile(
            path.join(repoRootForTests(), "scripts/build-windows-ocr.sh"),
            "utf8",
          ),
          "utf8",
        );
        await writeMockUname(binDir, "x86_64-unknown-linux-gnu");
        await writeExecutable(
          path.join(binDir, "rustc"),
          "#!/usr/bin/env bash\nprintf 'host: x86_64-unknown-linux-gnu\\n'\n",
        );
        await writeExecutable(
          path.join(binDir, "curl"),
          '#!/usr/bin/env bash\nprintf "called\\n" >> "$CURL_LOG"\n',
        );

        const environment = clearCiEnvironment({
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          CURL_LOG: curlLog,
          EPIKRISE_ALLOW_LINUX_WINDOWS_CROSS_BUILD: "true",
          EPIKRISE_WINDOWS_CROSS_BUILD_PACKAGE: "nsis",
          EPIKRISE_WINDOWS_HOST_ARCH: "x86_64",
        });
        environment.CI = ciValue;
        await expect(
          execFile("bash", [scriptPath, "x86_64-pc-windows-msvc"], {
            cwd: directory,
            env: environment,
          }),
        ).rejects.toMatchObject({
          stderr: expect.stringContaining("cannot run in CI"),
        });
        await expect(readFile(curlLog, "utf8")).rejects.toThrow();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
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
        packageFamily: "desktop",
        nativeBuild: nativeBuildEvidence(target),
        sourceArchiveSha256: "b".repeat(64),
        cacheKey: `synthetic-${commit}`,
        cacheRestored: false,
      });

      expect(manifest).toMatchObject({
        schema_version: 3,
        request_id: requestId,
        commit,
        target,
        package_family: "desktop",
        native_build: {
          runner_os: "Linux",
          runner_arch: "X64",
          rust_host: target,
          target,
          build_mode: "diagnostic",
        },
        source: {
          commit,
          archive_sha256: "b".repeat(64),
        },
        cache: {
          key: `synthetic-${commit}`,
          restored: false,
        },
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

  it("stages Store MSIX separately with target-bound integrity evidence", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "epikrise-store-msix-stage-"));
    const bundleRoot = path.join(directory, "msix");
    const stageRoot = path.join(directory, "stage");
    const target = "aarch64-pc-windows-msvc";

    try {
      await mkdir(bundleRoot, { recursive: true });
      await writeFile(path.join(bundleRoot, "epikrise-arm64.msix"), "unsigned-msix");
      const manifest = await stagePackages({
        target,
        commit,
        requestId,
        bundleRoot,
        stageRoot,
        packageFamily: "store-msix",
        nativeBuild: nativeBuildEvidence(target),
        sourceArchiveSha256: "b".repeat(64),
        cacheKey: `synthetic-${commit}`,
        cacheRestored: false,
      });

      expect(manifest).toMatchObject({
        package_family: "store-msix",
        target,
        native_build: {
          runner_arch: "ARM64",
          rust_host: target,
          target,
        },
        files: [
          {
            path: "files/epikrise-arm64.msix",
            sha256: createHash("sha256").update("unsigned-msix").digest("hex"),
          },
        ],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("stages and verifies standalone Store release assets for both architectures", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "epikrise-store-release-assets-"),
    );
    const version = JSON.parse(
      await readFile(path.join(repoRoot, "package.json"), "utf8"),
    ).version;
    const msixVersion = deriveReleaseVersions(version).msixIdentityVersion;
    const targets = [
      {
        architecture: "x64",
        target: "x86_64-pc-windows-msvc",
        content: "unsigned-x64-msix",
      },
      {
        architecture: "arm64",
        target: "aarch64-pc-windows-msvc",
        content: "unsigned-arm64-msix",
      },
    ] as const;
    const artifactRoots = {
      x64: path.join(directory, "epikrise-store-msix-x64"),
      arm64: path.join(directory, "epikrise-store-msix-arm64"),
    };
    const outputRoot = path.join(directory, "release-assets");

    try {
      for (const target of targets) {
        const bundleRoot = path.join(directory, `${target.architecture}-bundle`);
        await mkdir(bundleRoot, { recursive: true });
        await writeFile(
          path.join(bundleRoot, `Epikrise_${msixVersion}_${target.architecture}.msix`),
          target.content,
        );
        await stagePackages({
          target: target.target,
          commit,
          requestId,
          bundleRoot,
          stageRoot: artifactRoots[target.architecture],
          packageFamily: "store-msix",
          nativeBuild: nativeBuildEvidence(target.target),
          sourceArchiveSha256: "b".repeat(64),
          cacheKey: `synthetic-${commit}`,
          cacheRestored: false,
        });
      }

      await stageStoreReleaseAssets({
        x64Root: artifactRoots.x64,
        arm64Root: artifactRoots.arm64,
        outputRoot,
        tag: `v${version}`,
        commit,
        requestId,
      });
      await expect(readdir(outputRoot)).resolves.toEqual(
        expect.arrayContaining([
          `Epikrise_${msixVersion}_x64.msix`,
          `Epikrise_${msixVersion}_x64.msix.manifest.json`,
          `Epikrise_${msixVersion}_arm64.msix`,
          `Epikrise_${msixVersion}_arm64.msix.manifest.json`,
        ]),
      );

      const manifest = JSON.parse(
        await readFile(
          path.join(outputRoot, `Epikrise_${msixVersion}_x64.msix.manifest.json`),
          "utf8",
        ),
      );
      expect(manifest).toMatchObject({
        tag: `v${version}`,
        commit,
        architecture: "x64",
        package: {
          file: `Epikrise_${msixVersion}_x64.msix`,
          sha256: createHash("sha256").update("unsigned-x64-msix").digest("hex"),
        },
        artifact_manifest: {
          package_family: "store-msix",
          files: [{ path: `Epikrise_${msixVersion}_x64.msix` }],
        },
      });
      await expect(
        verifyStoreReleaseAssets(outputRoot, {
          tag: `v${version}`,
          commit,
          requestId,
        }),
      ).resolves.toBeUndefined();

      const manifestPath = path.join(
        outputRoot,
        `Epikrise_${msixVersion}_x64.msix.manifest.json`,
      );
      const originalManifest = await readFile(manifestPath, "utf8");
      const releaseManifest = JSON.parse(originalManifest);
      for (const nativeBuild of [
        {
          ...releaseManifest.artifact_manifest.native_build,
          target: "aarch64-pc-windows-msvc",
        },
        {
          ...releaseManifest.artifact_manifest.native_build,
          build_mode: "signed-release",
        },
      ]) {
        await writeFile(
          manifestPath,
          JSON.stringify({
            ...releaseManifest,
            artifact_manifest: {
              ...releaseManifest.artifact_manifest,
              native_build: nativeBuild,
            },
          }),
        );
        await expect(
          verifyStoreReleaseAssets(outputRoot, {
            tag: `v${version}`,
            commit,
            requestId,
          }),
        ).rejects.toThrow("native build evidence does not match the diagnostic target");
      }
      await writeFile(manifestPath, originalManifest);

      await writeFile(
        path.join(outputRoot, `Epikrise_${msixVersion}_x64.msix`),
        "tampered-x64-msix",
      );
      await expect(
        verifyStoreReleaseAssets(outputRoot, {
          tag: `v${version}`,
          commit,
          requestId,
        }),
      ).rejects.toThrow("SHA-256 verification failed");
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
            schema_version: 3,
            request_id: requestId,
            commit,
            ...syntheticBuildProvenance(commit),
            target,
            package_family: "desktop",
            native_build: {
              runner_os: nativeBuildEvidence(target).runnerOS,
              runner_arch: nativeBuildEvidence(target).runnerArch,
              rust_host: target,
              target,
              build_mode: "diagnostic",
            },
            version,
            signed: false,
            files,
          }),
        );

        if (target.endsWith("-pc-windows-msvc")) {
          const storeDirectory = path.join(directory, `${target}-store-msix`);
          const storeFilesDirectory = path.join(storeDirectory, "files");
          const contents = `synthetic ${target} msix`;
          const fileName = `${target}.msix`;
          await mkdir(storeFilesDirectory, { recursive: true });
          await writeFile(path.join(storeFilesDirectory, fileName), contents);
          await writeFile(
            path.join(storeDirectory, "manifest.json"),
            JSON.stringify({
              schema_version: 3,
              request_id: requestId,
              commit,
              ...syntheticBuildProvenance(commit),
              target,
              package_family: "store-msix",
              native_build: {
                runner_os: "Windows",
                runner_arch: target.startsWith("aarch64-") ? "ARM64" : "X64",
                rust_host: target,
                target,
                build_mode: "diagnostic",
              },
              version,
              signed: false,
              files: [
                {
                  path: `files/${fileName}`,
                  size_bytes: Buffer.byteLength(contents),
                  sha256: createHash("sha256").update(contents).digest("hex"),
                },
              ],
            }),
          );
        }
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
        source: { commit: string; archive_sha256: string };
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

      await writeFile(
        firstManifestPath,
        JSON.stringify({
          ...firstManifest,
          source: { ...firstManifest.source, archive_sha256: "invalid" },
        }),
      );
      await expect(verifyArtifactSet(directory, expected)).rejects.toThrow(
        "Source evidence is invalid",
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
      await rm(path.join(directory, desktopTargets[0], "files", "extra.txt"));

      const storeDirectory = path.join(directory, "x86_64-pc-windows-msvc-store-msix");
      const storeManifestPath = path.join(storeDirectory, "manifest.json");
      const storeManifest = JSON.parse(await readFile(storeManifestPath, "utf8"));
      const storePackagePath = path.join(
        storeDirectory,
        "files",
        "x86_64-pc-windows-msvc.msix",
      );
      const storeContents = "synthetic x86_64-pc-windows-msvc msix";
      await writeFile(
        storePackagePath,
        storeContents.replace("synthetic", "tamperedd"),
      );
      await expect(verifyArtifactSet(directory, expected)).rejects.toThrow(
        "SHA-256 verification failed",
      );
      await writeFile(storePackagePath, storeContents);

      await writeFile(
        storeManifestPath,
        JSON.stringify({
          ...storeManifest,
          target: "aarch64-pc-windows-msvc",
        }),
      );
      await expect(verifyArtifactSet(directory, expected)).rejects.toThrow(
        "Artifact target does not match its download slot",
      );
      await writeFile(storeManifestPath, JSON.stringify(storeManifest));

      await rm(path.join(directory, "x86_64-pc-windows-msvc-store-msix"), {
        recursive: true,
      });
      await expect(verifyArtifactSet(directory, expected)).rejects.toThrow();
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
    expect(workflow).toContain("ref: ${{ inputs.expected_sha }}");
    expect(workflow).toContain("EPIKRISE_RUNNER_ARCH: ${{ runner.arch }}");
    expect(workflow).toContain("EPIKRISE_RUNNER_OS: ${{ runner.os }}");
    expect(workflow).toContain("EPIKRISE_NATIVE_BUILD_TARGET: ${{ matrix.target }}");
    expect(workflow).toContain("EPIKRISE_BUILD_MODE: diagnostic");
    expect(workflow).toContain(
      'pnpm tauri build --target "$TARGET" --bundles "${bundles[@]}" --no-sign',
    );
    expect(workflow).not.toContain("pnpm exec tauri build");
    expect(workflow).toContain(
      "src-tauri/target/host-$host_target/$TARGET/release/bundle",
    );
    expect(workflow).toContain("windows-2025");
    expect(workflow).toContain("windows-11-vs2026-arm");
    expect(workflow).toContain("build-native-windows.cmd");
    expect(workflow).not.toContain("~/.cache/epikrise/windows\n");
    expect(workflow).toContain("actions/upload-artifact@v7");
    expect(workflow).toContain("${{ runner.arch }}");
    expect(workflow).toContain("ubuntu-22.04-arm");
    expect(workflow).toContain("ubuntu-22.04");
    expect(workflow).toContain("macos-15-intel");
    expect(workflow).toContain("macos-15");
    for (const target of desktopTargets) expect(workflow).toContain(target);
    const rustToolchainStep = workflow.indexOf("uses: dtolnay/rust-toolchain@stable");
    const nativeGuardStep = workflow.indexOf(
      "- name: Verify native build host and target",
    );
    const cacheStep = workflow.indexOf("- name: Cache native OCR and Cargo inputs");
    const dependencyInstallStep = workflow.indexOf("- name: Install dependencies");
    const nativeDependencySetupStep = workflow.indexOf(
      "- name: Install Linux build dependencies",
    );
    expect(nativeGuardStep).toBeGreaterThan(rustToolchainStep);
    expect(nativeGuardStep).toBeGreaterThan(cacheStep);
    expect(nativeGuardStep).toBeGreaterThan(dependencyInstallStep);
    expect(nativeGuardStep).toBeLessThan(nativeDependencySetupStep);
    expect(workflow).not.toContain("cargo-xwin");
    expect(workflow).not.toContain("EPIKRISE_ALLOW_LINUX_WINDOWS_CROSS_BUILD");
    const windowsBuildStep = workflow.indexOf("- name: Build Windows installer");
    const verifyOcrStep = workflow.indexOf("- name: Verify staged OCR architectures");
    expect(windowsBuildStep).toBeGreaterThanOrEqual(0);
    expect(verifyOcrStep).toBeGreaterThan(windowsBuildStep);
    expect(workflow).toContain("scripts/tauri-build-output.sh");
    expect(workflow).toContain("verify-binary-architecture.mjs");
    expect(workflow).toContain("x86_64-pc-windows-msvc|aarch64-pc-windows-msvc)");
    expect(workflow).toContain("--package-family desktop");
    expect(workflow).toContain("--package-family store-msix");
    expect(workflow).toContain("Stage Store MSIX with integrity manifest");
    expect(workflow).toContain("artifact-staging/store-msix-artifact/");
    expect(workflow).toContain("epikrise-store-msix-${{ matrix.windows_arch }}");
    expect(workflow).toContain('--runner-os "$RUNNER_OS"');
    expect(workflow).toContain('--runner-arch "$RUNNER_ARCH"');
    expect(workflow).toContain('--rust-host "$host_target"');
    expect(workflow).toMatch(
      /Create unsigned Store MSIX[\s\S]*Stage Store MSIX with integrity manifest[\s\S]*epikrise-store-msix-/,
    );
  });

  it("checks Visual Studio paths outside parenthesized CMD blocks", async () => {
    const buildScript = await readFile(
      path.join(repoRoot, "scripts/build-native-windows.cmd"),
      "utf8",
    );
    expect(buildScript).toContain('if exist "%vswhere%" goto vswhere_found');
    expect(buildScript).toContain(
      'set "vs_component=Microsoft.VisualStudio.Component.VC.Tools.x86.x64"',
    );
    expect(buildScript).toContain(
      'set "vs_component=Microsoft.VisualStudio.Component.VC.Tools.ARM64"',
    );
    expect(buildScript).toContain(
      '"%vswhere%" -latest -products * -requires %vs_component% -property installationPath',
    );
    expect(buildScript).toContain('if exist "%vcvarsall%" goto vcvarsall_found');
    expect(buildScript).not.toContain('set "EPIKRISE_RUNNER_ARCH=');
    expect(buildScript).toContain(
      'where.exe /r "%VSINSTALLDIR%\\VC\\Tools\\MSVC" link.exe 2>nul | findstr /i /c:"\\Host%VSCMD_ARG_HOST_ARCH%\\%VSCMD_ARG_TGT_ARCH%\\link.exe"',
    );
    expect(buildScript).toContain(
      'set "CARGO_TARGET_AARCH64_PC_WINDOWS_MSVC_LINKER=%EPIKRISE_MSVC_LINK_EXE%"',
    );
    expect(buildScript).toContain(
      'set "vs_cmake_bin=%VSINSTALLDIR%\\Common7\\IDE\\CommonExtensions\\Microsoft\\CMake\\CMake\\bin"',
    );
    expect(buildScript).toContain('set "PATH=%vs_cmake_bin%;%PATH%"');
    expect(buildScript).toContain("where.exe cmake.exe >nul 2>&1");
    expect(buildScript).toContain(
      'set "INCLUDE=%msvc_toolset_dir%\\include;%INCLUDE%"',
    );
    expect(buildScript).toContain(
      'set "LIB=%msvc_toolset_dir%\\lib\\%windows_arch%;%LIB%"',
    );
    expect(buildScript).toContain('where.exe clang.exe > "%clang_file%" 2>nul');
    expect(buildScript).toContain(
      'where.exe /r "%VSINSTALLDIR%\\VC\\Tools\\Llvm" clang.exe > "%clang_file%" 2>nul',
    );
    const clangArchitectureCheck = buildScript.indexOf(
      "node scripts\\verify-binary-architecture.mjs aarch64-pc-windows-msvc",
    );
    expect(clangArchitectureCheck).toBeGreaterThan(buildScript.indexOf(":clang_found"));
    expect(clangArchitectureCheck).toBeLessThan(
      buildScript.indexOf('set "PATH=%clang_bin%;%PATH%"'),
    );
    expect(buildScript).toContain("Clang is required to build ring for Windows ARM64.");
    expect(buildScript).toContain(
      "Clang must be an ARM64 executable for native Windows ARM64 builds:",
    );
    expect(buildScript).toContain(
      'where.exe /r "%VSINSTALLDIR%\\VC\\Tools\\MSVC" cl.exe 2>nul | findstr /i /c:"\\Host%VSCMD_ARG_HOST_ARCH%\\%VSCMD_ARG_TGT_ARCH%\\cl.exe"',
    );
    expect(buildScript).toContain('set /p "EPIKRISE_MSVC_CL_EXE="<"%msvc_cl_file%"');
    expect(buildScript).toContain("if defined EPIKRISE_MSVC_CL_EXE goto msvc_cl_found");
    expect(buildScript).toContain('set "MSYS2_ENV_CONV_EXCL=INCLUDE=;LIB=;LIBPATH="');
    expect(buildScript).toContain('node scripts\\git-bash.mjs > "%git_bash_output%"');
    expect(buildScript).toContain(
      'call "%EPIKRISE_GIT_BASH_EXE%" scripts/build-native-windows.sh "%windows_arch%" "%build_mode%"',
    );
    expect(buildScript).toContain('set "EPIKRISE_NATIVE_WINDOWS_ENV_INITIALIZED=1"');
    expect(buildScript).toContain('if /I "%build_mode%"=="tauri" goto tauri_launcher');
    expect(buildScript).toContain("node scripts\\tauri.mjs --run-with-msvc-env");
    expect(buildScript).not.toContain("call bash scripts/build-native-windows.sh");
    expect(buildScript).not.toMatch(/if\s+not exist\s+"%(?:vswhere|vcvarsall)%"\s*\(/i);

    const tauriScript = await readFile(path.join(repoRoot, "scripts/tauri.sh"), "utf8");
    expect(tauriScript).toContain("native_guard_args=(--native-only --tauri-cli)");
    expect(tauriScript).toContain("native_guard_args=(--native-only --tauri-build)");
    expect(tauriScript).toContain("native_guard_args=(--native-only --tauri-dev)");
    expect(tauriScript.match(/\$\{native_guard_args\[@\]\}/g)).toHaveLength(2);

    const ocrBuildScript = await readFile(
      path.join(repoRoot, "scripts/build-native-windows-ocr.sh"),
      "utf8",
    );
    expect(ocrBuildScript).toContain('msvc_include_dir="$msvc_toolset_dir/include"');
    expect(ocrBuildScript).toContain('"$msvc_include_dir/vcruntime.h"');
    expect(ocrBuildScript).toContain(
      'INCLUDE="$msvc_include_dir_windows${INCLUDE:+;$INCLUDE}"',
    );
    expect(ocrBuildScript).toContain('-DCMAKE_C_COMPILER="$msvc_cl_cmake"');
    expect(ocrBuildScript).toContain('-DCMAKE_CXX_COMPILER="$msvc_cl_cmake"');
  });

  it("uses a lower-memory release profile for native Windows diagnostic builds", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "epikrise-windows-diagnostic-"),
    );
    const binDir = path.join(directory, "bin");
    const buildLog = path.join(directory, "build.log");

    try {
      await mkdir(binDir);
      await writeExecutable(
        path.join(binDir, "pnpm"),
        '#!/usr/bin/env bash\nprintf "%s\\n" "$CARGO_PROFILE_RELEASE_CODEGEN_UNITS" "$CARGO_PROFILE_RELEASE_LTO" "$CARGO_PROFILE_RELEASE_OPT_LEVEL" "$*" > "$BUILD_LOG"\n',
      );

      await execFile(
        "bash",
        ["scripts/build-native-windows.sh", "arm64", "diagnostic"],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
            BUILD_LOG: buildLog,
          },
        },
      );

      expect((await readFile(buildLog, "utf8")).trimEnd().split(/\r?\n/)).toEqual([
        "16",
        "false",
        "2",
        "tauri build --target aarch64-pc-windows-msvc",
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("signed release artifacts", () => {
  const targetSuffixes: Record<string, string[]> = {
    "x86_64-unknown-linux-gnu": [".deb", ".rpm", ".AppImage", ".AppImage.sig"],
    "aarch64-unknown-linux-gnu": [".deb", ".rpm", ".AppImage", ".AppImage.sig"],
    "x86_64-apple-darwin": [".dmg", ".app.tar.gz", ".app.tar.gz.sig"],
    "aarch64-apple-darwin": [".dmg", ".app.tar.gz", ".app.tar.gz.sig"],
    "x86_64-pc-windows-msvc": [
      "-offline.exe",
      "-offline.exe.sig",
      "-bootstrapper.exe",
      "-bootstrapper.exe.sig",
    ],
    "aarch64-pc-windows-msvc": [
      "-offline.exe",
      "-offline.exe.sig",
      "-bootstrapper.exe",
      "-bootstrapper.exe.sig",
    ],
  };
  const releaseCommit = "0123456789abcdef0123456789abcdef01234567";

  async function createOcrFixture(root: string, target: string) {
    const nativeTarget = nativeBuildEvidence(target).target;
    const resourceRoot = path.join(root, "resources", "ocr");
    const binaryRoot = path.join(root, "binaries");
    const pdfiumName = nativeTarget.includes("apple-darwin")
      ? "libpdfium.dylib"
      : nativeTarget.includes("windows-msvc")
        ? "pdfium.dll"
        : "libpdfium.so";
    const tesseractName = nativeTarget.includes("windows-msvc")
      ? `tesseract-${nativeTarget}.exe`
      : `tesseract-${nativeTarget}`;

    await mkdir(path.join(resourceRoot, "pdfium"), { recursive: true });
    await mkdir(path.join(resourceRoot, "tessdata"), { recursive: true });
    await mkdir(binaryRoot, { recursive: true });
    await writeFile(
      path.join(resourceRoot, "pdfium", pdfiumName),
      `pdfium-${nativeTarget}`,
    );
    await writeFile(
      path.join(resourceRoot, "tessdata", "deu.traineddata"),
      `deu-${nativeTarget}`,
    );
    await writeFile(
      path.join(resourceRoot, "tessdata", "eng.traineddata"),
      `eng-${nativeTarget}`,
    );
    await writeFile(path.join(binaryRoot, tesseractName), `tesseract-${nativeTarget}`);
    return { resourceRoot, binaryRoot };
  }

  it("requires an unpadded tag to match the package version", () => {
    expect(validateReleaseTag("v2026.9.4", "2026.9.4")).toEqual({
      tag: "v2026.9.4",
      releaseVersion: "2026.9.4",
      updateProtocolVersion: "2026.9.4",
    });
    expect(() => validateReleaseTag("v2026.09.4", "2026.9.4")).toThrow("vYYYY.M.MICRO");
    expect(() => validateReleaseTag("v2026.9.4", "2026.9.3")).toThrow(
      "match package.json",
    );
  });

  it("promotes only releases that are not older than the current latest", () => {
    expect(shouldPromoteLatest("v2026.10.0", undefined)).toBe(true);
    expect(shouldPromoteLatest("v2026.10.0", "v2026.9.99")).toBe(true);
    expect(shouldPromoteLatest("v2027.1.0", "v2026.12.99")).toBe(true);
    expect(shouldPromoteLatest("v2026.9.4", "v2026.9.4")).toBe(true);
    expect(shouldPromoteLatest("v2026.9.3", "v2026.9.4")).toBe(false);
    expect(() => shouldPromoteLatest("v2026.09.4", "v2026.9.4")).toThrow(
      "not unpadded CalVer",
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
      assertRecoverableReleaseDraft({ ...release, tagName: "v2026.9.4" }, tag, commit),
    ).toThrow("Existing draft tag does not match.");
    expect(() =>
      assertRecoverableReleaseDraft(
        { ...release, body: "<!-- epikrise-signed-release-commit:other -->" },
        tag,
        commit,
      ),
    ).toThrow("Existing draft was not created for this commit.");
  });

  it("runs feature-gated updater tests in Rust CI", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(repoRoot, "package.json"), "utf8"),
    );
    const rustWorkflow = await readFile(
      path.join(repoRoot, ".github/workflows/rust-tests.yml"),
      "utf8",
    );

    expect(rustWorkflow).toMatch(/^[ \t]+run: pnpm test:rust[ \t]*$/m);
    expect(packageJson.scripts["test:rust"]).toContain("pnpm test:rust:updater");
    expect(packageJson.scripts["test:rust:updater"]).toContain(
      "--features direct-release-updater updater::tests",
    );
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
    expect(releaseWorkflow).toContain("EPIKRISE_RUNNER_OS: ${{ runner.os }}");
    expect(releaseWorkflow).toContain("EPIKRISE_RUNNER_ARCH: ${{ runner.arch }}");
    expect(releaseWorkflow).toContain(
      "EPIKRISE_NATIVE_BUILD_TARGET: ${{ matrix.target }}",
    );
    expect(releaseWorkflow).toContain("EPIKRISE_BUILD_MODE: signed-release");
    expect(releaseWorkflow).toContain("EPIKRISE_SOURCE_ARCHIVE_SHA256");
    expect(releaseWorkflow).toContain("EPIKRISE_NATIVE_CACHE_KEY");
    expect(releaseWorkflow).toContain("EPIKRISE_WINDOWS_CACHE_KEY");
    expect(releaseWorkflow).toContain('--cache-restored "$cache_restored"');
    expect(diagnosticWorkflow).toContain("Capture cache restore details");
    expect(diagnosticWorkflow).toContain("EPIKRISE_SOURCE_ARCHIVE_SHA256");
    expect(diagnosticWorkflow).toContain(
      '--source-archive-sha256 "$EPIKRISE_SOURCE_ARCHIVE_SHA256"',
    );
    expect(diagnosticWorkflow).toContain('--cache-restored "$EPIKRISE_CACHE_RESTORED"');
    const rustToolchainStep = releaseWorkflow.indexOf(
      "uses: dtolnay/rust-toolchain@stable",
    );
    const nativeGuardStep = releaseWorkflow.indexOf(
      "- name: Verify native build host and target",
    );
    const sourceInstallStep = releaseWorkflow.indexOf("- name: Install source tooling");
    const workspaceSetupStep = releaseWorkflow.indexOf(
      "- name: Prepare normalized release workspace",
    );
    expect(nativeGuardStep).toBeGreaterThan(rustToolchainStep);
    expect(nativeGuardStep).toBeGreaterThan(sourceInstallStep);
    expect(nativeGuardStep).toBeLessThan(workspaceSetupStep);
    expect(releaseWorkflow).toContain("--native-only --tauri-build");
    expect(releaseWorkflow).not.toContain("cargo-xwin");
    expect(releaseWorkflow).not.toContain("EPIKRISE_ALLOW_LINUX_WINDOWS_CROSS_BUILD");
    expect(releaseWorkflow).toMatch(
      /build:\s+needs:\s+- validate\s+- verify-ui\s+- verify-rust\s+- verify-playwright\s+- verify-security\s+- verify-quality/,
    );
    expect(qualityWorkflow).toContain(
      "run: pnpm lint && pnpm format:check && pnpm build",
    );
    expect(qualityWorkflow).toMatch(/pull_request:\s+branches:\s+\[main\]/);
    expect(qualityWorkflow).toMatch(
      /push:\s+branches:\s+\[main, development, documentation\]/,
    );
    for (const workflow of qualityWorkflows) {
      const workflowSource = await readFile(
        path.join(repoRoot, ".github/workflows", workflow),
        "utf8",
      );
      expect(releaseWorkflow).toContain(`uses: ./.github/workflows/${workflow}`);
      expect(workflowSource).toContain("workflow_call:");
      expect(workflowSource).toContain("ref: ${{ github.sha }}");
      expect(workflowSource).toMatch(/pull_request:\s+branches:\s+\[main\]/);
      if (workflow === "quality-checks.yml") {
        expect(workflowSource).toMatch(
          /push:\s+branches:\s+\[main, development, documentation\]/,
        );
      } else {
        expect(workflowSource).toMatch(/push:\s+branches:\s+\[main, development\]/);
      }
    }
    expect(releaseWorkflow).toContain(
      "TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}",
    );
    expect(releaseWorkflow).toContain("environment: release");
    const stageJobStart = releaseWorkflow.indexOf("\n  stage:");
    const approveJobStart = releaseWorkflow.indexOf("\n  approve:");
    const publishJobStart = releaseWorkflow.indexOf("\n  publish:");
    expect(stageJobStart).toBeGreaterThan(-1);
    expect(approveJobStart).toBeGreaterThan(stageJobStart);
    expect(publishJobStart).toBeGreaterThan(stageJobStart);
    expect(publishJobStart).toBeGreaterThan(approveJobStart);
    const stageJob = releaseWorkflow.slice(stageJobStart, approveJobStart);
    const approveJob = releaseWorkflow.slice(approveJobStart, publishJobStart);
    const publishJob = releaseWorkflow.slice(publishJobStart);
    expect(stageJob).toContain("needs: build");
    expect(stageJob).toContain("Create or recover draft and verify release assets");
    expect(stageJob).toContain("verify-uploaded");
    expect(stageJob).not.toContain("-F draft=false");
    expect(stageJob).toContain("asset-evidence");
    expect(stageJob).toContain("name: acceptance-evidence-${{ github.run_id }}");
    expect(stageJob).toContain("overwrite: true");
    expect(approveJob).toContain("needs: stage");
    expect(approveJob).toContain("environment:\n      name: release");
    expect(approveJob).not.toContain("concurrency:");
    expect(publishJob).toContain("needs: [stage, approve]");
    expect(publishJob).not.toContain("environment:");
    expect(publishJob).toContain("validate-draft");
    expect(publishJob).toContain("actions/download-artifact@v8");
    expect(publishJob).toContain("name: acceptance-evidence-${{ github.run_id }}");
    expect(publishJob).toContain(
      "--evidence-file release-evidence/release-assets.json",
    );
    expect(publishJob.indexOf("--evidence-file")).toBeLessThan(
      publishJob.indexOf("-F draft=false"),
    );
    expect(publishJob).toContain("-F draft=false");
    expect(releaseWorkflow).toContain("group: updater-release-${{ github.ref_name }}");
    expect(publishJob).toMatch(
      /concurrency:\s+group: updater-release\s+queue: max\s+cancel-in-progress: false/,
    );
    expect(publishJob).toContain(
      'gh api "repos/$GITHUB_REPOSITORY/git/ref/tags/$GITHUB_REF_NAME"',
    );
    expect(publishJob).toContain('gh api "repos/$GITHUB_REPOSITORY/git/tags/$tag_sha"');
    expect(publishJob).toContain(
      '[[ "$tag_type" != "commit" || "$tag_sha" != "$GITHUB_SHA" ]]',
    );
    expect(publishJob.indexOf("Release tag no longer points")).toBeLessThan(
      publishJob.indexOf("-F draft=false"),
    );
    expect(releaseWorkflow).toContain("--bundles appimage");
    expect(releaseWorkflow).toContain("--bundles deb rpm");
    expect(releaseWorkflow).toContain('"features":[]');
    expect(releaseWorkflow).toMatch(/features":\[\]\}\}' \\\s*--bundles deb rpm/);
    expect(cargoManifest).toMatchObject({ features: { default: [] } });
    expect(tauriConfig.build.features ?? []).not.toContain("direct-release-updater");
    expect(releaseTauriConfig.plugins.updater.requireSignedVersion).toBe(true);
    expect(diagnosticWorkflow).not.toContain("tauri.release.conf.json");
    expect(diagnosticWorkflow).not.toContain("--features");
    expect(releaseWorkflow).toContain("release-bundles/nsis/offlineInstaller");
    expect(releaseWorkflow).toContain("embedBootstrapper");
    expect(releaseWorkflow).toContain("offlineInstaller");
    expect(releaseWorkflow).not.toContain("windows-x86_64-msi");
    expect(releaseWorkflow).not.toContain("windows-aarch64-msi");
    expect(releaseWorkflow).toContain("--draft");
    expect(releaseWorkflow).toContain("validate-draft");
    expect(releaseWorkflow).toContain("--clobber");
    expect(releaseWorkflow).toContain("epikrise-signed-release-commit:");
    expect(releaseWorkflow).toContain("Verify staged OCR architectures");
    expect(releaseWorkflow).toContain("scripts/tauri-build-output.sh");
    expect(releaseWorkflow).toContain("verify-runtime-dependencies.mjs");
    expect(releaseWorkflow).toContain('--runner-os "$RUNNER_OS"');
    expect(releaseWorkflow).toContain('--runner-arch "$RUNNER_ARCH"');
    expect(releaseWorkflow).toContain('--rust-host "$host_target"');
    expect(releaseWorkflow).toContain(
      "x86_64-pc-windows-msvc|aarch64-pc-windows-msvc)",
    );
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
    expect(releaseWorkflow).toContain("-F draft=false");
    expect(releaseWorkflow).toContain('--raw-field "make_latest=$make_latest"');
    expect(releaseWorkflow).not.toContain('-F "make_latest=$make_latest"');
    expect(releaseWorkflow).toContain("gh release download");
    expect(releaseWorkflow).toContain("verify-uploaded");
    expect(releaseWorkflow).toMatch(
      /verify-uploaded[\s\S]*should-promote-latest[\s\S]*gh api --method PATCH/,
    );
    expect(releaseWorkflow).not.toContain("--draft=false --latest");
    expect(releaseWorkflow).toContain("gh api --method PATCH");
    expect(releaseWorkflow).toContain("contents: write");
    expect(diagnosticWorkflow).toContain("contents: read");
    expect(diagnosticWorkflow).not.toContain("TAURI_SIGNING_PRIVATE_KEY");
    expect(diagnosticWorkflow).not.toContain("gh release create");
  });

  it("builds and attaches Store packages after successful tagged updater releases", async () => {
    const workflow = await readFile(
      path.join(repoRoot, ".github/workflows/store-submission.yml"),
      "utf8",
    );

    expect(workflow).toContain("workflow_run:");
    expect(workflow).toContain("- Signed updater release");
    expect(workflow).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(workflow).toContain(
      "startsWith(github.event.workflow_run.head_branch, 'v')",
    );
    expect(workflow).toContain("windows-2025");
    expect(workflow).toContain("windows-11-vs2026-arm");
    expect(workflow).toContain("x86_64-pc-windows-msvc");
    expect(workflow).toContain("aarch64-pc-windows-msvc");
    expect(workflow).not.toContain("x86_64-unknown-linux-gnu");
    expect(workflow).not.toContain("aarch64-unknown-linux-gnu");
    expect(workflow).not.toContain("desktop-builds.yml");
    expect(workflow).toContain("--package-family store-msix");
    expect(workflow).toContain("stage-store-release");
    expect(workflow).toContain("gh release upload");
    expect(workflow).toContain("verify-store-release");
    expect(workflow).toContain("release.body.includes(marker)");

    const buildJob = workflow.slice(
      workflow.indexOf("  build:"),
      workflow.indexOf("  publish:"),
    );
    expect(buildJob.indexOf("- name: Install source tooling")).toBeLessThan(
      buildJob.indexOf("- name: Validate release tag and commit"),
    );

    const publishJob = workflow.slice(workflow.indexOf("  publish:"));
    expect(publishJob).toContain("uses: pnpm/setup@v2");
    expect(publishJob).toContain("cache: pnpm");
    expect(publishJob.indexOf("run: pnpm install --frozen-lockfile")).toBeLessThan(
      publishJob.indexOf(
        "- name: Validate release and stage downloadable Store packages",
      ),
    );
  });

  it("stages all platform packages and builds a signed static updater manifest", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "epikrise-signed-release-"));
    const artifactsRoot = path.join(directory, "artifacts");
    const pubDate = "2026-10-03T12:00:00.000Z";

    try {
      for (const target of releaseTargets) {
        const isWindows = target.includes("windows-msvc");
        const bundleRoot = path.join(
          directory,
          "bundles",
          target,
          isWindows ? "offline" : "bundle",
        );
        await mkdir(bundleRoot, { recursive: true });
        const bootstrapperRoot = path.join(
          directory,
          "bundles",
          target,
          "bootstrapper",
        );
        if (isWindows) await mkdir(bootstrapperRoot, { recursive: true });
        const sourceSuffixes = isWindows
          ? [".exe", ".exe.sig"]
          : targetSuffixes[target];
        for (const suffix of sourceSuffixes) {
          await writeFile(
            path.join(bundleRoot, `epikrise${suffix}`),
            suffix.endsWith(".sig") ? `signature-${target}` : `bundle-${target}`,
          );
          if (isWindows) {
            await writeFile(
              path.join(bootstrapperRoot, `epikrise${suffix}`),
              suffix.endsWith(".sig")
                ? `bootstrapper-signature-${target}`
                : `bootstrapper-${target}`,
            );
          }
        }
        const { resourceRoot, binaryRoot } = await createOcrFixture(directory, target);
        await stageReleaseArtifacts({
          target,
          bundleRoot,
          ...(isWindows ? { bootstrapperRoot } : {}),
          stageRoot: path.join(artifactsRoot, `release-${target}`),
          commit: releaseCommit,
          version: "2026.9.4",
          resourceRoot,
          binaryRoot,
          nativeBuild: nativeBuildEvidence(target, "signed-release"),
          sourceArchiveSha256: "b".repeat(64),
          cacheKey: `synthetic-${target}-cache`,
          cacheRestored: false,
        });
      }

      const verifiedSignatures: string[] = [];
      const manifest = await createLatestManifest({
        tag: "v2026.9.4",
        packageVersion: "2026.9.4",
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
          url: expect.stringContaining("v2026.9.4/"),
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
        "windows-x86_64-nsis": {
          signature: "signature-x86_64-pc-windows-msvc",
          url: expect.stringContaining("windows-x86_64-nsis-offline.exe"),
        },
        "windows-aarch64-nsis": {
          signature: "signature-aarch64-pc-windows-msvc",
          url: expect.stringContaining("windows-aarch64-nsis-offline.exe"),
        },
      });
      expect(Object.keys(manifest.platforms)).toHaveLength(6);
      expect(verifiedSignatures).toHaveLength(6);
      const linuxIntegrityPath = path.join(
        artifactsRoot,
        `release-${releaseTargets[0]}`,
        `${releaseTargets[0]}-manifest.json`,
      );
      const linuxIntegrityContents = await readFile(linuxIntegrityPath, "utf8");
      const linuxIntegrity = JSON.parse(linuxIntegrityContents);
      expect(linuxIntegrity).toMatchObject({
        schema_version: 4,
        target: releaseTargets[0],
        architecture: "x86_64",
        architecture_verified: true,
        native_build: {
          runner_os: "Linux",
          runner_arch: "X64",
          rust_host: releaseTargets[0],
          target: releaseTargets[0],
          build_mode: "signed-release",
        },
        source: {
          commit: releaseCommit,
          archive_sha256: "b".repeat(64),
        },
        cache: {
          key: `synthetic-${releaseTargets[0]}-cache`,
          restored: false,
        },
        tool_versions: {
          rustc: expect.any(String),
          cargo: expect.any(String),
          node: expect.any(String),
          pnpm: expect.any(String),
          tauri_cli: expect.any(String),
        },
        commit: releaseCommit,
        version: "2026.9.4",
      });
      expect(linuxIntegrity.assets).toHaveLength(
        targetSuffixes[releaseTargets[0]].length,
      );
      expect(linuxIntegrity.resources).toHaveLength(4);
      await writeFile(
        linuxIntegrityPath,
        JSON.stringify({
          ...linuxIntegrity,
          cache: { ...linuxIntegrity.cache, restored: "false" },
        }),
      );
      await expect(
        createLatestManifest({
          tag: "v2026.9.4",
          packageVersion: "2026.9.4",
          repository: "owner/repo",
          artifactsRoot,
          commit: releaseCommit,
          pubDate,
          signatureVerifier: async () => {},
        }),
      ).rejects.toThrow("Cache evidence is invalid");
      await writeFile(linuxIntegrityPath, linuxIntegrityContents);
      await writeFile(
        linuxIntegrityPath,
        JSON.stringify({
          ...linuxIntegrity,
          native_build: {
            ...linuxIntegrity.native_build,
            runner_arch: "ARM64",
          },
        }),
      );
      await expect(
        createLatestManifest({
          tag: "v2026.9.4",
          packageVersion: "2026.9.4",
          repository: "owner/repo",
          artifactsRoot,
          commit: releaseCommit,
          pubDate,
          signatureVerifier: async () => {},
        }),
      ).rejects.toThrow("Actions runner architecture ARM64 does not match target");
      await writeFile(linuxIntegrityPath, linuxIntegrityContents);

      const windowsTarget = releaseTargets[4];
      const windowsIntegrityPath = path.join(
        artifactsRoot,
        `release-${windowsTarget}`,
        `${windowsTarget}-manifest.json`,
      );
      const windowsIntegrityContents = await readFile(windowsIntegrityPath, "utf8");
      const windowsIntegrity = JSON.parse(windowsIntegrityContents);
      expect(windowsIntegrity).toMatchObject({
        package_family: "nsis",
        webview_modes: {
          updater: "offlineInstaller",
          alternate: "embedBootstrapper",
        },
      });
      expect(
        windowsIntegrity.assets.map((asset: { path: string }) => asset.path).sort(),
      ).toEqual([
        "windows-x86_64-nsis-bootstrapper.exe",
        "windows-x86_64-nsis-bootstrapper.exe.sig",
        "windows-x86_64-nsis-offline.exe",
        "windows-x86_64-nsis-offline.exe.sig",
      ]);
      await writeFile(
        windowsIntegrityPath,
        JSON.stringify({ ...windowsIntegrity, package_family: "msi" }),
      );
      await expect(
        createLatestManifest({
          tag: "v2026.9.4",
          packageVersion: "2026.9.4",
          repository: "owner/repo",
          artifactsRoot,
          commit: releaseCommit,
          pubDate,
          signatureVerifier: async () => {},
        }),
      ).rejects.toThrow("Installer family does not match");
      await writeFile(
        windowsIntegrityPath,
        JSON.stringify({
          ...windowsIntegrity,
          webview_modes: {
            ...windowsIntegrity.webview_modes,
            updater: "embedBootstrapper",
          },
        }),
      );
      await expect(
        createLatestManifest({
          tag: "v2026.9.4",
          packageVersion: "2026.9.4",
          repository: "owner/repo",
          artifactsRoot,
          commit: releaseCommit,
          pubDate,
          signatureVerifier: async () => {},
        }),
      ).rejects.toThrow("WebView2 installer modes do not match");
      await writeFile(windowsIntegrityPath, windowsIntegrityContents);

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
      const releaseAssetEvidence = await createReleaseAssetEvidence({
        artifactsRoot,
        latestPath,
      });
      await expect(
        verifyUploadedReleaseAssets({
          uploadedRoot,
          releaseAssets,
        }),
      ).rejects.toThrow("Staged asset paths are required without persisted evidence.");
      await expect(
        verifyUploadedReleaseAssets({
          artifactsRoot,
          latestPath,
          uploadedRoot,
          releaseAssets,
        }),
      ).resolves.toBeUndefined();
      await expect(
        verifyUploadedReleaseAssets({
          uploadedRoot,
          releaseAssets,
          expectedAssets: releaseAssetEvidence,
        }),
      ).resolves.toBeUndefined();

      const uploadedBundleName = uploadedNames.find((name) =>
        name.endsWith(".AppImage"),
      );
      expect(uploadedBundleName).toBeDefined();
      const uploadedBundle = path.join(uploadedRoot, uploadedBundleName!);
      const uploadedContents = await readFile(uploadedBundle, "utf8");
      const tamperedContents = Buffer.from(uploadedContents);
      tamperedContents[0] = tamperedContents[0]! ^ 1;
      await writeFile(uploadedBundle, tamperedContents);
      expect((await lstat(uploadedBundle)).size).toBe(
        Buffer.byteLength(uploadedContents),
      );
      await expect(
        verifyUploadedReleaseAssets({
          uploadedRoot,
          releaseAssets,
          expectedAssets: releaseAssetEvidence,
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
          tag: "v2026.9.4",
          packageVersion: "2026.9.4",
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
          tag: "v2026.9.4",
          packageVersion: "2026.9.4",
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
          tag: "v2026.9.4",
          packageVersion: "2026.9.4",
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
          tag: "v2026.9.4",
          packageVersion: "2026.9.4",
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
          version: "2026.9.4",
          resourceRoot: path.join(directory, "resources", "ocr"),
          binaryRoot: path.join(directory, "binaries"),
          nativeBuild: nativeBuildEvidence(releaseTargets[0], "signed-release"),
          sourceArchiveSha256: "b".repeat(64),
          cacheKey: `synthetic-${releaseTargets[0]}-cache`,
          cacheRestored: false,
        }),
      ).rejects.toThrow(".AppImage.sig");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects missing or colliding Windows WebView2 package variants", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "epikrise-windows-variants-"));
    const offlineRoot = path.join(directory, "offline");
    const bootstrapperRoot = path.join(directory, "bootstrapper");
    const target = "x86_64-pc-windows-msvc";
    const stageRoot = path.join(directory, "staged");
    const commonOptions = {
      target,
      bundleRoot: offlineRoot,
      bootstrapperRoot,
      stageRoot,
      commit: releaseCommit,
      version: "2026.9.4",
      resourceRoot: path.join(directory, "resources", "ocr"),
      binaryRoot: path.join(directory, "binaries"),
      nativeBuild: nativeBuildEvidence(target, "signed-release"),
      sourceArchiveSha256: "b".repeat(64),
      cacheKey: `synthetic-${target}-cache`,
      cacheRestored: false,
    };

    try {
      await mkdir(offlineRoot, { recursive: true });
      await mkdir(bootstrapperRoot, { recursive: true });
      await writeFile(path.join(offlineRoot, "offline.exe"), "offline");
      await writeFile(path.join(offlineRoot, "offline.exe.sig"), "offline-signature");
      await writeFile(path.join(bootstrapperRoot, "bootstrapper.exe"), "bootstrapper");
      await expect(stageReleaseArtifacts(commonOptions)).rejects.toThrow(
        "Expected exactly one bootstrapper .exe.sig artifact",
      );

      await writeFile(
        path.join(bootstrapperRoot, "bootstrapper.exe.sig"),
        "bootstrapper-signature",
      );
      await writeFile(path.join(bootstrapperRoot, "duplicate.exe"), "duplicate");
      await expect(stageReleaseArtifacts(commonOptions)).rejects.toThrow(
        "Expected exactly one bootstrapper .exe artifact",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("Windows release installer configuration", () => {
  it("selects NSIS and supports embedded-bootstrapper and offline WebView2 modes", () => {
    expect(
      createWindowsReleaseConfig({
        target: "x86_64-pc-windows-msvc",
        webviewMode: "embedBootstrapper",
      }),
    ).toEqual({
      bundle: {
        targets: ["nsis"],
        windows: {
          webviewInstallMode: { type: "embedBootstrapper" },
        },
      },
    });
    expect(
      createWindowsReleaseConfig({
        target: "aarch64-pc-windows-msvc",
        webviewMode: "offlineInstaller",
      }).bundle.windows.webviewInstallMode,
    ).toEqual({ type: "offlineInstaller", silent: true });
    expect(() =>
      createWindowsReleaseConfig({
        target: "x86_64-pc-windows-msvc",
        webviewMode: "downloadBootstrapper",
      }),
    ).toThrow("Unsupported WebView2 installer mode");
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
        /,\s*(?:TemplateError|LlmError|NativeMenuError|epikrise_ingest::IngestError)>$/,
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
      [
        "src-tauri/src/lib.rs",
        'tag = "key", rename_all = "snake_case"',
        "NativeMenuError",
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

function clearCiEnvironment(environment: NodeJS.ProcessEnv) {
  for (const variable of [
    "CI",
    "GITHUB_ACTIONS",
    "GITLAB_CI",
    "CIRCLECI",
    "JENKINS_URL",
    "BUILD_NUMBER",
    "TF_BUILD",
    "TEAMCITY_VERSION",
    "BUILDKITE",
    "DRONE",
    "CODEBUILD_BUILD_ID",
  ]) {
    delete environment[variable];
  }
  environment.CI = "";
  environment.GITHUB_ACTIONS = "";
  return environment;
}

async function createWindowsCrossBuildFixture(
  directory: string,
  options: { hostArch?: string } = {},
) {
  const { hostArch = "x86_64" } = options;
  const repoRoot = path.join(directory, "repo");
  const scriptsDir = path.join(repoRoot, "scripts");
  const binDir = path.join(directory, "bin");
  const cacheRoot = path.join(directory, "cache");
  const prepareLog = path.join(directory, "prepare.log");
  const buildLog = path.join(directory, "build.log");
  const scriptPath = path.join(scriptsDir, "build-windows.sh");
  const windowsCache = path.join(cacheRoot, "epikrise", "windows");
  await Promise.all([
    mkdir(scriptsDir, { recursive: true }),
    mkdir(binDir, { recursive: true }),
    mkdir(windowsCache, { recursive: true }),
  ]);
  await writeFile(
    scriptPath,
    await readFile(path.join(repoRootForTests(), "scripts/build-windows.sh"), "utf8"),
    "utf8",
  );
  await writeFile(
    path.join(windowsCache, "sdk-license-accepted-17-10.0.26100-14.44.17.14"),
    "",
  );
  await writeExecutable(
    path.join(scriptsDir, "prepare-ocr.sh"),
    [
      "#!/usr/bin/env bash",
      'printf "%s|%s|%s|%s\\n" "$*" "${EPIKRISE_WINDOWS_CROSS_BUILD_PACKAGE:-}" "${EPIKRISE_WINDOWS_HOST_ARCH:-}" "${EPIKRISE_ALLOW_LINUX_WINDOWS_CROSS_BUILD:-}" >> "$PREPARE_LOG"',
      "",
    ].join("\n"),
  );
  await writeExecutable(
    path.join(scriptsDir, "with-cargo-host-target.sh"),
    '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$BUILD_LOG"\n',
  );
  await writeExecutable(
    path.join(scriptsDir, "clang-xwin.sh"),
    "#!/usr/bin/env bash\nexit 0\n",
  );
  await writeExecutable(
    path.join(binDir, "uname"),
    [
      "#!/usr/bin/env bash",
      'if [[ "$1" == "-s" ]]; then printf "%s\\n" "${TEST_HOST_OS:-Linux}"; else printf "%s\\n" "${TEST_HOST_ARCH:-x86_64}"; fi',
      "",
    ].join("\n"),
  );
  await writeExecutable(
    path.join(binDir, "rustc"),
    [
      "#!/usr/bin/env bash",
      'printf "host: %s-unknown-linux-gnu\\n" "${TEST_HOST_ARCH:-x86_64}"',
      "",
    ].join("\n"),
  );
  await writeExecutable(
    path.join(binDir, "node"),
    [
      "#!/usr/bin/env bash",
      'if [[ "$1" == */verify-linux-host-architecture.mjs ]]; then',
      '  printf "%s\\n" "$3"',
      "else",
      `  exec ${JSON.stringify(process.execPath)} "$@"`,
      "fi",
      "",
    ].join("\n"),
  );
  await writeExecutable(path.join(binDir, "clang"), "#!/usr/bin/env bash\nexit 0\n");

  const environment = clearCiEnvironment({
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    XDG_CACHE_HOME: cacheRoot,
    TEST_HOST_ARCH: hostArch,
    TEST_HOST_OS: "Linux",
    PREPARE_LOG: prepareLog,
    BUILD_LOG: buildLog,
    EPIKRISE_ALLOW_LINUX_WINDOWS_CROSS_BUILD: "true",
  });
  delete environment.EPIKRISE_WINDOWS_INSTALLER_FAMILY;

  return { repoRoot, scriptPath, prepareLog, buildLog, environment };
}

function repoRootForTests() {
  return fileURLToPath(new URL("../", import.meta.url));
}

async function writeMockUname(
  binDir: string,
  hostTriple: string,
  archOverride?: string,
) {
  const system = hostTriple.endsWith("-apple-darwin")
    ? "Darwin"
    : hostTriple.endsWith("-windows-msvc")
      ? "MINGW64_NT"
      : "Linux";
  const architecture =
    archOverride ?? (hostTriple.startsWith("aarch64-") ? "aarch64" : "x86_64");
  await writeExecutable(
    path.join(binDir, "uname"),
    [
      "#!/usr/bin/env bash",
      `if [[ "$1" == "-s" ]]; then printf '%s\\n' '${system}'; else printf '%s\\n' '${architecture}'; fi`,
      "",
    ].join("\n"),
  );
  if (system === "Linux") {
    await writeExecutable(
      path.join(binDir, "node"),
      [
        "#!/usr/bin/env bash",
        'if [[ "$1" == */verify-linux-host-architecture.mjs ]]; then',
        "  printf '%s\\n' \"$3\"",
        "else",
        `  exec ${JSON.stringify(process.execPath)} "$@"`,
        "fi",
        "",
      ].join("\n"),
    );
  }
}

describe("native Cargo host target guard", () => {
  const wrapperPath = path.join(repoRoot, "scripts/with-cargo-host-target.sh");
  const tauriScriptPath = path.join(repoRoot, "scripts/tauri.sh");

  it("resolves the D-Bus address from the active X11 session record", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "epikrise-dbus-session-"));
    const homeDirectory = path.join(directory, "home");
    const sessionBusDirectory = path.join(homeDirectory, ".dbus", "session-bus");
    const machineId = "0123456789abcdef0123456789abcdef";
    const machineIdPath = path.join(directory, "machine-id");
    const address =
      "unix:path=/tmp/epikrise-test-dbus,guid=0123456789abcdef0123456789abcdef";

    try {
      await mkdir(sessionBusDirectory, { recursive: true });
      await writeFile(machineIdPath, `${machineId}\n`);
      await writeFile(
        path.join(sessionBusDirectory, `${machineId}-1`),
        `DBUS_SESSION_BUS_ADDRESS='${address}'\nDBUS_SESSION_BUS_PID=123\n`,
      );

      expect(
        resolveLinuxSessionBusAddress(
          {
            DBUS_SESSION_BUS_ADDRESS: "autolaunch:",
            DISPLAY: ":1.0",
            HOME: homeDirectory,
          },
          {
            machineIdPath,
            isSocketPath: (socketPath) => socketPath === "/tmp/epikrise-test-dbus",
          },
        ),
      ).toBe(address);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("decodes percent-escaped D-Bus socket paths for validation", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "epikrise-dbus-escaped-"));
    const homeDirectory = path.join(directory, "home");
    const sessionBusDirectory = path.join(homeDirectory, ".dbus", "session-bus");
    const machineId = "0123456789abcdef0123456789abcdef";
    const machineIdPath = path.join(directory, "machine-id");
    const socketPath = "/tmp/epikrise session bus";
    const address =
      "unix:path=/tmp/epikrise%20session%20bus,guid=0123456789abcdef0123456789abcdef";

    try {
      await mkdir(sessionBusDirectory, { recursive: true });
      await writeFile(machineIdPath, `${machineId}\n`);
      await writeFile(
        path.join(sessionBusDirectory, `${machineId}-1`),
        `DBUS_SESSION_BUS_ADDRESS='${address}'\nDBUS_SESSION_BUS_PID=123\n`,
      );

      expect(
        resolveLinuxSessionBusAddress(
          {
            DBUS_SESSION_BUS_ADDRESS: "autolaunch:",
            DISPLAY: ":1.0",
            HOME: homeDirectory,
          },
          {
            machineIdPath,
            isSocketPath: (candidate) => candidate === socketPath,
          },
        ),
      ).toBe(address);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["invalid GUID", "guid=not-a-guid"],
    ["malformed trailing parameter", "guid=0123456789abcdef0123456789abcdef,malformed"],
    ["malformed trailing escape", "guid=0123456789abcdef0123456789abcdef,extra=%GG"],
  ])("rejects a live D-Bus socket with %s", async (_description, parameters) => {
    const directory = await mkdtemp(path.join(tmpdir(), "epikrise-dbus-malformed-"));
    const homeDirectory = path.join(directory, "home");
    const sessionBusDirectory = path.join(homeDirectory, ".dbus", "session-bus");
    const machineId = "0123456789abcdef0123456789abcdef";
    const machineIdPath = path.join(directory, "machine-id");
    const isSocketPath = vi.fn(() => true);

    try {
      await mkdir(sessionBusDirectory, { recursive: true });
      await writeFile(machineIdPath, `${machineId}\n`);
      await writeFile(
        path.join(sessionBusDirectory, `${machineId}-1`),
        `DBUS_SESSION_BUS_ADDRESS='unix:path=/tmp/epikrise-live-bus,${parameters}'\n`,
      );

      expect(
        resolveLinuxSessionBusAddress(
          {
            DBUS_SESSION_BUS_ADDRESS: "autolaunch:",
            DISPLAY: ":1.0",
            HOME: homeDirectory,
          },
          { machineIdPath, isSocketPath },
        ),
      ).toBeUndefined();
      expect(isSocketPath).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("falls back when a D-Bus socket address decodes to a NUL byte", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "epikrise-dbus-nul-"));
    const homeDirectory = path.join(directory, "home");
    const sessionBusDirectory = path.join(homeDirectory, ".dbus", "session-bus");
    const machineId = "0123456789abcdef0123456789abcdef";
    const machineIdPath = path.join(directory, "machine-id");
    const address =
      "unix:path=/tmp/session%00bus,guid=0123456789abcdef0123456789abcdef";
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const isSocketPath = vi.fn(() => {
      throw new Error("NUL-containing paths must not be probed");
    });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DBUS_SESSION_BUS_ADDRESS: "autolaunch:",
      DISPLAY: ":1.0",
      HOME: homeDirectory,
    };
    let childEnv: NodeJS.ProcessEnv | undefined;

    try {
      await mkdir(sessionBusDirectory, { recursive: true });
      await writeFile(machineIdPath, `${machineId}\n`);
      await writeFile(
        path.join(sessionBusDirectory, `${machineId}-1`),
        `DBUS_SESSION_BUS_ADDRESS='${address}'\n`,
      );

      const status = runTauri(["dev"], {
        platform: "linux",
        env,
        resolveLinuxSessionBusAddress: (launchEnv) =>
          resolveLinuxSessionBusAddress(launchEnv, {
            machineIdPath,
            isSocketPath,
          }),
        spawn: (_command, _args, options) => {
          childEnv = options.env;
          return { status: 0 };
        },
      });

      expect(status).toBe(0);
      expect(childEnv?.DBUS_SESSION_BUS_ADDRESS).toBe("autolaunch:");
      expect(isSocketPath).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining("Could not resolve the desktop D-Bus session address"),
      );
    } finally {
      warning.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("falls back when a live D-Bus socket address contains a literal NUL", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "epikrise-dbus-nul-guid-"));
    const homeDirectory = path.join(directory, "home");
    const sessionBusDirectory = path.join(homeDirectory, ".dbus", "session-bus");
    const machineId = "0123456789abcdef0123456789abcdef";
    const machineIdPath = path.join(directory, "machine-id");
    const address =
      "unix:path=/tmp/session-bus,guid=0123456789abcdef0123456789abcdef\0";
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const isSocketPath = vi.fn(() => true);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DBUS_SESSION_BUS_ADDRESS: "autolaunch:",
      DISPLAY: ":1.0",
      HOME: homeDirectory,
    };
    let childEnv: NodeJS.ProcessEnv | undefined;

    try {
      await mkdir(sessionBusDirectory, { recursive: true });
      await writeFile(machineIdPath, `${machineId}\n`);
      await writeFile(
        path.join(sessionBusDirectory, `${machineId}-1`),
        `DBUS_SESSION_BUS_ADDRESS='${address}'\n`,
      );

      const status = runTauri(["dev"], {
        platform: "linux",
        env,
        resolveLinuxSessionBusAddress: (launchEnv) =>
          resolveLinuxSessionBusAddress(launchEnv, {
            machineIdPath,
            isSocketPath,
          }),
        spawn: (_command, _args, options) => {
          childEnv = options.env;
          return { status: 0 };
        },
      });

      expect(status).toBe(0);
      expect(childEnv?.DBUS_SESSION_BUS_ADDRESS).toBe("autolaunch:");
      expect(isSocketPath).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining("Could not resolve the desktop D-Bus session address"),
      );
    } finally {
      warning.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("resolves live abstract Unix sockets with repeated spaces and backslashes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "epikrise-dbus-abstract-"));
    const homeDirectory = path.join(directory, "home");
    const sessionBusDirectory = path.join(homeDirectory, ".dbus", "session-bus");
    const machineId = "0123456789abcdef0123456789abcdef";
    const machineIdPath = path.join(directory, "machine-id");
    const socketName = "/tmp/epikrise  abstract\\123 session bus";
    const address =
      "unix:abstract=/tmp/epikrise%20%20abstract\\123%20session%20bus,guid=0123456789abcdef0123456789abcdef";

    try {
      await mkdir(sessionBusDirectory, { recursive: true });
      await writeFile(machineIdPath, `${machineId}\n`);
      await writeFile(
        path.join(sessionBusDirectory, `${machineId}-1`),
        `DBUS_SESSION_BUS_ADDRESS='${address}'\nDBUS_SESSION_BUS_PID=123\n`,
      );

      expect(
        resolveLinuxSessionBusAddress(
          {
            DBUS_SESSION_BUS_ADDRESS: "autolaunch:",
            DISPLAY: ":1.0",
            HOME: homeDirectory,
          },
          {
            machineIdPath,
            readFile: (filePath) =>
              filePath === "/proc/net/unix"
                ? `Num RefCount Protocol Flags Type St Inode Path\n0000000000000000: 00000002 00000000 00010000 0001 01 1234 @${socketName}\n`
                : readFileSync(filePath, "utf8"),
          },
        ),
      ).toBe(address);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "does not use a socket path without a listening D-Bus endpoint",
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "epikrise-dbus-stale-"));
      const homeDirectory = path.join(directory, "home");
      const sessionBusDirectory = path.join(homeDirectory, ".dbus", "session-bus");
      const machineId = "0123456789abcdef0123456789abcdef";
      const machineIdPath = path.join(directory, "machine-id");
      const socketPath = path.join(directory, "session-bus");
      const address = `unix:path=${socketPath},guid=0123456789abcdef0123456789abcdef`;
      const server = createServer();

      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(socketPath, resolve);
        });
        await mkdir(sessionBusDirectory, { recursive: true });
        await writeFile(machineIdPath, `${machineId}\n`);
        await writeFile(
          path.join(sessionBusDirectory, `${machineId}-1`),
          `DBUS_SESSION_BUS_ADDRESS='${address}'\nDBUS_SESSION_BUS_PID=123\n`,
        );

        expect(
          resolveLinuxSessionBusAddress(
            {
              DBUS_SESSION_BUS_ADDRESS: "autolaunch:",
              DISPLAY: ":1.0",
              HOME: homeDirectory,
            },
            {
              machineIdPath,
              readFile: (filePath) =>
                filePath === "/proc/net/unix"
                  ? `Num RefCount Protocol Flags Type St Inode Path\n0000000000000000: 00000002 00000000 00000000 0001 01 1234 ${socketPath}\n`
                  : readFileSync(filePath, "utf8"),
            },
          ),
        ).toBeUndefined();
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("passes the resolved D-Bus address to the Tauri process without mutating its input", () => {
    const address =
      "unix:path=/tmp/epikrise-test-dbus,guid=0123456789abcdef0123456789abcdef";
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DBUS_SESSION_BUS_ADDRESS: "autolaunch:",
      DISPLAY: ":1.0",
    };
    let childEnv: NodeJS.ProcessEnv | undefined;

    const status = runTauri(["dev"], {
      platform: "linux",
      env,
      resolveLinuxSessionBusAddress: () => address,
      spawn: (_command, _args, options) => {
        childEnv = options.env;
        return { status: 0 };
      },
    });

    expect(status).toBe(0);
    expect(childEnv?.DBUS_SESSION_BUS_ADDRESS).toBe(address);
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBe("autolaunch:");
  });

  it("continues launching when D-Bus session discovery fails", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DBUS_SESSION_BUS_ADDRESS: "autolaunch:",
      DISPLAY: ":1.0",
    };
    let childEnv: NodeJS.ProcessEnv | undefined;

    try {
      const status = runTauri(["build"], {
        platform: "linux",
        env,
        resolveLinuxSessionBusAddress: () => {
          throw new Error("permission denied");
        },
        spawn: (_command, _args, options) => {
          childEnv = options.env;
          return { status: 0 };
        },
      });

      expect(status).toBe(0);
      expect(childEnv?.DBUS_SESSION_BUS_ADDRESS).toBe("autolaunch:");
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining("permission denied"),
      );
    } finally {
      warning.mockRestore();
    }
  });

  it("initializes MSVC for regular Windows-shell Tauri invocations without losing arguments", () => {
    const args = ["build", "--target", "aarch64-pc-windows-msvc", "--config", "a & b"];
    const gitBashPath = "C:\\Program Files\\Git\\bin\\bash.exe";
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ComSpec: "cmd.exe",
      EPIKRISE_RUNNER_ARCH: "",
      PROCESSOR_ARCHITEW6432: "",
      RUNNER_ARCH: "",
      PROCESSOR_ARCHITECTURE: "",
    };
    delete env.EPIKRISE_NATIVE_WINDOWS_ENV_INITIALIZED;
    delete env.VSCMD_ARG_HOST_ARCH;
    delete env.VSCMD_ARG_TGT_ARCH;
    const invocations: {
      command: string;
      args: string[];
      options: {
        env?: NodeJS.ProcessEnv;
        windowsVerbatimArguments?: boolean;
      };
    }[] = [];

    const status = runTauri(args, {
      platform: "win32",
      env,
      resolveGitBash: () => gitBashPath,
      spawn: (command, spawnArgs, options) => {
        invocations.push({ command, args: spawnArgs, options });
        if (command === "powershell.exe") {
          return { status: 0, stdout: "Arm64\r\n" };
        }
        return { status: 0 };
      },
    });

    expect(status).toBe(0);
    expect(invocations).toHaveLength(2);
    expect(invocations[0]).toMatchObject({
      command: "powershell.exe",
      args: expect.arrayContaining([
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(repoRoot, "scripts/detect-windows-os-architecture.ps1"),
      ]),
    });
    expect(invocations[1].command).toBe("cmd.exe");
    expect(invocations[1].args).toEqual([
      "/d",
      "/s",
      "/c",
      `call "${path.join(repoRoot, "scripts/build-native-windows.cmd")}" arm64 tauri`,
    ]);
    expect(invocations[1].options.env?.EPIKRISE_TAURI_ARGS_JSON).toBe(
      JSON.stringify(args),
    );
    expect(invocations[1].options.windowsVerbatimArguments).toBe(true);
    expect(invocations[1].options.env?.VSCMD_ARG_HOST_ARCH).toBeUndefined();
  });

  it("prefers PROCESSOR_ARCHITEW6432 over emulated PowerShell architecture", () => {
    const args = ["build", "--target", "aarch64-pc-windows-msvc"];
    const invocations: { command: string; args: string[] }[] = [];

    const status = runTauri(args, {
      platform: "win32",
      env: {
        ...process.env,
        ComSpec: "cmd.exe",
        EPIKRISE_RUNNER_ARCH: "",
        PROCESSOR_ARCHITEW6432: "ARM64",
        PROCESSOR_ARCHITECTURE: "AMD64",
        RUNNER_ARCH: "X64",
        VSCMD_ARG_HOST_ARCH: "x64",
      },
      resolveGitBash: () => "C:\\Program Files\\Git\\bin\\bash.exe",
      spawn: (command, spawnArgs) => {
        invocations.push({ command, args: spawnArgs });
        if (command === "powershell.exe") {
          return { status: 0, stdout: "X64\r\n" };
        }
        return { status: 0 };
      },
    });

    expect(status).toBe(0);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({
      command: "cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        `call "${path.join(repoRoot, "scripts/build-native-windows.cmd")}" arm64 tauri`,
      ],
    });
  });

  it("reuses the initialized MSVC environment for nested Tauri commands", () => {
    const args = ["build", "--target", "x86_64-pc-windows-msvc"];
    const gitBashPath = "C:\\Program Files\\Git\\bin\\bash.exe";
    const env = {
      ...process.env,
      EPIKRISE_NATIVE_WINDOWS_ENV_INITIALIZED: "1",
      EPIKRISE_TAURI_ARGS_JSON: '["outer"]',
    };
    let invocation:
      | {
          command: string;
          args: string[];
          options: { env?: NodeJS.ProcessEnv };
        }
      | undefined;

    const status = runTauri(args, {
      platform: "win32",
      env,
      resolveGitBash: () => gitBashPath,
      spawn: (command, spawnArgs, options) => {
        invocation = { command, args: spawnArgs, options };
        return { status: 0 };
      },
    });

    expect(status).toBe(0);
    expect(invocation).toMatchObject({
      command: gitBashPath,
      args: [tauriScriptPath, ...args],
    });
    expect(invocation?.options.env?.EPIKRISE_NATIVE_WINDOWS_ENV_INITIALIZED).toBe(
      undefined,
    );
    expect(invocation?.options.env?.EPIKRISE_TAURI_ARGS_JSON).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")(
    "preserves Windows Tauri argument boundaries through the environment trampoline",
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "epikrise-tauri-args-"));
      const fakeBashPath = path.join(directory, "fake-bash");
      const argumentsPath = path.join(directory, "arguments.bin");
      const args = ["build", "--config", "one & two", "--features", "a|b"];

      try {
        await writeExecutable(
          fakeBashPath,
          '#!/usr/bin/env bash\nprintf "%s\\0" "$@" > "$TAURI_ARGS_LOG"\n',
        );

        await execFile(
          process.execPath,
          [path.join(repoRoot, "scripts/tauri.mjs"), "--run-with-msvc-env"],
          {
            env: {
              ...process.env,
              EPIKRISE_NATIVE_WINDOWS_ENV_INITIALIZED: "1",
              EPIKRISE_TAURI_ARGS_JSON: JSON.stringify(args),
              EPIKRISE_GIT_BASH_EXE: fakeBashPath,
              TAURI_ARGS_LOG: argumentsPath,
            },
          },
        );

        const forwardedArguments = (await readFile(argumentsPath, "utf8"))
          .split("\0")
          .slice(0, -1);
        expect(forwardedArguments).toEqual([tauriScriptPath, ...args]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("rejects a mismatched target before OCR downloads", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "epikrise-tauri-target-"));
    const binDir = path.join(directory, "bin");
    const tessdataDir = path.join(directory, "tessdata");
    const curlLog = path.join(directory, "curl.log");

    try {
      await mkdir(binDir);
      await mkdir(tessdataDir);
      const { stdout: rustcInfo } = await execFile("rustc", ["-vV"]);
      const host = rustcInfo.match(/^host: (.+)$/m)?.[1];
      expect(host).toBeDefined();
      const mismatchedTarget = host!.startsWith("x86_64-")
        ? host!.replace("x86_64-", "aarch64-")
        : host!.replace("aarch64-", "x86_64-");

      await writeFile(path.join(tessdataDir, "deu.traineddata"), "deu", "utf8");
      await writeFile(path.join(tessdataDir, "eng.traineddata"), "eng", "utf8");
      await writeExecutable(
        path.join(binDir, "rustc"),
        `#!/usr/bin/env bash\nprintf 'host: ${host}\\n'\n`,
      );
      await writeMockUname(binDir, host!);
      await writeExecutable(
        path.join(binDir, "tesseract"),
        '#!/usr/bin/env bash\nprintf \'List of available languages in "%s":\\n\' "$TESSDATA_DIR"\n',
      );
      await writeExecutable(
        path.join(binDir, "curl"),
        '#!/usr/bin/env bash\nprintf "called\\n" >> "$CURL_LOG"\nexit 1\n',
      );

      await expect(
        execFile("bash", [tauriScriptPath, "--target", mismatchedTarget], {
          cwd: repoRoot,
          env: {
            ...process.env,
            PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
            TESSDATA_DIR: tessdataDir,
            CURL_LOG: curlLog,
            EPIKRISE_OCR_RESOURCE_DIR: path.join(directory, "resources"),
            EPIKRISE_OCR_BINARY_DIR: path.join(directory, "binaries"),
            EPIKRISE_NATIVE_OCR_CACHE: path.join(directory, "cache"),
          },
        }),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("does not match native host"),
      });
      await expect(readFile(curlLog, "utf8")).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["project Cargo config", ["build"], "project-config"],
    [
      "forwarded Cargo --config override",
      ["build", "--", "--config", 'build.target = "__CROSS_TARGET__"'],
      "cli-override",
    ],
    [
      "forwarded Cargo --target-dir",
      ["build", "--", "--target-dir", "custom-target"],
      "target-dir",
    ],
    [
      "forwarded Cargo --target-dir equals override",
      ["build", "--", "--target-dir=custom-target"],
      "target-dir",
    ],
  ])(
    "rejects a cross-target from %s before OCR preparation",
    async (_description, args, configSource) => {
      const directory = await mkdtemp(
        path.join(tmpdir(), "epikrise-tauri-cargo-config-"),
      );
      const binDir = path.join(directory, "bin");
      const cargoHome = path.join(directory, "cargo-home");
      const curlLog = path.join(directory, "curl.log");

      try {
        await mkdir(binDir);
        await mkdir(cargoHome);
        const { stdout: rustcInfo } = await execFile("rustc", ["-vV"]);
        const host = rustcInfo.match(/^host: (.+)$/m)?.[1];
        expect(host).toBeDefined();
        const mismatchedTarget = host!.startsWith("aarch64-")
          ? host!.replace("aarch64-", "x86_64-")
          : host!.replace("x86_64-", "aarch64-");
        if (configSource === "project-config") {
          await mkdir(path.join(directory, ".cargo"));
          await writeFile(
            path.join(directory, ".cargo/config.toml"),
            `[build]\ntarget = "${mismatchedTarget}"\n`,
          );
        }

        const scenarioArgs = args.map((argument) =>
          argument.replace("__CROSS_TARGET__", mismatchedTarget),
        );
        await writeExecutable(
          path.join(binDir, "rustc"),
          `#!/usr/bin/env bash\nprintf 'host: ${host}\\n'\n`,
        );
        await writeMockUname(binDir, host!);
        await writeExecutable(
          path.join(binDir, "curl"),
          '#!/usr/bin/env bash\nprintf "called\\n" >> "$CURL_LOG"\nexit 1\n',
        );

        await expect(
          execFile("bash", [tauriScriptPath, ...scenarioArgs], {
            cwd: directory,
            env: {
              ...process.env,
              PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
              CARGO_HOME: cargoHome,
              CURL_LOG: curlLog,
              EPIKRISE_OCR_RESOURCE_DIR: path.join(directory, "resources"),
              EPIKRISE_OCR_BINARY_DIR: path.join(directory, "binaries"),
            },
          }),
        ).rejects.toMatchObject({
          stderr: expect.stringContaining(
            configSource === "target-dir"
              ? "Cargo --target-dir is not allowed for native Tauri builds"
              : "does not match native host",
          ),
        });
        await expect(readFile(curlLog, "utf8")).rejects.toThrow();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ["split after the subcommand", ["build", "--runner", "cargo-xwin"]],
    ["equals form after the subcommand", ["build", "--runner=cargo-xwin"]],
    ["split before the subcommand", ["--runner", "cargo-xwin", "build"]],
    ["equals form before the subcommand", ["--runner=cargo-xwin", "build"]],
    ["short split after build", ["build", "-r", "cargo-xwin"]],
    ["short equals after build", ["build", "-r=cargo-xwin"]],
    ["short attached after build", ["build", "-rcargo-xwin"]],
    ["clustered short attached after build", ["build", "-vrcargo-xwin"]],
    ["clustered short split after build", ["build", "-vr", "cargo-xwin"]],
    ["debug before clustered runner", ["build", "-drcargo-xwin"]],
    ["split runner after debug", ["build", "-dr", "cargo-xwin"]],
    ["split in dev", ["dev", "--runner", "cargo-xwin"]],
    ["equals form in dev", ["dev", "--runner=cargo-xwin"]],
    ["short split in dev", ["dev", "-r", "cargo-xwin"]],
    ["short equals in dev", ["dev", "-r=cargo-xwin"]],
    ["short attached in dev", ["dev", "-rcargo-xwin"]],
    ["short split before dev", ["-r", "cargo-xwin", "dev"]],
  ])(
    "rejects a cross-compilation runner in native builds (%s) before OCR downloads",
    async (_description, args) => {
      const directory = await mkdtemp(
        path.join(tmpdir(), "epikrise-tauri-cross-runner-"),
      );
      const binDir = path.join(directory, "bin");
      const curlLog = path.join(directory, "curl.log");

      try {
        await mkdir(binDir);
        const { stdout: rustcInfo } = await execFile("rustc", ["-vV"]);
        const host = rustcInfo.match(/^host: (.+)$/m)?.[1];
        expect(host).toBeDefined();
        await writeExecutable(
          path.join(binDir, "rustc"),
          `#!/usr/bin/env bash\nprintf 'host: ${host}\\n'\n`,
        );
        await writeMockUname(binDir, host!);
        await writeExecutable(
          path.join(binDir, "curl"),
          '#!/usr/bin/env bash\nprintf "called\\n" >> "$CURL_LOG"\nexit 1\n',
        );

        await expect(
          execFile("bash", [tauriScriptPath, ...args], {
            cwd: repoRoot,
            env: {
              ...process.env,
              PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
              CURL_LOG: curlLog,
              EPIKRISE_OCR_RESOURCE_DIR: path.join(directory, "resources"),
              EPIKRISE_OCR_BINARY_DIR: path.join(directory, "binaries"),
            },
          }),
        ).rejects.toMatchObject({
          stderr: expect.stringContaining(
            "Custom Tauri runner cargo-xwin is not allowed for native-only builds",
          ),
        });
        await expect(readFile(curlLog, "utf8")).rejects.toThrow();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each([
    { command: "build", appArgs: [] },
    { command: "dev", appArgs: [] },
    { command: "dev", appArgs: ["--", "--help"] },
  ])(
    "rejects a mismatched $command runner target before OCR downloads",
    async ({ command, appArgs }) => {
      const directory = await mkdtemp(
        path.join(tmpdir(), "epikrise-tauri-runner-target-"),
      );
      const binDir = path.join(directory, "bin");
      const curlLog = path.join(directory, "curl.log");

      try {
        await mkdir(binDir);
        const { stdout: rustcInfo } = await execFile("rustc", ["-vV"]);
        const host = rustcInfo.match(/^host: (.+)$/m)?.[1];
        expect(host).toBeDefined();
        const mismatchedTarget = host!.startsWith("x86_64-")
          ? host!.replace("x86_64-", "aarch64-")
          : host!.replace("aarch64-", "x86_64-");

        await writeExecutable(
          path.join(binDir, "rustc"),
          `#!/usr/bin/env bash\nprintf 'host: ${host}\\n'\n`,
        );
        await writeMockUname(binDir, host!);
        await writeExecutable(
          path.join(binDir, "curl"),
          '#!/usr/bin/env bash\nprintf "called\\n" >> "$CURL_LOG"\nexit 1\n',
        );

        await expect(
          execFile(
            "bash",
            [tauriScriptPath, command, "--", "--target", mismatchedTarget, ...appArgs],
            {
              cwd: repoRoot,
              env: {
                ...process.env,
                PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
                CURL_LOG: curlLog,
                EPIKRISE_OCR_RESOURCE_DIR: path.join(directory, "resources"),
                EPIKRISE_OCR_BINARY_DIR: path.join(directory, "binaries"),
              },
            },
          ),
        ).rejects.toMatchObject({
          stderr: expect.stringContaining("does not match native host"),
        });
        await expect(readFile(curlLog, "utf8")).rejects.toThrow();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("ignores application targets after tauri dev's second separator", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "epikrise-tauri-dev-app-args-"),
    );
    const binDir = path.join(directory, "bin");

    try {
      await mkdir(binDir);
      await writeExecutable(
        path.join(binDir, "rustc"),
        "#!/usr/bin/env bash\nprintf 'host: x86_64-unknown-linux-gnu\\n'\n",
      );
      await writeMockUname(binDir, "x86_64-unknown-linux-gnu");

      await execFile(
        "bash",
        [
          wrapperPath,
          "--native-only",
          "--tauri-dev",
          "--validate-only",
          "tauri",
          "dev",
          "--",
          "--",
          "--target",
          "aarch64-unknown-linux-gnu",
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
          },
        },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves Cargo arguments after the first Tauri dev separator", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "epikrise-tauri-dev-cargo-args-"),
    );
    const binDir = path.join(directory, "bin");
    const cargoLog = path.join(directory, "cargo.log");

    try {
      await mkdir(binDir);
      const { stdout: rustcInfo } = await execFile("rustc", ["-vV"]);
      const host = rustcInfo.match(/^host: (.+)$/m)?.[1];
      expect(host).toBeDefined();
      await writeExecutable(
        path.join(binDir, "rustc"),
        `#!/usr/bin/env bash\nprintf 'host: ${host}\\n'\n`,
      );
      await writeMockUname(binDir, host!);
      await writeExecutable(
        path.join(binDir, "cargo"),
        '#!/usr/bin/env bash\nprintf "%s\\n" "$*" > "$CARGO_LOG"\n',
      );

      await execFile(
        "bash",
        [
          wrapperPath,
          "--native-only",
          "--tauri-dev",
          "cargo",
          "dev",
          "--",
          "--features",
          "forwarded-feature",
          "--",
          "--app-argument",
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
            CARGO_LOG: cargoLog,
          },
        },
      );

      await expect(readFile(cargoLog, "utf8")).resolves.toBe(
        "dev -- --features forwarded-feature -- --app-argument\n",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps signing credentials out of OCR preparation", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "epikrise-tauri-signing-env-"));
    const binDir = path.join(directory, "bin");
    const ocrLog = path.join(directory, "ocr.log");
    const tauriLog = path.join(directory, "tauri.log");

    try {
      await mkdir(binDir);
      const { stdout: bashPath } = await execFile("bash", ["-c", "command -v bash"]);
      await writeExecutable(
        path.join(binDir, "bash"),
        `#!/bin/sh
script="$1"
shift
case "$script" in
  */scripts/tauri-command.sh)
    printf 'dev'
    ;;
  */scripts/with-cargo-host-target.sh)
    case " $* " in
      *" --validate-only "*) exit 0 ;;
    esac
    printf '%s|%s\\n' "\${TAURI_SIGNING_PRIVATE_KEY-unset}" "\${TAURI_SIGNING_PRIVATE_KEY_PASSWORD-unset}" > "$TAURI_LOG"
    ;;
  */scripts/prepare-ocr.sh)
    printf '%s|%s\\n' "\${TAURI_SIGNING_PRIVATE_KEY-unset}" "\${TAURI_SIGNING_PRIVATE_KEY_PASSWORD-unset}" > "$OCR_LOG"
    ;;
  *)
    printf 'Unexpected Bash invocation: %s\\n' "$script" >&2
    exit 1
    ;;
esac
`,
      );

      await execFile(bashPath.trim(), [tauriScriptPath, "dev"], {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
          OCR_LOG: ocrLog,
          TAURI_LOG: tauriLog,
          TAURI_SIGNING_PRIVATE_KEY: "test-signing-key",
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "test-signing-password",
        },
      });

      expect(await readFile(ocrLog, "utf8")).toBe("unset|unset\n");
      expect(await readFile(tauriLog, "utf8")).toBe(
        "test-signing-key|test-signing-password\n",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["bundle", ["tauri", "bundle", "--config", "src-tauri/tauri.conf.json"]],
    [
      "build help",
      ["tauri", "build", "--config", "src-tauri/tauri.conf.json", "--help"],
    ],
  ])(
    "validates Tauri %s configuration without parsing it as Cargo TOML",
    async (_name, args) => {
      const directory = await mkdtemp(path.join(tmpdir(), "epikrise-tauri-config-"));
      const binDir = path.join(directory, "bin");

      try {
        await mkdir(binDir);
        const { stdout: rustcInfo } = await execFile("rustc", ["-vV"]);
        const host = rustcInfo.match(/^host: (.+)$/m)?.[1];
        expect(host).toBeDefined();
        await writeExecutable(
          path.join(binDir, "rustc"),
          `#!/usr/bin/env bash\nprintf 'host: ${host}\\n'\n`,
        );
        await writeMockUname(binDir, host!);

        await execFile(
          "bash",
          [wrapperPath, "--native-only", "--tauri-cli", "--validate-only", ...args],
          {
            cwd: repoRoot,
            env: {
              ...process.env,
              PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
            },
          },
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ["long runner option", ["tauri", "--runner", "cargo", "build"]],
    ["clustered short runner", ["tauri", "-vrcargo", "build"]],
    ["split clustered short runner", ["tauri", "-vr", "cargo", "build"]],
  ])(
    "allows the default Cargo runner for a native Tauri build (%s)",
    async (_name, args) => {
      const directory = await mkdtemp(
        path.join(tmpdir(), "epikrise-native-cargo-runner-"),
      );
      const binDir = path.join(directory, "bin");

      try {
        await mkdir(binDir);
        const { stdout: rustcInfo } = await execFile("rustc", ["-vV"]);
        const host = rustcInfo.match(/^host: (.+)$/m)?.[1];
        expect(host).toBeDefined();
        await writeExecutable(
          path.join(binDir, "rustc"),
          `#!/usr/bin/env bash\nprintf 'host: ${host}\\n'\n`,
        );
        await writeMockUname(binDir, host!);

        await execFile(
          "bash",
          [wrapperPath, "--native-only", "--tauri-build", "--validate-only", ...args],
          {
            env: {
              ...process.env,
              PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
            },
          },
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ["build", "--tauri-build"],
    ["dev", "--tauri-dev"],
  ])(
    "forces Cargo runner over a Tauri configuration-defined %s runner",
    async (command, nativeMode) => {
      const directory = await mkdtemp(
        path.join(tmpdir(), "epikrise-native-cargo-runner-config-"),
      );
      const binDir = path.join(directory, "bin");
      const cargoHome = path.join(directory, "cargo-home");
      const argsLog = path.join(directory, "tauri-arguments.log");
      const tauriConfig = '{"build":{"runner":"cargo-xwin"}}';

      try {
        await mkdir(binDir);
        await mkdir(cargoHome);
        const { stdout: rustcInfo } = await execFile("rustc", ["-vV"]);
        const host = rustcInfo.match(/^host: (.+)$/m)?.[1];
        expect(host).toBeDefined();
        await writeExecutable(
          path.join(binDir, "rustc"),
          `#!/usr/bin/env bash\nprintf 'host: ${host}\\n'\n`,
        );
        await writeMockUname(binDir, host!);
        await writeExecutable(
          path.join(binDir, "tauri"),
          '#!/usr/bin/env bash\nprintf "%s\\0" "$@" > "$ARGS_LOG"\n',
        );

        await execFile(
          "bash",
          [
            wrapperPath,
            "--native-only",
            nativeMode,
            "tauri",
            command,
            "--config",
            tauriConfig,
          ],
          {
            cwd: repoRoot,
            env: {
              ...process.env,
              PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
              CARGO_HOME: cargoHome,
              ARGS_LOG: argsLog,
            },
          },
        );

        const forwardedArguments = (await readFile(argsLog, "utf8"))
          .split("\0")
          .slice(0, -1);
        expect(forwardedArguments).toContain(tauriConfig);
        expect(forwardedArguments.slice(-2)).toEqual(["--runner", "cargo"]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("forwards a matching native target to Cargo", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "epikrise-native-target-"));
    const binDir = path.join(directory, "bin");
    const cargoLog = path.join(directory, "cargo.log");

    try {
      await mkdir(binDir);
      await writeExecutable(
        path.join(binDir, "rustc"),
        "#!/usr/bin/env bash\nprintf 'host: x86_64-unknown-linux-gnu\\n'\n",
      );
      await writeExecutable(
        path.join(binDir, "cargo"),
        '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$CARGO_LOG"\n',
      );
      await writeMockUname(binDir, "x86_64-unknown-linux-gnu");

      await execFile(
        "bash",
        [
          wrapperPath,
          "--native-only",
          "cargo",
          "--target",
          "x86_64-unknown-linux-gnu",
          "check",
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
            CARGO_LOG: cargoLog,
          },
        },
      );

      expect(await readFile(cargoLog, "utf8")).toBe(
        "--target x86_64-unknown-linux-gnu check\n",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["an explicit target", ["--target", "aarch64-unknown-linux-gnu"], undefined],
    ["CARGO_BUILD_TARGET", [], "aarch64-unknown-linux-gnu"],
  ])("rejects %s before invoking Cargo", async (_description, args, buildTarget) => {
    const directory = await mkdtemp(path.join(tmpdir(), "epikrise-native-target-"));
    const binDir = path.join(directory, "bin");
    const cargoLog = path.join(directory, "cargo.log");

    try {
      await mkdir(binDir);
      await writeExecutable(
        path.join(binDir, "rustc"),
        "#!/usr/bin/env bash\nprintf 'host: x86_64-unknown-linux-gnu\\n'\n",
      );
      await writeMockUname(binDir, "x86_64-unknown-linux-gnu");
      await writeExecutable(
        path.join(binDir, "cargo"),
        '#!/usr/bin/env bash\nprintf "called\\n" >> "$CARGO_LOG"\n',
      );

      await expect(
        execFile("bash", [wrapperPath, "--native-only", "cargo", ...args], {
          env: {
            ...process.env,
            PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
            CARGO_LOG: cargoLog,
            ...(buildTarget ? { CARGO_BUILD_TARGET: buildTarget } : {}),
          },
        }),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("does not match native host"),
      });
      await expect(readFile(cargoLog, "utf8")).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("native Cargo host architecture guard", () => {
  const wrapperPath = path.join(repoRoot, "scripts/with-cargo-host-target.sh");

  it("queries Windows native architecture rather than the emulated process architecture", async () => {
    const script = await readFile(
      path.join(repoRoot, "scripts/detect-windows-os-architecture.ps1"),
      "utf8",
    );
    const wrapper = await readFile(
      path.join(repoRoot, "scripts/detect-windows-os-architecture.sh"),
      "utf8",
    );

    expect(script).toContain("IsWow64Process2");
    expect(script).toContain('0x8664 { Write-Output "X64" }');
    expect(script).toContain('0xAA64 { Write-Output "Arm64" }');
    expect(wrapper).toContain("-ExecutionPolicy Bypass");
  });

  it("rejects an x64 toolchain on a native ARM64 Windows machine", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "epikrise-windows-os-arch-"));
    const binDir = path.join(directory, "bin");
    const cargoLog = path.join(directory, "cargo.log");

    try {
      await mkdir(binDir);
      await writeExecutable(
        path.join(binDir, "rustc"),
        "#!/usr/bin/env bash\nprintf 'host: x86_64-pc-windows-msvc\\n'\n",
      );
      await writeExecutable(
        path.join(binDir, "uname"),
        "#!/usr/bin/env bash\nprintf 'MINGW64_NT\\n'\n",
      );
      await writeExecutable(
        path.join(binDir, "powershell.exe"),
        "#!/usr/bin/env bash\nprintf 'Arm64\\n'\n",
      );
      await writeExecutable(
        path.join(binDir, "cargo"),
        '#!/usr/bin/env bash\nprintf "called\\n" >> "$CARGO_LOG"\n',
      );

      await expect(
        execFile("bash", [wrapperPath, "--native-only", "cargo", "check"], {
          env: {
            ...process.env,
            PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
            EPIKRISE_RUNNER_ARCH: "",
            PROCESSOR_ARCHITECTURE: "AMD64",
            PROCESSOR_ARCHITEW6432: "ARM64",
            VSCMD_ARG_HOST_ARCH: "x64",
            CARGO_LOG: cargoLog,
          },
        }),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining(
          "does not match detected physical host windows/aarch64",
        ),
      });
      await expect(readFile(cargoLog, "utf8")).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("accepts a native ARM64 Windows host despite an emulated x64 process", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "epikrise-windows-arm64-"));
    const binDir = path.join(directory, "bin");
    const cargoLog = path.join(directory, "cargo.log");

    try {
      await mkdir(binDir);
      await writeExecutable(
        path.join(binDir, "rustc"),
        "#!/usr/bin/env bash\nprintf 'host: aarch64-pc-windows-msvc\\n'\n",
      );
      await writeExecutable(
        path.join(binDir, "uname"),
        "#!/usr/bin/env bash\nprintf 'MINGW64_NT\\n'\n",
      );
      await writeExecutable(
        path.join(binDir, "powershell.exe"),
        "#!/usr/bin/env bash\nprintf 'Arm64\\n'\n",
      );
      await writeExecutable(
        path.join(binDir, "cargo"),
        '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$CARGO_LOG"\n',
      );

      await execFile("bash", [wrapperPath, "--native-only", "cargo", "check"], {
        env: {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
          PROCESSOR_ARCHITECTURE: "AMD64",
          PROCESSOR_ARCHITEW6432: "ARM64",
          RUNNER_ARCH: "",
          CARGO_LOG: cargoLog,
        },
      });

      expect(await readFile(cargoLog, "utf8")).toBe("check\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses native PowerShell architecture instead of x64 process and MSVC hosts", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "epikrise-windows-arm64-msvc-host-"),
    );
    const binDir = path.join(directory, "bin");
    const cargoLog = path.join(directory, "cargo.log");

    try {
      await mkdir(binDir);
      await writeExecutable(
        path.join(binDir, "rustc"),
        "#!/usr/bin/env bash\nprintf 'host: aarch64-pc-windows-msvc\\n'\n",
      );
      await writeExecutable(
        path.join(binDir, "uname"),
        "#!/usr/bin/env bash\nprintf 'MINGW64_NT\\n'\n",
      );
      await writeExecutable(
        path.join(binDir, "powershell.exe"),
        "#!/usr/bin/env bash\nprintf 'Arm64\\n'\n",
      );
      await writeExecutable(
        path.join(binDir, "cargo"),
        '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$CARGO_LOG"\n',
      );

      await execFile("bash", [wrapperPath, "--native-only", "cargo", "check"], {
        env: {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
          PROCESSOR_ARCHITECTURE: "AMD64",
          PROCESSOR_ARCHITEW6432: "AMD64",
          VSCMD_ARG_HOST_ARCH: "x64",
          VSCMD_ARG_TGT_ARCH: "arm64",
          EPIKRISE_RUNNER_ARCH: "",
          RUNNER_ARCH: "",
          CARGO_LOG: cargoLog,
        },
      });

      expect(await readFile(cargoLog, "utf8")).toBe("check\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects an ARM64 Rust host when physical Windows architecture is x64", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "epikrise-windows-x64-physical-host-"),
    );
    const binDir = path.join(directory, "bin");
    const cargoLog = path.join(directory, "cargo.log");

    try {
      await mkdir(binDir);
      await writeExecutable(
        path.join(binDir, "rustc"),
        "#!/usr/bin/env bash\nprintf 'host: aarch64-pc-windows-msvc\\n'\n",
      );
      await writeExecutable(
        path.join(binDir, "uname"),
        "#!/usr/bin/env bash\nprintf 'MINGW64_NT\\n'\n",
      );
      await writeExecutable(
        path.join(binDir, "powershell.exe"),
        "#!/usr/bin/env bash\nprintf 'X64\\n'\n",
      );
      await writeExecutable(
        path.join(binDir, "cargo"),
        '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$CARGO_LOG"\n',
      );

      await expect(
        execFile("bash", [wrapperPath, "--native-only", "cargo", "check"], {
          env: {
            ...process.env,
            PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
            PROCESSOR_ARCHITECTURE: "AMD64",
            PROCESSOR_ARCHITEW6432: "AMD64",
            VSCMD_ARG_HOST_ARCH: "arm64",
            VSCMD_ARG_TGT_ARCH: "arm64",
            EPIKRISE_RUNNER_ARCH: "",
            RUNNER_ARCH: "",
            CARGO_LOG: cargoLog,
          },
        }),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining(
          "does not match detected physical host windows/x86_64",
        ),
      });
      await expect(readFile(cargoLog, "utf8")).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when PowerShell cannot report physical Windows architecture", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "epikrise-windows-arm64-fallback-"),
    );
    const binDir = path.join(directory, "bin");
    const cargoLog = path.join(directory, "cargo.log");

    try {
      await mkdir(binDir);
      await writeExecutable(
        path.join(binDir, "rustc"),
        "#!/usr/bin/env bash\nprintf 'host: aarch64-pc-windows-msvc\\n'\n",
      );
      await writeExecutable(
        path.join(binDir, "uname"),
        "#!/usr/bin/env bash\nprintf 'MINGW64_NT\\n'\n",
      );
      await writeExecutable(
        path.join(binDir, "powershell.exe"),
        "#!/usr/bin/env bash\nexit 0\n",
      );
      await writeExecutable(
        path.join(binDir, "cargo"),
        '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$CARGO_LOG"\n',
      );

      await expect(
        execFile("bash", [wrapperPath, "--native-only", "cargo", "check"], {
          env: {
            ...process.env,
            PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
            PROCESSOR_ARCHITECTURE: "ARM64",
            PROCESSOR_ARCHITEW6432: "",
            RUNNER_ARCH: "",
            CARGO_LOG: cargoLog,
          },
        }),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining(
          "Could not determine physical Windows OS architecture",
        ),
      });
      await expect(readFile(cargoLog, "utf8")).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a Rust host triple that differs from physical architecture", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "epikrise-physical-host-"));
    const binDir = path.join(directory, "bin");
    const cargoLog = path.join(directory, "cargo.log");

    try {
      await mkdir(binDir);
      await writeExecutable(
        path.join(binDir, "rustc"),
        "#!/usr/bin/env bash\nprintf 'host: x86_64-unknown-linux-gnu\\n'\n",
      );
      await writeMockUname(binDir, "x86_64-unknown-linux-gnu", "aarch64");
      await writeExecutable(
        path.join(binDir, "cargo"),
        '#!/usr/bin/env bash\nprintf "called\\n" >> "$CARGO_LOG"\n',
      );

      await expect(
        execFile("bash", [wrapperPath, "--native-only", "cargo", "check"], {
          env: {
            ...process.env,
            PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
            PROCESSOR_ARCHITEW6432: "",
            PROCESSOR_ARCHITECTURE: "",
            CARGO_LOG: cargoLog,
          },
        }),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("does not match detected physical host"),
      });
      await expect(readFile(cargoLog, "utf8")).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function createWindowsOcrFixture(
  directory: string,
  expectedChecksum: string,
  options: {
    mockChecksumCommand?: boolean;
    reportTessdataParent?: boolean;
    reportInvalidTessdataPath?: boolean;
    partialReportedParent?: boolean;
    packageName?: string;
    packageMetadataAvailable?: boolean;
    installTesseract?: boolean;
    targetTriple?: string;
  } = {},
) {
  const {
    mockChecksumCommand = true,
    reportTessdataParent = false,
    reportInvalidTessdataPath = false,
    partialReportedParent = false,
    packageName = "tesseract-ocr-deu",
    packageMetadataAvailable = true,
    installTesseract = true,
    targetTriple = windowsOcrTargets[0].target,
  } = options;
  const binDir = path.join(directory, "bin");
  const tessdataRoot = path.join(directory, "tessdata");
  const tessdataDir = reportTessdataParent
    ? path.join(tessdataRoot, "tessdata")
    : tessdataRoot;
  let reportedTessdataDir = tessdataDir;
  if (reportTessdataParent) reportedTessdataDir = tessdataRoot;
  if (reportInvalidTessdataPath) {
    reportedTessdataDir = path.join(directory, "missing-tessdata");
  }
  const resourceDir = path.join(directory, "resources");
  const binaryDir = path.join(directory, "binaries");
  const cacheRoot = path.join(directory, "cache");
  const curlLog = path.join(directory, "curl.log");
  const dpkgLog = path.join(directory, "dpkg.log");
  const tarLog = path.join(directory, "tar.log");
  const tesseractLog = path.join(directory, "tesseract.log");
  const pdfiumFixturePath = path.join(directory, "pdfium.fixture");
  const tesseractFixturePath = path.join(directory, "tesseract.fixture");
  const builderPath = path.join(directory, "build-ocr.sh");
  const builderContextLog = path.join(directory, "builder-context.log");
  await Promise.all([
    mkdir(binDir, { recursive: true }),
    mkdir(tessdataDir, { recursive: true }),
  ]);
  await writeMockUname(binDir, "x86_64-unknown-linux-gnu");
  await writeExecutable(
    path.join(binDir, "rustc"),
    "#!/usr/bin/env bash\nprintf 'host: x86_64-unknown-linux-gnu\\n'\n",
  );
  await writeFile(path.join(tessdataDir, "deu.traineddata"), "deu", "utf8");
  await writeFile(path.join(tessdataDir, "eng.traineddata"), "eng", "utf8");
  await writeFile(pdfiumFixturePath, createBinaryHeader(targetTriple));
  await writeFile(tesseractFixturePath, createBinaryHeader(targetTriple));
  if (partialReportedParent) {
    await writeFile(path.join(tessdataRoot, "deu.traineddata"), "parent-deu", "utf8");
  }
  if (installTesseract) {
    await writeExecutable(
      path.join(binDir, "tesseract"),
      '#!/usr/bin/env bash\nprintf \'Tesseract wrapper: List of available languages in "%s":\\n\' "$TESSDATA_DIR"\n',
    );
  } else {
    await writeExecutable(
      path.join(binDir, "tesseract"),
      '#!/usr/bin/env bash\nprintf "called\\n" >> "$TESSERACT_LOG"\nexit 127\n',
    );
  }
  if (reportInvalidTessdataPath) {
    await writeExecutable(
      path.join(binDir, "dpkg-query"),
      [
        "#!/usr/bin/env bash",
        'printf "%s\\n" "$2" >> "$DPKG_LOG"',
        'if [[ "$TESSDATA_PACKAGE_METADATA_AVAILABLE" != "true" ]]; then exit 1; fi',
        'if [[ "$2" == "$TESSDATA_PACKAGE_NAME" ]]; then',
        '  printf "%s\\n" "$TESSDATA_PACKAGE_DIR/$TESSDATA_PACKAGE_LANGUAGE.traineddata"',
        "else",
        "  exit 1",
        "fi",
        "",
      ].join("\n"),
    );
  }
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
      'cp "$PDFIUM_FIXTURE_PATH" "$destination/$member"',
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
      'printf "%s|%s|%s\\n" "$EPIKRISE_WINDOWS_CROSS_BUILD_PACKAGE" "$EPIKRISE_WINDOWS_HOST_ARCH" "$EPIKRISE_ALLOW_LINUX_WINDOWS_CROSS_BUILD" >> "$BUILDER_CONTEXT_LOG"',
      'mkdir -p "$EPIKRISE_OCR_BINARY_DIR"',
      'cp "$TESSERACT_FIXTURE_PATH" "$EPIKRISE_OCR_BINARY_DIR/tesseract-$1.exe"',
      "",
    ].join("\n"),
  );

  return {
    binDir,
    builderPath,
    cacheRoot,
    curlLog,
    dpkgLog,
    resourceDir,
    binaryDir,
    builderContextLog,
    tarLog,
    pdfiumFixturePath,
    tesseractFixturePath,
    tessdataDir,
    environment: {
      ...clearCiEnvironment({ ...process.env }),
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      TESSDATA_DIR: reportedTessdataDir,
      TESSDATA_PACKAGE_DIR: tessdataDir,
      TESSDATA_PACKAGE_NAME: packageName,
      TESSDATA_PACKAGE_LANGUAGE: packageName.endsWith("-eng") ? "eng" : "deu",
      TESSDATA_PACKAGE_METADATA_AVAILABLE: String(packageMetadataAvailable),
      EXPECTED_CHECKSUM: expectedChecksum,
      CURL_LOG: curlLog,
      DPKG_LOG: dpkgLog,
      TAR_LOG: tarLog,
      PDFIUM_FIXTURE_PATH: pdfiumFixturePath,
      TESSERACT_FIXTURE_PATH: tesseractFixturePath,
      TESSERACT_LOG: tesseractLog,
      EPIKRISE_OCR_RESOURCE_DIR: resourceDir,
      EPIKRISE_OCR_BINARY_DIR: binaryDir,
      EPIKRISE_WINDOWS_OCR_CACHE: cacheRoot,
      EPIKRISE_WINDOWS_OCR_BUILDER: builderPath,
      EPIKRISE_ALLOW_LINUX_WINDOWS_CROSS_BUILD: "true",
      EPIKRISE_WINDOWS_CROSS_BUILD_PACKAGE: "nsis",
      EPIKRISE_WINDOWS_HOST_ARCH: "x86_64",
      BUILDER_CONTEXT_LOG: builderContextLog,
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

  it("assigns unique template IDs across conversions", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "epikrise-template-"));
    const inputPath = path.join(directory, "prompt.txt");
    const scriptPath = fileURLToPath(
      new URL("../scripts/convert-prompt.mjs", import.meta.url),
    );
    const convert = async (outputName: string, extraArgs: string[] = []) => {
      const outputPath = path.join(directory, outputName);
      await execFile(process.execPath, [
        scriptPath,
        inputPath,
        outputPath,
        ...extraArgs,
      ]);
      return TOML.parse(await readFile(outputPath, "utf8")) as unknown as {
        metadata: { name: string; id: string };
      };
    };

    try {
      await writeFile(inputPath, "Synthetic test prompt", "utf8");

      const firstDefault = await convert("first-default.epitpl");
      const secondDefault = await convert("second-default.epitpl");
      expect(firstDefault.metadata.name).toBe("Imported clinical prompt");
      expect(secondDefault.metadata.name).toBe("Imported clinical prompt");
      expect(firstDefault.metadata.id).not.toBe(secondDefault.metadata.id);

      const firstNamed = await convert("first-named.epitpl", ["--name", "Shared Name"]);
      const secondNamed = await convert("second-named.epitpl", [
        "--name",
        "Shared Name",
      ]);
      expect(firstNamed.metadata.name).toBe("Shared Name");
      expect(secondNamed.metadata.name).toBe("Shared Name");
      expect(firstNamed.metadata.id).not.toBe(secondNamed.metadata.id);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects whitespace-only template names without writing output", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "epikrise-template-"));
    const inputPath = path.join(directory, "prompt.txt");
    const outputPath = path.join(directory, "converted.epitpl");
    const nextLineOutputPath = path.join(directory, "converted-next-line.epitpl");
    const scriptPath = fileURLToPath(
      new URL("../scripts/convert-prompt.mjs", import.meta.url),
    );

    try {
      await writeFile(inputPath, "Synthetic test prompt", "utf8");
      await expect(
        execFile(process.execPath, [
          scriptPath,
          inputPath,
          outputPath,
          "--name",
          " \t ",
        ]),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("Template names must not be blank"),
      });
      await expect(lstat(outputPath)).rejects.toThrow();

      await expect(
        execFile(process.execPath, [
          scriptPath,
          inputPath,
          nextLineOutputPath,
          "--name",
          "\u0085",
        ]),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("Template names must not be blank"),
      });
      await expect(lstat(nextLineOutputPath)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects prompts containing MiniJinja comments", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "epikrise-template-"));
    const inputPath = path.join(directory, "prompt.txt");
    const outputPath = path.join(directory, "converted.epitpl");
    const scriptPath = fileURLToPath(
      new URL("../scripts/convert-prompt.mjs", import.meta.url),
    );

    try {
      await writeFile(inputPath, "Note {# trimmed at render #} text", "utf8");
      await expect(
        execFile(process.execPath, [scriptPath, inputPath, outputPath]),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining(
          "Template expressions, statements, and comments are not supported",
        ),
      });
      await expect(lstat(outputPath)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

if (process.platform !== "win32") {
  describe("Windows OCR preparation", () => {
    const prepareScript = path.join(repoRoot, "scripts/prepare-ocr.sh");

    it("rejects direct cross-target preparation without approved context before downloads", async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "epikrise-ocr-context-"));
      try {
        const fixture = await createWindowsOcrFixture(
          directory,
          windowsOcrTargets[0].checksum,
        );
        const environment = clearCiEnvironment({ ...fixture.environment });
        delete environment.EPIKRISE_ALLOW_LINUX_WINDOWS_CROSS_BUILD;
        delete environment.EPIKRISE_WINDOWS_CROSS_BUILD_PACKAGE;

        await expect(
          execFile("bash", [prepareScript, "--target", windowsOcrTargets[0].target], {
            cwd: repoRoot,
            env: environment,
          }),
        ).rejects.toMatchObject({
          stderr: expect.stringContaining("explicitly opted-in manual NSIS build"),
        });
        await expect(readFile(fixture.curlLog, "utf8")).rejects.toThrow();
        await expect(readFile(fixture.builderContextLog, "utf8")).rejects.toThrow();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    it.each(["yes", "YES", "On", "tRuE", "1"])(
      "rejects CI=%s from direct OCR preparation before downloads",
      async (ciValue) => {
        const directory = await mkdtemp(path.join(tmpdir(), "epikrise-ocr-ci-"));
        try {
          const fixture = await createWindowsOcrFixture(
            directory,
            windowsOcrTargets[0].checksum,
          );
          await expect(
            execFile("bash", [prepareScript, "--target", windowsOcrTargets[0].target], {
              cwd: repoRoot,
              env: {
                ...fixture.environment,
                CI: ciValue,
                EPIKRISE_ALLOW_LINUX_WINDOWS_CROSS_BUILD: "true",
                EPIKRISE_WINDOWS_CROSS_BUILD_PACKAGE: "nsis",
                EPIKRISE_WINDOWS_HOST_ARCH: "x86_64",
              },
            }),
          ).rejects.toMatchObject({
            stderr: expect.stringContaining("cannot run in CI"),
          });
          await expect(readFile(fixture.curlLog, "utf8")).rejects.toThrow();
          await expect(readFile(fixture.builderContextLog, "utf8")).rejects.toThrow();
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
    );

    for (const targetCase of windowsOcrTargets) {
      it(`stages the matching PDFium and Tesseract for ${targetCase.target}`, async () => {
        const directory = await mkdtemp(path.join(tmpdir(), "epikrise-ocr-"));
        try {
          const fixture = await createWindowsOcrFixture(
            directory,
            targetCase.checksum,
            {
              targetTriple: targetCase.target,
            },
          );
          await execFile("bash", [prepareScript, "--target", targetCase.target], {
            cwd: repoRoot,
            env: fixture.environment,
          });

          expect(await readFile(fixture.tarLog, "utf8")).toBe("bin/pdfium.dll");

          expect(
            await readFile(path.join(fixture.resourceDir, "pdfium/pdfium.dll")),
          ).toEqual(await readFile(fixture.pdfiumFixturePath));
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
            ),
          ).toEqual(await readFile(fixture.tesseractFixturePath));
          expect(await readFile(fixture.curlLog, "utf8")).toContain(targetCase.archive);
          expect(await readFile(fixture.builderContextLog, "utf8")).toContain(
            "nsis|x86_64|true",
          );
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

    it("rejects PDFium with the wrong architecture before building Tesseract", async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "epikrise-ocr-pdfium-arch-"));
      try {
        const fixture = await createWindowsOcrFixture(
          directory,
          windowsOcrTargets[1].checksum,
        );
        await expect(
          execFile("bash", [prepareScript, "--target", windowsOcrTargets[1].target], {
            cwd: repoRoot,
            env: fixture.environment,
          }),
        ).rejects.toMatchObject({
          stderr: expect.stringContaining("expects PE arm64; found PE x86_64"),
        });
        await expect(
          readFile(
            path.join(fixture.binaryDir, "tesseract-aarch64-pc-windows-msvc.exe"),
          ),
        ).rejects.toThrow();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    it("uses explicit language data without invoking Tesseract", async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "epikrise ocr tessdata "));
      try {
        const fixture = await createWindowsOcrFixture(
          directory,
          windowsOcrTargets[0].checksum,
          { installTesseract: false },
        );
        const windowsTessdataPath = "C:\\Clinical Data\\tessdata";
        await writeExecutable(
          path.join(fixture.binDir, "cygpath"),
          '#!/usr/bin/env bash\nprintf "%s\\n" "$TESSDATA_POSIX_PATH"\n',
        );
        await execFile(
          "bash",
          [prepareScript, "--target", windowsOcrTargets[0].target],
          {
            cwd: repoRoot,
            env: {
              ...fixture.environment,
              EPIKRISE_TESSDATA_DIR: windowsTessdataPath,
              TESSDATA_POSIX_PATH: fixture.tessdataDir,
            },
          },
        );

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
        await expect(
          readFile(path.join(directory, "tesseract.log"), "utf8"),
        ).rejects.toThrow();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    it("selects the native MSVC builder for a matching Windows host", async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "epikrise-ocr-native-win-"));
      try {
        const fixture = await createWindowsOcrFixture(
          directory,
          windowsOcrTargets[0].checksum,
        );
        const nativeBuilderPath = path.join(directory, "build-native-ocr.sh");
        const nativeBuilderLog = path.join(directory, "native-builder.log");
        await writeExecutable(
          path.join(fixture.binDir, "rustc"),
          "#!/usr/bin/env bash\nprintf 'host: x86_64-pc-windows-msvc\\n'\n",
        );
        await writeExecutable(
          nativeBuilderPath,
          [
            "#!/usr/bin/env bash",
            'printf "%s\\n" "$1" > "$NATIVE_BUILDER_LOG"',
            'mkdir -p "$EPIKRISE_OCR_BINARY_DIR"',
            'cp "$TESSERACT_FIXTURE_PATH" "$EPIKRISE_OCR_BINARY_DIR/tesseract-$1.exe"',
            "",
          ].join("\n"),
        );

        await execFile(
          "bash",
          [prepareScript, "--target", windowsOcrTargets[0].target],
          {
            cwd: repoRoot,
            env: {
              ...fixture.environment,
              EPIKRISE_NATIVE_WINDOWS_OCR_BUILDER: nativeBuilderPath,
              NATIVE_BUILDER_LOG: nativeBuilderLog,
            },
          },
        );

        expect(await readFile(nativeBuilderLog, "utf8")).toBe(
          "x86_64-pc-windows-msvc\n",
        );
        expect(
          await readFile(
            path.join(fixture.binaryDir, "tesseract-x86_64-pc-windows-msvc.exe"),
          ),
        ).toEqual(await readFile(fixture.tesseractFixturePath));
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    it("rejects a non-Windows host before downloading native MSVC dependencies", async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "epikrise-ocr-msvc-host-"));
      const binDir = path.join(directory, "bin");
      const curlLog = path.join(directory, "curl.log");
      try {
        await mkdir(binDir);
        await writeExecutable(
          path.join(binDir, "curl"),
          '#!/usr/bin/env bash\nprintf "called\\n" >> "$CURL_LOG"\nexit 1\n',
        );

        await expect(
          execFile(
            "bash",
            [
              path.join(repoRoot, "scripts/build-native-windows-ocr.sh"),
              windowsOcrTargets[0].target,
            ],
            {
              env: {
                ...process.env,
                PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
                CURL_LOG: curlLog,
                EPIKRISE_NATIVE_WINDOWS_OCR_CACHE: path.join(directory, "cache"),
              },
            },
          ),
        ).rejects.toMatchObject({
          stderr: expect.stringContaining("require a physical Windows host"),
        });
        await expect(readFile(curlLog, "utf8")).rejects.toThrow();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    it("separates native MSVC caches by toolset version and target", async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "epikrise-ocr-msvc-cache-"));
      const binDir = path.join(directory, "bin");
      const cacheRoot = path.join(directory, "cache");
      const curlLog = path.join(directory, "curl.log");
      const target = "x86_64-pc-windows-msvc";
      try {
        await mkdir(binDir);
        await writeExecutable(
          path.join(binDir, "uname"),
          "#!/usr/bin/env bash\nprintf 'MINGW64_NT\\n'\n",
        );
        await writeExecutable(
          path.join(binDir, "powershell.exe"),
          "#!/usr/bin/env bash\nprintf 'X64\\n'\n",
        );
        await writeExecutable(
          path.join(binDir, "rustc"),
          `#!/usr/bin/env bash\nprintf 'host: ${target}\\n'\n`,
        );
        for (const tool of ["cmake", "ninja", "cl", "dumpbin", "tar", "rg"]) {
          await writeExecutable(
            path.join(binDir, tool),
            "#!/usr/bin/env bash\nexit 0\n",
          );
        }
        await writeExecutable(
          path.join(binDir, "cygpath"),
          '#!/usr/bin/env bash\nprintf "%s\\n" "$2"\n',
        );
        await writeExecutable(
          path.join(binDir, "curl"),
          '#!/usr/bin/env bash\nprintf "called\\n" >> "$CURL_LOG"\nwhile [[ $# -gt 0 ]]; do if [[ "$1" == "-o" ]]; then shift; printf "invalid archive" > "$1"; exit 0; fi; shift; done\nexit 2\n',
        );

        await expect(
          execFile(
            "bash",
            [path.join(repoRoot, "scripts/build-native-windows-ocr.sh"), target],
            {
              env: {
                ...process.env,
                PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
                VSCMD_ARG_TGT_ARCH: "x64",
                VSCMD_ARG_HOST_ARCH: "x64",
                VCToolsVersion: "14.44.35207",
                CURL_LOG: curlLog,
                EPIKRISE_NATIVE_WINDOWS_OCR_CACHE: cacheRoot,
              },
            },
          ),
        ).rejects.toMatchObject({
          stderr: expect.stringContaining("SHA-256 mismatch for zlib-1.3.1.tar.gz."),
        });

        expect(
          await readdir(path.join(cacheRoot, "build", "msvc-14.44.35207-x64", target)),
        ).toEqual([]);
        expect(
          await readdir(
            path.join(cacheRoot, "install", "msvc-14.44.35207-x64", target),
          ),
        ).toEqual([]);
        await expect(readdir(path.join(cacheRoot, "build", target))).rejects.toThrow();
        expect(await readFile(curlLog, "utf8")).toBe("called\ncalled\n");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    it("resolves prefixed language-list output in a reported tessdata subdirectory", async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "epikrise-ocr-prefix-"));
      try {
        const fixture = await createWindowsOcrFixture(
          directory,
          windowsOcrTargets[0].checksum,
          {
            reportTessdataParent: true,
          },
        );
        await execFile(
          "bash",
          [
            path.join(repoRoot, "scripts/prepare-ocr.sh"),
            "--target",
            windowsOcrTargets[0].target,
          ],
          { cwd: repoRoot, env: fixture.environment },
        );

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
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    it("uses a complete child when the reported parent has only German data", async () => {
      const directory = await mkdtemp(
        path.join(tmpdir(), "epikrise-ocr-partial-parent-"),
      );
      try {
        const fixture = await createWindowsOcrFixture(
          directory,
          windowsOcrTargets[0].checksum,
          {
            reportTessdataParent: true,
            partialReportedParent: true,
          },
        );
        await execFile(
          "bash",
          [
            path.join(repoRoot, "scripts/prepare-ocr.sh"),
            "--target",
            windowsOcrTargets[0].target,
          ],
          { cwd: repoRoot, env: fixture.environment },
        );

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
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    it("uses Debian package metadata when Tesseract reports no language data", async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "epikrise-ocr-dpkg-"));
      try {
        const fixture = await createWindowsOcrFixture(
          directory,
          windowsOcrTargets[0].checksum,
          {
            reportInvalidTessdataPath: true,
            packageName: "tesseract-ocr-eng",
          },
        );
        await execFile(
          "bash",
          [
            path.join(repoRoot, "scripts/prepare-ocr.sh"),
            "--target",
            windowsOcrTargets[0].target,
          ],
          { cwd: repoRoot, env: fixture.environment },
        );

        expect(
          await readFile(
            path.join(fixture.resourceDir, "tessdata/deu.traineddata"),
            "utf8",
          ),
        ).toBe("deu");
        expect(await readFile(fixture.dpkgLog, "utf8")).toBe(
          "tesseract-ocr-deu\ntesseract-ocr-eng\n",
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    it("rejects empty Debian package metadata", async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "epikrise-ocr-empty-dpkg-"));
      try {
        const fixture = await createWindowsOcrFixture(
          directory,
          windowsOcrTargets[0].checksum,
          {
            reportInvalidTessdataPath: true,
            packageMetadataAvailable: false,
          },
        );
        await expect(
          execFile(
            "bash",
            [
              path.join(repoRoot, "scripts/prepare-ocr.sh"),
              "--target",
              windowsOcrTargets[0].target,
            ],
            { cwd: repoRoot, env: fixture.environment },
          ),
        ).rejects.toMatchObject({
          stderr: expect.stringContaining(
            "Tesseract language data must include both deu and eng traineddata files.",
          ),
        });
        expect(await readFile(fixture.dpkgLog, "utf8")).toBe(
          "tesseract-ocr-deu\ntesseract-ocr-eng\n",
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    it("invalidates a corrupt cached archive and rejects a bad download", async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "epikrise-ocr-cache-"));
      const { target, archive, checksum } = windowsOcrTargets[0];
      try {
        const fixture = await createWindowsOcrFixture(directory, checksum, {
          mockChecksumCommand: false,
        });
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
