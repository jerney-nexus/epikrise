import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertStoreVersionAdvances,
  deriveReleaseVersions,
} from "./prepare-release.mjs";
import { verifyBinaryArchitecture } from "./verify-binary-architecture.mjs";

const storeIdentity = {
  name: "JerneyNexus.Epikrise",
  publisher: "CN=902B70F1-3B51-4D25-9253-8C079B1E0AFD",
  publisherDisplayName: "Jerney Nexus",
};

const architectureTargets = {
  x64: "x86_64-pc-windows-msvc",
  arm64: "aarch64-pc-windows-msvc",
};

/** @typedef {keyof typeof architectureTargets} StoreArchitecture */
/**
 * @typedef {{
 *   repoRoot: string,
 *   architecture: StoreArchitecture,
 *   target: string,
 *   buildDirectory: string,
 *   stageDirectory: string,
 *   previousStoreVersion?: string
 * }} PrepareStoreMsixOptions
 */
/**
 * @typedef {{
 *   layoutDirectory: string,
 *   architecture: StoreArchitecture,
 *   target: string,
 *   version: string
 * }} VerifyStoreMsixOptions
 */

const payloadFiles = [
  "epikrise.exe",
  "resources/ocr/pdfium/pdfium.dll",
  "resources/ocr/tessdata/deu.traineddata",
  "resources/ocr/tessdata/eng.traineddata",
  "Assets/StoreLogo.png",
  "Assets/Square150x150Logo.png",
  "Assets/Square44x44Logo.png",
];

/**
 * @param {unknown} condition
 * @param {string} message
 * @returns {asserts condition}
 */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** @param {string} xml @param {string} name @returns {string} */
function manifestElement(xml, name) {
  const match = new RegExp(`<${name}\\b([^>]*)>`, "s").exec(xml);
  assert(match, `MSIX manifest is missing the ${name} element.`);
  return match[1];
}

/** @param {string} element @param {string} name @returns {string} */
function manifestAttribute(element, name) {
  const match = new RegExp(`(?:^|\\s)${name}="([^"]*)"`, "s").exec(element);
  assert(match, `MSIX manifest element is missing ${name}.`);
  return match[1];
}

/** @param {string} xml @param {string} name @returns {string} */
function manifestText(xml, name) {
  const match = new RegExp(`<${name}\\b[^>]*>([^<]*)</${name}>`, "s").exec(xml);
  assert(match, `MSIX manifest is missing the ${name} element.`);
  return match[1].trim();
}

/** @param {string} filePath @param {string} label @returns {Promise<void>} */
async function assertRegularFile(filePath, label) {
  /** @type {import("node:fs").Stats} */
  let metadata;
  try {
    metadata = await lstat(filePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`Required MSIX ${label} is missing: ${filePath}.`, {
        cause: error,
      });
    }
    throw error;
  }
  assert(
    metadata.isFile() && !metadata.isSymbolicLink(),
    `MSIX ${label} must be a regular file: ${filePath}.`,
  );
  assert(metadata.size > 0, `MSIX ${label} is empty: ${filePath}.`);
}

/** @param {string} directory @param {string} [relativeDirectory] @returns {Promise<string[]>} */
async function listFiles(directory, relativeDirectory = "") {
  const files = [];
  for (const entry of await readdir(path.join(directory, relativeDirectory), {
    withFileTypes: true,
  })) {
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(directory, relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    } else {
      throw new Error(`MSIX layout contains a non-regular entry: ${relativePath}.`);
    }
  }
  return files;
}

/** @param {string} xml @param {StoreArchitecture} architecture @param {string} version */
function validateManifest(xml, architecture, version) {
  assert(
    xml.startsWith('<?xml version="1.0"'),
    "MSIX manifest must begin with an XML declaration.",
  );
  const identity = manifestElement(xml, "Identity");
  assert(
    manifestAttribute(identity, "Name") === storeIdentity.name,
    "MSIX manifest identity name does not match the reserved Store identity.",
  );
  assert(
    manifestAttribute(identity, "Publisher") === storeIdentity.publisher,
    "MSIX manifest publisher does not match the reserved Store publisher.",
  );
  assert(
    manifestAttribute(identity, "Version") === version,
    `MSIX manifest version does not match ${version}.`,
  );
  assert(
    manifestAttribute(identity, "ProcessorArchitecture") === architecture,
    `MSIX manifest architecture does not match ${architecture}.`,
  );
  assert(
    xml.includes(
      `<PublisherDisplayName>${storeIdentity.publisherDisplayName}</PublisherDisplayName>`,
    ),
    "MSIX manifest publisher display name does not match.",
  );

  const application = manifestElement(xml, "Application");
  assert(
    manifestAttribute(application, "Executable") === "epikrise.exe",
    "MSIX application entrypoint must be epikrise.exe, not an installer.",
  );
  assert(
    manifestAttribute(application, "EntryPoint") === "Windows.FullTrustApplication",
    "MSIX application must use the full-trust desktop entrypoint.",
  );
  assert(
    xml.includes('<rescap:Capability Name="runFullTrust"'),
    "MSIX manifest must declare the full-trust capability.",
  );
}

/**
 * @param {string} layoutDirectory
 * @param {StoreArchitecture} architecture
 * @param {string} version
 * @param {string} target
 * @returns {Promise<void>}
 */
async function validateLayout(layoutDirectory, architecture, version, target) {
  const manifestPath = path.join(layoutDirectory, "AppxManifest.xml");
  await assertRegularFile(manifestPath, "manifest");
  const xml = await readFile(manifestPath, "utf8");
  validateManifest(xml, architecture, version);

  const expectedFiles = [...payloadFiles, "tesseract.exe", "AppxManifest.xml"];
  for (const relativePath of expectedFiles) {
    await assertRegularFile(path.join(layoutDirectory, relativePath), "payload file");
  }

  const manifestAssets = [
    manifestText(xml, "Logo"),
    manifestAttribute(manifestElement(xml, "uap:VisualElements"), "Square150x150Logo"),
    manifestAttribute(manifestElement(xml, "uap:VisualElements"), "Square44x44Logo"),
  ].map((asset) => asset.replaceAll("\\", "/"));
  for (const asset of manifestAssets) {
    assert(
      expectedFiles.includes(asset),
      `MSIX manifest references an unexpected asset: ${asset}.`,
    );
    await assertRegularFile(path.join(layoutDirectory, asset), "manifest asset");
  }

  for (const executable of [
    "epikrise.exe",
    "tesseract.exe",
    "resources/ocr/pdfium/pdfium.dll",
  ]) {
    await verifyBinaryArchitecture(target, path.join(layoutDirectory, executable));
  }
}

/** @param {PrepareStoreMsixOptions} options @returns {Promise<{ version: string }>} */
export async function prepareStoreMsixLayout({
  repoRoot,
  architecture,
  target,
  buildDirectory,
  stageDirectory,
  previousStoreVersion,
}) {
  const expectedTarget = architectureTargets[architecture];
  assert(expectedTarget, `Unsupported Store MSIX architecture: ${architecture}.`);
  assert(target === expectedTarget, `Target ${target} does not match ${architecture}.`);

  const packageJson = JSON.parse(
    await readFile(path.join(repoRoot, "package.json"), "utf8"),
  );
  const versions = deriveReleaseVersions(packageJson.version);
  if (previousStoreVersion) {
    assertStoreVersionAdvances(packageJson.version, previousStoreVersion);
  }
  const version = versions.msixIdentityVersion;

  /** @type {Array<[string, string]>} */
  const sources = [
    [path.join(buildDirectory, "epikrise.exe"), "epikrise.exe"],
    [
      path.join(repoRoot, "src-tauri", "binaries", `tesseract-${target}.exe`),
      "tesseract.exe",
    ],
    [
      path.join(repoRoot, "src-tauri", "resources", "ocr", "pdfium", "pdfium.dll"),
      "resources/ocr/pdfium/pdfium.dll",
    ],
    [
      path.join(
        repoRoot,
        "src-tauri",
        "resources",
        "ocr",
        "tessdata",
        "deu.traineddata",
      ),
      "resources/ocr/tessdata/deu.traineddata",
    ],
    [
      path.join(
        repoRoot,
        "src-tauri",
        "resources",
        "ocr",
        "tessdata",
        "eng.traineddata",
      ),
      "resources/ocr/tessdata/eng.traineddata",
    ],
    [
      path.join(repoRoot, "src-tauri", "icons", "StoreLogo.png"),
      "Assets/StoreLogo.png",
    ],
    [
      path.join(repoRoot, "src-tauri", "icons", "Square150x150Logo.png"),
      "Assets/Square150x150Logo.png",
    ],
    [
      path.join(repoRoot, "src-tauri", "icons", "Square44x44Logo.png"),
      "Assets/Square44x44Logo.png",
    ],
  ];

  for (const [sourcePath] of sources) {
    await assertRegularFile(sourcePath, "source resource");
  }
  await verifyBinaryArchitecture(target, path.join(buildDirectory, "epikrise.exe"));
  await verifyBinaryArchitecture(
    target,
    path.join(repoRoot, "src-tauri", "binaries", `tesseract-${target}.exe`),
  );
  await verifyBinaryArchitecture(
    target,
    path.join(repoRoot, "src-tauri", "resources", "ocr", "pdfium", "pdfium.dll"),
  );

  await mkdir(stageDirectory, { recursive: false });
  for (const [sourcePath, relativePath] of sources) {
    const destination = path.join(stageDirectory, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(sourcePath, destination, 0);
  }

  const manifestTemplate = await readFile(
    path.join(repoRoot, "src-tauri", "msix", "AppxManifest.xml"),
    "utf8",
  );
  const manifest = manifestTemplate
    .replaceAll("{{VERSION}}", version)
    .replaceAll("{{ARCHITECTURE}}", architecture);
  assert(
    !manifest.includes("{{"),
    "MSIX manifest contains unresolved template values.",
  );
  await writeFile(path.join(stageDirectory, "AppxManifest.xml"), manifest, "utf8");

  const actualFiles = (await listFiles(stageDirectory)).sort();
  const expectedFiles = [...payloadFiles, "tesseract.exe", "AppxManifest.xml"].sort();
  assert(
    JSON.stringify(actualFiles) === JSON.stringify(expectedFiles),
    "MSIX staging layout contains missing or unexpected files.",
  );
  await validateLayout(stageDirectory, architecture, version, target);
  return { version };
}

/** @param {VerifyStoreMsixOptions} options @returns {Promise<void>} */
export async function verifyStoreMsixLayout({
  layoutDirectory,
  architecture,
  target,
  version,
}) {
  assert(
    architectureTargets[architecture],
    `Unsupported Store MSIX architecture: ${architecture}.`,
  );
  assert(
    target === architectureTargets[architecture],
    `Target ${target} does not match ${architecture}.`,
  );
  await validateLayout(layoutDirectory, architecture, version, target);
}

/** @param {string[]} argumentsList @returns {{ command: string | undefined, options: Record<string, string> }} */
function parseArguments(argumentsList) {
  const [command, ...rest] = argumentsList;
  /** @type {Record<string, string>} */
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error(`Invalid command argument: ${key ?? ""}.`);
    }
    options[key.slice(2)] = value;
  }
  return { command, options };
}

/** @param {string} value @returns {StoreArchitecture} */
function parseArchitecture(value) {
  if (value !== "x64" && value !== "arm64") {
    throw new Error(`Unsupported Store MSIX architecture: ${value}.`);
  }
  return value;
}

/** @param {Record<string, string>} options @param {string} name @returns {string} */
function requiredOption(options, name) {
  const value = options[name];
  if (!value) throw new Error(`Missing required command option --${name}.`);
  return value;
}

/** @param {string[]} argumentsList @returns {Promise<void>} */
async function runCli(argumentsList) {
  const { command, options } = parseArguments(argumentsList);
  if (command === "stage") {
    const result = await prepareStoreMsixLayout({
      repoRoot: requiredOption(options, "repo"),
      architecture: parseArchitecture(requiredOption(options, "architecture")),
      target: requiredOption(options, "target"),
      buildDirectory: requiredOption(options, "build-directory"),
      stageDirectory: requiredOption(options, "stage-directory"),
      previousStoreVersion: options["previous-store-version"],
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "verify") {
    await verifyStoreMsixLayout({
      layoutDirectory: requiredOption(options, "layout"),
      architecture: parseArchitecture(requiredOption(options, "architecture")),
      target: requiredOption(options, "target"),
      version: requiredOption(options, "version"),
    });
    process.stdout.write("Verified unpacked Store MSIX layout.\n");
    return;
  }
  throw new Error("Usage: store-msix.mjs stage|verify [options]");
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await runCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
