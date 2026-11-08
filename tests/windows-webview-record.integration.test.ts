import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { verifyWebViewModeRecord } from "../scripts/release-artifacts.mjs";

const execFile = promisify(execFileCallback);
const repoRoot = fileURLToPath(new URL("../", import.meta.url));

function createBinaryHeader(target: string) {
  const binary = Buffer.alloc(128);
  binary.write("MZ", 0, "ascii");
  binary.writeUInt32LE(64, 0x3c);
  binary.write("PE\0\0", 64, "binary");
  binary.writeUInt16LE(target.startsWith("x86_64-") ? 0x8664 : 0xaa64, 68);
  return binary;
}

describe("Windows WebView2 record PowerShell integration", () => {
  it("writes Windows WebView2 mode records that the staging verifier accepts", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "epikrise-webview-mode-pwsh-"));

    try {
      const bundleRoot = path.join(directory, "bundle");
      const variantDirectory = path.join(
        directory,
        "release-bundles",
        "nsis",
        "offlineInstaller",
      );
      const exePath = path.join(variantDirectory, "epikrise.exe");
      await mkdir(bundleRoot, { recursive: true });
      await writeFile(
        path.join(bundleRoot, "epikrise.exe"),
        createBinaryHeader("x86_64-pc-windows-msvc"),
      );
      await writeFile(path.join(bundleRoot, "epikrise.exe.sig"), "signature");

      await execFile("pwsh", [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        path.join(repoRoot, "scripts/write-nsis-webview-record.ps1"),
        "-BundleRoot",
        bundleRoot,
        "-VariantDirectory",
        variantDirectory,
        "-WebViewMode",
        "offlineInstaller",
      ]);

      const recordText = await readFile(
        path.join(variantDirectory, "webview-mode.json"),
        "utf8",
      );
      expect(recordText.startsWith("\uFEFF")).toBe(false);
      expect(JSON.parse(recordText)).toEqual({
        schema_version: 1,
        webview_mode: "offlineInstaller",
        package: "epikrise.exe",
        package_sha256: createHash("sha256")
          .update(await readFile(exePath))
          .digest("hex"),
      });
      await expect(
        verifyWebViewModeRecord({
          packagePath: exePath,
          expectedMode: "offlineInstaller",
        }),
      ).resolves.toBe("offlineInstaller");
      await expect(
        verifyWebViewModeRecord({
          packagePath: exePath,
          expectedMode: "embedBootstrapper",
        }),
      ).rejects.toThrow("does not match embedBootstrapper");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
