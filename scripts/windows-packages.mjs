import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import path from "node:path";

const execFile = promisify(execFileCallback);

export const windowsUpgradeCodes = Object.freeze({
  x86_64: "7e83a3c8-75e0-4ea4-9e59-9d4f95cb2026",
  aarch64: "395c00d0-bf40-4ca9-9b97-ef48e0b32026",
});

const webviewModes = Object.freeze({
  offline: "offlineInstaller",
  bootstrapper: "embedBootstrapper",
});

/** @typedef {{ path: string, size_bytes: number, sha256: string }} WindowsLayoutFile */
/** @typedef {{ path: string, expectedMachine: string, imports: string }} WindowsRuntimeEvidence */
/** @typedef {{ schema_version: number, target: string, architecture: string, installer_family: string, commit: string, version: string, architecture_verified: boolean, build_inputs: Record<string, string>, files: WindowsLayoutFile[], runtime_dependencies: WindowsRuntimeEvidence[] }} WindowsLayoutManifest */

/** @param {string} architecture @param {string} installerFamily @param {string} webviewMode */
export function windowsBundleConfig(architecture, installerFamily, webviewMode) {
  if (!Object.hasOwn(windowsUpgradeCodes, architecture)) {
    throw new Error(`Unsupported Windows architecture: ${architecture}.`);
  }
  if (!["msi", "nsis"].includes(installerFamily)) {
    throw new Error(`Unsupported Windows installer family: ${installerFamily}.`);
  }
  if (!Object.hasOwn(webviewModes, webviewMode)) {
    throw new Error(`Unsupported Windows WebView2 mode: ${webviewMode}.`);
  }
  const architectureKey = /** @type {keyof typeof windowsUpgradeCodes} */ (
    architecture
  );
  const webviewModeKey = /** @type {keyof typeof webviewModes} */ (webviewMode);

  const windows =
    /** @type {{ webviewInstallMode: { type: string, silent: boolean }, wix?: { upgradeCode: string } }} */ ({
      webviewInstallMode: { type: webviewModes[webviewModeKey], silent: true },
    });
  if (installerFamily === "msi") {
    windows.wix = { upgradeCode: windowsUpgradeCodes[architectureKey] };
  }

  return { bundle: { targets: [installerFamily], windows } };
}

/** @param {string} architecture @param {string} installerFamily @param {string} webviewMode @param {string} extension */
export function windowsArtifactName(
  architecture,
  installerFamily,
  webviewMode,
  extension,
) {
  windowsBundleConfig(architecture, installerFamily, webviewMode);
  const allowedExtensions =
    installerFamily === "msi" ? [".msi", ".msi.sig"] : [".exe", ".exe.sig"];
  if (!allowedExtensions.includes(extension)) {
    throw new Error(
      `Extension ${extension} does not match the ${installerFamily} installer family.`,
    );
  }
  return `epikrise-windows-${architecture}-${installerFamily}-${webviewMode}${extension}`;
}

/** @param {string} bundleRoot @param {string} outputRoot @param {string} architecture @param {string} installerFamily @param {string} webviewMode */
export async function stageWindowsArtifacts(
  bundleRoot,
  outputRoot,
  architecture,
  installerFamily,
  webviewMode,
) {
  const extension = installerFamily === "msi" ? ".msi" : ".exe";
  windowsBundleConfig(architecture, installerFamily, webviewMode);
  const files = await readdir(bundleRoot, { withFileTypes: true });
  const packages = files.filter(
    (entry) => entry.isFile() && entry.name.endsWith(extension),
  );
  if (packages.length !== 1) {
    throw new Error(
      `Expected exactly one ${extension} package in ${bundleRoot}, found ${packages.length}.`,
    );
  }
  const signatureName = `${packages[0].name}.sig`;
  if (!files.some((entry) => entry.isFile() && entry.name === signatureName)) {
    throw new Error(`Updater signature is missing for ${packages[0].name}.`);
  }

  await mkdir(outputRoot, { recursive: true });
  const packageName = windowsArtifactName(
    architecture,
    installerFamily,
    webviewMode,
    extension,
  );
  const staged = [
    [packages[0].name, packageName],
    [signatureName, `${packageName}.sig`],
  ];
  for (const [sourceName, outputName] of staged) {
    await copyFile(
      path.join(bundleRoot, sourceName),
      path.join(outputRoot, outputName),
      1,
    );
  }
  return staged.map(([, outputName]) => outputName);
}

/** @param {string} filePath */
async function sha256(filePath) {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

/** @param {string} filePath @param {string} architecture */
async function inspectWindowsBinary(filePath, architecture) {
  const { stdout: headers } = await execFile("llvm-readobj", [
    "--file-headers",
    filePath,
  ]);
  const expectedMachine =
    architecture === "x86_64" ? "IMAGE_FILE_MACHINE_AMD64" : "IMAGE_FILE_MACHINE_ARM64";
  if (!headers.includes(expectedMachine)) {
    throw new Error(`Windows binary architecture mismatch: ${filePath}.`);
  }
  const { stdout: imports } = await execFile("llvm-readobj", [
    "--coff-imports",
    filePath,
  ]);
  return { expectedMachine, imports };
}

/**
 * @param {{ target: string, installerFamily: string, binaryPath: string, resourceRoot: string, binaryRoot: string, stageRoot: string, commit: string, version: string, buildInputs: Record<string, string>, inspectBinary?: (filePath: string, architecture: string) => Promise<{ expectedMachine: string, imports: string }> }} options
 */
export async function stageWindowsLayout({
  target,
  installerFamily,
  binaryPath,
  resourceRoot,
  binaryRoot,
  stageRoot,
  commit,
  version,
  buildInputs,
  inspectBinary = inspectWindowsBinary,
}) {
  const architecture = target.startsWith("x86_64-")
    ? "x86_64"
    : target.startsWith("aarch64-")
      ? "aarch64"
      : undefined;
  if (!architecture || !target.endsWith("-pc-windows-msvc")) {
    throw new Error(`Unsupported Windows target: ${target}.`);
  }
  windowsBundleConfig(architecture, installerFamily, "offline");
  if (!/^[0-9a-f]{40}$/.test(commit))
    throw new Error("Release commit must be a full Git SHA.");
  if (!/^\d{4}\.(0[1-9]|1[0-2])\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error("Release version must use padded CalVer.");
  }
  const requiredBuildInputs = ["sdk_version", "crt_version", "visual_studio_version"];
  if (
    !buildInputs ||
    requiredBuildInputs.some(
      (key) => typeof buildInputs[key] !== "string" || buildInputs[key].length === 0,
    )
  ) {
    throw new Error("Windows SDK, CRT, and Visual Studio versions are required.");
  }

  const pdfiumName = "pdfium.dll";
  const tesseractName = `tesseract-${target}.exe`;
  const sources = [
    [binaryPath, "release/epikrise.exe"],
    [path.join(binaryRoot, tesseractName), `src-tauri/binaries/${tesseractName}`],
    [
      path.join(resourceRoot, "pdfium", pdfiumName),
      `src-tauri/resources/ocr/pdfium/${pdfiumName}`,
    ],
    [
      path.join(resourceRoot, "tessdata", "deu.traineddata"),
      "src-tauri/resources/ocr/tessdata/deu.traineddata",
    ],
    [
      path.join(resourceRoot, "tessdata", "eng.traineddata"),
      "src-tauri/resources/ocr/tessdata/eng.traineddata",
    ],
  ];
  const inspections = [];
  const entries = [];
  for (const [sourcePath, relativePath] of sources) {
    const metadata = await lstat(sourcePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Windows layout input is not a regular file: ${sourcePath}.`);
    }
    const inspection =
      relativePath.endsWith(".exe") || relativePath.endsWith(".dll")
        ? await inspectBinary(sourcePath, architecture)
        : undefined;
    if (inspection) {
      const expectedMachine =
        architecture === "x86_64"
          ? "IMAGE_FILE_MACHINE_AMD64"
          : "IMAGE_FILE_MACHINE_ARM64";
      if (inspection.expectedMachine !== expectedMachine) {
        throw new Error(`Windows binary architecture mismatch: ${sourcePath}.`);
      }
      inspections.push({ path: relativePath, ...inspection });
    }
    entries.push({
      path: relativePath,
      size_bytes: metadata.size,
      sha256: await sha256(sourcePath),
    });
  }

  await mkdir(path.dirname(stageRoot), { recursive: true });
  await mkdir(stageRoot);
  for (const [sourcePath, relativePath] of sources) {
    const destination = path.join(stageRoot, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(sourcePath, destination, 1);
  }
  const manifest = {
    schema_version: 1,
    target,
    architecture,
    installer_family: installerFamily,
    commit,
    version,
    architecture_verified: inspections.length === 3,
    build_inputs: buildInputs,
    files: entries,
    runtime_dependencies: inspections,
  };
  await writeFile(
    path.join(stageRoot, "layout-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: "wx" },
  );
  return manifest;
}

/** @param {{ stageRoot: string, target: string, installerFamily: string, commit: string, version: string }} options */
export async function verifyWindowsLayout({
  stageRoot,
  target,
  installerFamily,
  commit,
  version,
}) {
  const manifestPath = path.join(stageRoot, "layout-manifest.json");
  const manifest = /** @type {WindowsLayoutManifest} */ (
    JSON.parse(await readFile(manifestPath, "utf8"))
  );
  const architecture = target.startsWith("aarch64-") ? "aarch64" : "x86_64";
  if (
    manifest.schema_version !== 1 ||
    manifest.target !== target ||
    manifest.architecture !== architecture ||
    manifest.installer_family !== installerFamily ||
    manifest.commit !== commit ||
    manifest.version !== version ||
    manifest.architecture_verified !== true ||
    !Array.isArray(manifest.files) ||
    !Array.isArray(manifest.runtime_dependencies) ||
    manifest.runtime_dependencies.length !== 3
  ) {
    throw new Error("Windows layout manifest does not match the requested build.");
  }

  windowsBundleConfig(architecture, installerFamily, "offline");
  if (!target.endsWith("-pc-windows-msvc")) {
    throw new Error(`Unsupported Windows target: ${target}.`);
  }
  const expectedPaths = [
    "release/epikrise.exe",
    `src-tauri/binaries/tesseract-${target}.exe`,
    "src-tauri/resources/ocr/pdfium/pdfium.dll",
    "src-tauri/resources/ocr/tessdata/deu.traineddata",
    "src-tauri/resources/ocr/tessdata/eng.traineddata",
  ];
  const expectedRuntimePaths = [expectedPaths[0], expectedPaths[1], expectedPaths[2]];
  const expectedMachine =
    architecture === "x86_64" ? "IMAGE_FILE_MACHINE_AMD64" : "IMAGE_FILE_MACHINE_ARM64";
  if (
    manifest.files.length !== expectedPaths.length ||
    expectedPaths.some(
      (filePath) => !manifest.files.some((file) => file.path === filePath),
    ) ||
    manifest.runtime_dependencies.some(
      (dependency) =>
        !expectedRuntimePaths.includes(dependency.path) ||
        dependency.expectedMachine !== expectedMachine ||
        typeof dependency.imports !== "string",
    ) ||
    expectedRuntimePaths.some(
      (filePath) =>
        !manifest.runtime_dependencies.some(
          (dependency) => dependency.path === filePath,
        ),
    ) ||
    typeof manifest.build_inputs !== "object" ||
    Object.values(manifest.build_inputs).some((value) => typeof value !== "string")
  ) {
    throw new Error("Windows layout evidence is incomplete or inconsistent.");
  }

  const expectedNames = new Set(["layout-manifest.json"]);
  for (const entry of manifest.files) {
    if (
      typeof entry.path !== "string" ||
      path.isAbsolute(entry.path) ||
      entry.path.split(/[\\/]/).includes("..") ||
      !/^[0-9a-f]{64}$/.test(entry.sha256)
    ) {
      throw new Error("Windows layout file evidence is invalid.");
    }
    expectedNames.add(entry.path);
    const filePath = path.join(stageRoot, entry.path);
    const metadata = await lstat(filePath);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size !== entry.size_bytes ||
      (await sha256(filePath)) !== entry.sha256
    ) {
      throw new Error(`Windows layout integrity check failed: ${entry.path}.`);
    }
  }
  /** @type {string[]} */
  const actualFiles = [];
  /** @param {string} directory @param {string} [prefix] */
  async function collect(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory())
        await collect(path.join(directory, entry.name), relativePath);
      else actualFiles.push(relativePath);
    }
  }
  await collect(stageRoot);
  if (
    actualFiles.length !== expectedNames.size ||
    actualFiles.some((name) => !expectedNames.has(name))
  ) {
    throw new Error("Windows layout file set does not match its manifest.");
  }
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "config") {
    const [architecture, installerFamily, webviewMode] = args;
    process.stdout.write(
      `${JSON.stringify(windowsBundleConfig(architecture, installerFamily, webviewMode))}\n`,
    );
  } else if (command === "stage") {
    const [bundleRoot, outputRoot, architecture, installerFamily, webviewMode] = args;
    await stageWindowsArtifacts(
      bundleRoot,
      outputRoot,
      architecture,
      installerFamily,
      webviewMode,
    );
  } else if (command === "stage-layout") {
    const [
      target,
      installerFamily,
      binaryPath,
      resourceRoot,
      binaryRoot,
      stageRoot,
      commit,
      version,
      sdkVersion,
      crtVersion,
      visualStudioVersion,
    ] = args;
    await stageWindowsLayout({
      target,
      installerFamily,
      binaryPath,
      resourceRoot,
      binaryRoot,
      stageRoot,
      commit,
      version,
      buildInputs: {
        sdk_version: sdkVersion,
        crt_version: crtVersion,
        visual_studio_version: visualStudioVersion,
      },
    });
  } else if (command === "verify-layout") {
    const [stageRoot, target, installerFamily, commit, version] = args;
    await verifyWindowsLayout({
      stageRoot,
      target,
      installerFamily,
      commit,
      version,
    });
  } else {
    throw new Error(
      "Usage: windows-packages.mjs config <architecture> <family> <webview-mode> | stage <bundle-root> <output-root> <architecture> <family> <webview-mode> | stage-layout <target> <family> <binary> <resource-root> <binary-root> <stage-root> <commit> <version> <sdk> <crt> <vs> | verify-layout <stage-root> <target> <family> <commit> <version>",
    );
  }
}
