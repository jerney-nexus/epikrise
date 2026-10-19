import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import TOML from "@iarna/toml";

/** @typedef {Record<string, unknown>} CargoConfig */

/**
 * @param {CargoConfig} config
 * @param {string} source
 * @returns {string[] | undefined}
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
  const targets = Array.isArray(target) ? target : [target];
  if (!targets.every((target) => typeof target === "string" && target.length > 0)) {
    throw new Error(`${source} has an invalid build.target value.`);
  }
  return /** @type {string[]} */ (targets);
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

  const cargoHome = path.resolve(env.CARGO_HOME || path.join(os.homedir(), ".cargo"));
  const configPaths = [
    path.join(cargoHome, "config"),
    path.join(cargoHome, "config.toml"),
    ...directories.flatMap((directory) => [
      path.join(directory, ".cargo", "config"),
      path.join(directory, ".cargo", "config.toml"),
    ]),
  ];
  /** @type {string[]} */
  let targets = [];
  let configured = false;

  for (const configPath of configPaths) {
    if (!existsSync(configPath)) continue;
    const configuredTargets = targetValues(
      parseConfigFile(configPath, configPath),
      configPath,
    );
    if (configuredTargets !== undefined) {
      targets = configuredTargets;
      configured = true;
    }
  }

  return { targets, configured };
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
  /** @type {string[]} */
  let targets = [];
  let configured = false;
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
    if (configuredTargets !== undefined) {
      targets = configuredTargets;
      configured = true;
    }
  }
  return { targets, configured };
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
  if (!/^v*$/.test(cluster.slice(0, targetIndex))) {
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

    if (parseConfig && (argument === "--config" || argument.startsWith("--config="))) {
      configs.push(argument);
      if (argument === "--config") {
        if (!args[index + 1]) throw new Error("Missing value for Cargo --config.");
        configs.push(args[++index]);
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

  const override = configTargetsFromOverrides(configOverrides, cwd);
  const fileConfig = configTargetFromDirectories(cwd, env);
  const configuredTargets = override.configured
    ? override.targets
    : env.CARGO_BUILD_TARGET
      ? [env.CARGO_BUILD_TARGET]
      : fileConfig.configured
        ? fileConfig.targets
        : [];
  return targets.length ? targets : configuredTargets;
}

/**
 * Validate target options and effective Cargo configuration for a native build.
 *
 * @param {string} hostTriple
 * @param {string[]} args
 * @param {{ tauriBuild?: boolean, tauriDev?: boolean, cwd?: string, env?: NodeJS.ProcessEnv }} [options]
 */
export function validateNativeCargoTarget(hostTriple, args, options = {}) {
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
