import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import TOML from "@iarna/toml";

/** @typedef {Record<string, unknown>} CargoConfig */
/** @typedef {string | string[]} CargoTarget */

/**
 * @param {CargoConfig} config
 * @param {string} source
 * @returns {CargoTarget | undefined}
 */
function targetValues(config, source) {
  const build = config.build;
  if (build === undefined) {
    return undefined;
  }
  if (typeof build !== "object" || build === null || Array.isArray(build)) {
    throw new Error(`${source} has an invalid build table.`);
  }

  const target = /** @type {Record<string, unknown>} */ (build).target;
  if (target === undefined) return undefined;
  if (typeof target === "string" && target.length > 0) return target;
  if (
    Array.isArray(target) &&
    target.every((value) => typeof value === "string" && value.length > 0)
  ) {
    return /** @type {string[]} */ (target);
  }
  throw new Error(`${source} has an invalid build.target value.`);
}

/**
 * @param {CargoTarget | undefined} previous
 * @param {CargoTarget | undefined} next
 * @returns {CargoTarget | undefined}
 */
function mergeTargetValues(previous, next) {
  if (next === undefined) return previous;
  if (Array.isArray(previous) && Array.isArray(next)) {
    return [...previous, ...next];
  }
  return next;
}

/**
 * @param {string} filePath
 * @param {string} source
 * @returns {CargoConfig}
 */
function parseConfigFile(filePath, source) {
  try {
    return /** @type {CargoConfig} */ (TOML.parse(readFileSync(filePath, "utf8")));
  } catch (error) {
    throw new Error(
      `Could not read Cargo configuration from ${source}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/** @param {string} directory */
function preferredConfigFile(directory) {
  const extensionless = path.join(directory, "config");
  if (existsSync(extensionless)) return extensionless;

  const toml = path.join(directory, "config.toml");
  return existsSync(toml) ? toml : undefined;
}

/**
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} env
 */
function configTargetFromDirectories(cwd, env) {
  const directories = [];
  for (let directory = path.resolve(cwd); ; directory = path.dirname(directory)) {
    directories.unshift(directory);
    if (path.dirname(directory) === directory) break;
  }
  const cargoHome = path.resolve(
    cwd,
    env.CARGO_HOME || path.join(os.homedir(), ".cargo"),
  );
  const configPaths = [];
  const cargoHomeConfig = preferredConfigFile(cargoHome);
  if (cargoHomeConfig) configPaths.push(cargoHomeConfig);
  for (const directory of directories) {
    const configPath = preferredConfigFile(path.join(directory, ".cargo"));
    if (configPath) configPaths.push(configPath);
  }
  /** @type {CargoTarget | undefined} */
  let targets;

  for (const configPath of configPaths) {
    if (!existsSync(configPath)) continue;
    const configuredTargets = targetValues(
      parseConfigFile(configPath, configPath),
      configPath,
    );
    targets = mergeTargetValues(targets, configuredTargets);
  }

  return { targets, configured: targets !== undefined };
}

/** @param {string} value */
function parseInlineConfig(value) {
  try {
    return /** @type {CargoConfig} */ (TOML.parse(value));
  } catch (error) {
    throw new Error(
      `Invalid Cargo --config value ${JSON.stringify(value)}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/**
 * @param {string[]} args
 * @param {string} cwd
 */
function configTargetsFromOverrides(args, cwd) {
  /** @type {CargoTarget | undefined} */
  let targets;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") break;

    let value;
    if (argument === "--config") {
      value = args[++index];
      if (!value) throw new Error("Missing value for Cargo --config.");
    } else if (argument.startsWith("--config=")) {
      value = argument.slice("--config=".length);
      if (!value) throw new Error("Missing value for Cargo --config.");
    } else {
      continue;
    }

    const configPath = path.resolve(cwd, value);
    const config = existsSync(configPath)
      ? parseConfigFile(configPath, configPath)
      : parseInlineConfig(value);
    const configuredTargets = targetValues(
      config,
      `Cargo --config ${JSON.stringify(value)}`,
    );
    targets = mergeTargetValues(targets, configuredTargets);
  }
  return { targets, configured: targets !== undefined };
}

/**
 * @param {string[]} args
 * @param {number} index
 */
function parseShortTarget(args, index) {
  const option = args[index];
  const cluster = option.slice(1);
  const targetIndex = cluster.indexOf("t");
  if (targetIndex < 0) return undefined;
  for (const shortOption of cluster.slice(0, targetIndex)) {
    if (shortOption === "v") continue;
    if ("cFfjprZ".includes(shortOption)) return undefined;
    throw new Error(
      `Unsupported short-option cluster containing target shorthand: ${option}. Use -t or -vt.`,
    );
  }

  let target = cluster.slice(targetIndex + 1);
  if (target.startsWith("=")) target = target.slice(1);
  if (target) return { target, consumed: 0 };

  const next = args[index + 1];
  if (!next || next === "--") {
    throw new Error("Missing value for --target.");
  }
  return { target: next, consumed: 1 };
}

/**
 * @param {string[]} args
 * @param {number} index
 * @param {boolean} parseConfig
 */
function skipShortOptionValue(args, index, parseConfig) {
  const argument = args[index];
  if (!argument.startsWith("-") || argument.startsWith("--")) return undefined;

  const cluster = argument.slice(1);
  const valueOptions = parseConfig ? "FfjpZ" : "cFfjprZ";
  for (let optionIndex = 0; optionIndex < cluster.length; optionIndex += 1) {
    const shortOption = cluster[optionIndex];
    if (shortOption === "t") return undefined;
    if (!valueOptions.includes(shortOption)) continue;

    if (optionIndex + 1 < cluster.length) return 0;
    const value = args[index + 1];
    if (!value || value === "--") {
      throw new Error(`Missing value for -${shortOption}.`);
    }
    return 1;
  }
  return undefined;
}

/**
 * @param {string[]} args
 * @param {{ parseConfig: boolean, stopAtSeparator: boolean }} options
 */
function collectTargets(args, { parseConfig, stopAtSeparator }) {
  const targets = [];
  const configs = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") {
      if (stopAtSeparator) break;
      continue;
    }

    if (argument === "--config" || argument.startsWith("--config=")) {
      if (parseConfig) configs.push(argument);
      if (argument === "--config") {
        const value = args[++index];
        if (!value) throw new Error("Missing value for Cargo --config.");
        if (parseConfig) configs.push(value);
      }
      continue;
    }

    if (argument === "--target" || argument === "-t") {
      const target = args[++index];
      if (!target || target === "--") {
        throw new Error("Missing value for --target.");
      }
      targets.push(target);
    } else if (argument.startsWith("--target=")) {
      const target = argument.slice("--target=".length);
      if (!target) throw new Error("Missing value for --target.");
      targets.push(target);
    } else if (argument.startsWith("-t=")) {
      const target = argument.slice(3);
      if (!target) throw new Error("Missing value for --target.");
      targets.push(target);
    } else if (argument.startsWith("-") && !argument.startsWith("--")) {
      const consumed = skipShortOptionValue(args, index, parseConfig);
      if (consumed !== undefined) {
        index += consumed;
        continue;
      }
      const parsed = parseShortTarget(args, index);
      if (parsed) {
        targets.push(parsed.target);
        index += parsed.consumed;
      }
    }
  }
  return { targets, configs };
}

/**
 * Resolve target options and effective Cargo configuration for a build.
 *
 * @param {string[]} args
 * @param {{ tauriBuild?: boolean, tauriDev?: boolean, cwd?: string, env?: NodeJS.ProcessEnv }} [options]
 */
export function resolveNativeCargoTargets(
  args,
  { tauriBuild = false, tauriDev = false, cwd = process.cwd(), env = process.env } = {},
) {
  const isTauriCommand = tauriBuild || tauriDev;
  const launchDirectory = path.resolve(cwd);
  const cargoCwd = isTauriCommand
    ? path.basename(launchDirectory) === "src-tauri"
      ? launchDirectory
      : path.join(launchDirectory, "src-tauri")
    : launchDirectory;
  /** @type {string[]} */
  let targets;
  /** @type {string[]} */
  let configOverrides;

  if (isTauriCommand) {
    const separator = args.indexOf("--");
    const tauriArgs = separator < 0 ? args : args.slice(0, separator);
    const runnerArgs = separator < 0 ? [] : args.slice(separator + 1);
    const tauriOptions = collectTargets(tauriArgs, {
      parseConfig: false,
      stopAtSeparator: false,
    });
    const runnerOptions = collectTargets(runnerArgs, {
      parseConfig: true,
      stopAtSeparator: tauriDev,
    });
    targets = [...tauriOptions.targets, ...runnerOptions.targets];
    configOverrides = runnerOptions.configs;
  } else {
    const cargoOptions = collectTargets(args, {
      parseConfig: true,
      stopAtSeparator: true,
    });
    targets = cargoOptions.targets;
    configOverrides = cargoOptions.configs;
  }

  const override = configTargetsFromOverrides(configOverrides, cargoCwd);
  const fileConfig = configTargetFromDirectories(cargoCwd, env);
  let configuredTargets = fileConfig.targets;
  if (env.CARGO_BUILD_TARGET) configuredTargets = env.CARGO_BUILD_TARGET;
  if (override.configured) {
    configuredTargets = mergeTargetValues(configuredTargets, override.targets);
  }
  if (targets.length) return targets;
  if (Array.isArray(configuredTargets)) return configuredTargets;
  return configuredTargets === undefined ? [] : [configuredTargets];
}

/**
 * Validate target options and effective Cargo configuration for a native build.
 *
 * @param {string} hostTriple
 * @param {string[]} args
 * @param {{ tauriBuild?: boolean, tauriDev?: boolean, cwd?: string, env?: NodeJS.ProcessEnv }} [options]
 */
export function validateNativeCargoTarget(hostTriple, args, options = {}) {
  if (options.tauriBuild) {
    const separator = args.indexOf("--");
    const cargoArgs = separator < 0 ? [] : args.slice(separator + 1);
    if (
      cargoArgs.some(
        (argument) =>
          argument === "--target-dir" || argument.startsWith("--target-dir="),
      )
    ) {
      throw new Error(
        "Cargo --target-dir is not allowed for native Tauri builds; the host target directory is fixed.",
      );
    }
  }

  const effectiveTargets = resolveNativeCargoTargets(args, options);
  for (const target of effectiveTargets) {
    if (target !== hostTriple) {
      throw new Error(
        `Requested target ${target} does not match native host ${hostTriple}.`,
      );
    }
  }

  return effectiveTargets;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [hostTriple, mode, ...args] = process.argv.slice(2);
  const supportedModes = ["cargo", "tauri-build", "tauri-dev", "resolve-tauri-build"];
  if (!hostTriple || !supportedModes.includes(mode)) {
    console.error(
      "Usage: node validate-native-cargo-target.mjs <host-triple> <cargo|tauri-build|tauri-dev|resolve-tauri-build> [arguments...]",
    );
    process.exitCode = 2;
  } else {
    try {
      const options = {
        tauriBuild: mode === "tauri-build" || mode === "resolve-tauri-build",
        tauriDev: mode === "tauri-dev",
      };
      if (mode === "resolve-tauri-build") {
        const targets = resolveNativeCargoTargets(args, options);
        if (targets[0]) console.log(targets[0]);
      } else {
        validateNativeCargoTarget(hostTriple, args, options);
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
