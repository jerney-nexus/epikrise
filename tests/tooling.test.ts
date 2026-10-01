import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import TOML from "@iarna/toml";
import { describe, expect, it } from "vitest";
import {
  createReleasedChangelog,
  nextCalverVersion,
  validateCalverVersion,
} from "../scripts/prepare-release.mjs";

const execFile = promisify(execFileCallback);
const repoRoot = path.resolve(new URL("../", import.meta.url).pathname);

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
      "[Unreleased]: https://github.com/pascaljerney/epikrise/compare/HEAD",
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
      "[2026.10.1]: https://github.com/pascaljerney/epikrise/compare/v2026.10.0...v2026.10.1",
    );
    expect(result).toContain(
      "[Unreleased]: https://github.com/pascaljerney/epikrise/compare/v2026.10.1...HEAD",
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
    const scriptPath = new URL("../scripts/convert-prompt.mjs", import.meta.url)
      .pathname;

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

    it.each(windowsOcrTargets)(
      "stages the matching PDFium and Tesseract for $target",
      async ({ target, archive, checksum }) => {
        const directory = await mkdtemp(path.join(tmpdir(), "epikrise-ocr-"));
        try {
          const fixture = await createWindowsOcrFixture(directory, checksum);
          await execFile("bash", [prepareScript, "--target", target], {
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
              path.join(fixture.binaryDir, `tesseract-${target}.exe`),
              "utf8",
            ),
          ).toBe("fake tesseract exe");
          expect(await readFile(fixture.curlLog, "utf8")).toContain(archive);
          expect(
            await readFile(
              path.join(fixture.cacheRoot, "pdfium", target, archive),
              "utf8",
            ),
          ).toBe("fake pdfium archive");
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
    );

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
