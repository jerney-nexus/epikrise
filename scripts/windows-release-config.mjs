import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @param {{ target: string, webviewMode: string }} options
 */
export function createWindowsReleaseConfig({ target, webviewMode }) {
  if (!["x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc"].includes(target)) {
    throw new Error(`Unsupported Windows release target: ${target}.`);
  }
  if (!["embedBootstrapper", "offlineInstaller"].includes(webviewMode)) {
    throw new Error(`Unsupported WebView2 installer mode: ${webviewMode}.`);
  }

  return {
    bundle: {
      targets: ["nsis"],
      windows: {
        webviewInstallMode:
          webviewMode === "offlineInstaller"
            ? { type: webviewMode, silent: true }
            : { type: webviewMode },
      },
    },
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const options = Object.fromEntries(
    process.argv.slice(2).map((argument) => {
      const separator = argument.indexOf("=");
      if (!argument.startsWith("--") || separator < 0) {
        throw new Error(`Invalid option: ${argument}.`);
      }
      return [argument.slice(2, separator), argument.slice(separator + 1)];
    }),
  );
  try {
    const config = createWindowsReleaseConfig({
      target: options.target,
      webviewMode: options["webview-mode"],
    });
    process.stdout.write(`${JSON.stringify(config)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
