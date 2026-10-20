import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateNativeCargoTarget } from "../scripts/validate-native-cargo-target.mjs";

const hostTriple = "x86_64-unknown-linux-gnu";
const crossTarget = "aarch64-unknown-linux-gnu";

describe("native Cargo target validation", () => {
  it("rejects a target from the project Cargo configuration", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "epikrise-cargo-config-"));
    const cargoHome = path.join(directory, "cargo-home");

    try {
      await mkdir(path.join(directory, ".cargo"), { recursive: true });
      await mkdir(cargoHome);
      await writeFile(
        path.join(directory, ".cargo/config.toml"),
        `[build]\ntarget = "${crossTarget}"\n`,
      );

      expect(() =>
        validateNativeCargoTarget(hostTriple, ["tauri", "build"], {
          tauriBuild: true,
          cwd: directory,
          env: { CARGO_HOME: cargoHome },
        }),
      ).toThrow(`Requested target ${crossTarget} does not match native host`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("prefers extensionless Cargo configuration over config.toml", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "epikrise-cargo-config-"));
    const cargoHome = path.join(directory, "cargo-home");
    const projectCargo = path.join(directory, ".cargo");

    try {
      await mkdir(projectCargo, { recursive: true });
      await mkdir(cargoHome);
      await writeFile(
        path.join(projectCargo, "config"),
        `[build]\ntarget = "${crossTarget}"\n`,
      );
      await writeFile(
        path.join(projectCargo, "config.toml"),
        `[build]\ntarget = "${hostTriple}"\n`,
      );

      expect(() =>
        validateNativeCargoTarget(hostTriple, ["tauri", "build"], {
          tauriBuild: true,
          cwd: directory,
          env: { CARGO_HOME: cargoHome },
        }),
      ).toThrow(`Requested target ${crossTarget} does not match native host`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("prefers extensionless Cargo home configuration over config.toml", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "epikrise-cargo-config-"));
    const cargoHome = path.join(directory, "cargo-home");

    try {
      await mkdir(cargoHome);
      await writeFile(
        path.join(cargoHome, "config"),
        `[build]\ntarget = "${crossTarget}"\n`,
      );
      await writeFile(
        path.join(cargoHome, "config.toml"),
        `[build]\ntarget = "${hostTriple}"\n`,
      );

      expect(() =>
        validateNativeCargoTarget(hostTriple, ["tauri", "build"], {
          tauriBuild: true,
          cwd: directory,
          env: { CARGO_HOME: cargoHome },
        }),
      ).toThrow(`Requested target ${crossTarget} does not match native host`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("merges target arrays from Cargo home and project configuration", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "epikrise-cargo-config-"));
    const cargoHome = path.join(directory, "cargo-home");
    const projectCargo = path.join(directory, ".cargo");

    try {
      await mkdir(cargoHome);
      await mkdir(projectCargo);
      await writeFile(
        path.join(cargoHome, "config.toml"),
        `[build]\ntarget = ["${crossTarget}"]\n`,
      );
      await writeFile(
        path.join(projectCargo, "config.toml"),
        `[build]\ntarget = ["${hostTriple}"]\n`,
      );

      expect(() =>
        validateNativeCargoTarget(hostTriple, ["tauri", "build"], {
          tauriBuild: true,
          cwd: directory,
          env: { CARGO_HOME: cargoHome },
        }),
      ).toThrow(`Requested target ${crossTarget} does not match native host`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("merges target arrays from repeated Cargo --config overrides", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "epikrise-cargo-config-"));
    const cargoHome = path.join(directory, "cargo-home");

    try {
      await mkdir(cargoHome);
      expect(() =>
        validateNativeCargoTarget(
          hostTriple,
          [
            "tauri",
            "build",
            "--",
            "--config",
            `build.target=["${crossTarget}"]`,
            "--config",
            `build.target=["${hostTriple}"]`,
          ],
          {
            tauriBuild: true,
            cwd: directory,
            env: { CARGO_HOME: cargoHome },
          },
        ),
      ).toThrow(`Requested target ${crossTarget} does not match native host`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("merges target arrays from Cargo config files and --config overrides", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "epikrise-cargo-config-"));
    const cargoHome = path.join(directory, "cargo-home");

    try {
      await mkdir(cargoHome);
      await mkdir(path.join(directory, ".cargo"));
      await writeFile(
        path.join(directory, ".cargo/config.toml"),
        `[build]\ntarget = ["${crossTarget}"]\n`,
      );

      expect(() =>
        validateNativeCargoTarget(
          hostTriple,
          ["tauri", "build", "--", "--config", `build.target=["${hostTriple}"]`],
          {
            tauriBuild: true,
            cwd: directory,
            env: { CARGO_HOME: cargoHome },
          },
        ),
      ).toThrow(`Requested target ${crossTarget} does not match native host`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("resolves relative CARGO_HOME from Tauri's Cargo working directory", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "epikrise-cargo-config-"));
    const cargoHome = path.join(directory, "cargo-home");

    try {
      await mkdir(path.join(directory, "src-tauri"), { recursive: true });
      await mkdir(cargoHome);
      await writeFile(
        path.join(cargoHome, "config.toml"),
        `[build]\ntarget = "${crossTarget}"\n`,
      );

      expect(() =>
        validateNativeCargoTarget(hostTriple, ["tauri", "build"], {
          tauriBuild: true,
          cwd: directory,
          env: { CARGO_HOME: "../cargo-home" },
        }),
      ).toThrow(`Requested target ${crossTarget} does not match native host`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses src-tauri as the Cargo configuration directory for Tauri builds", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "epikrise-cargo-config-"));
    const cargoHome = path.join(directory, "cargo-home");
    const tauriDirectory = path.join(directory, "src-tauri");

    try {
      await mkdir(path.join(tauriDirectory, ".cargo"), { recursive: true });
      await mkdir(cargoHome);
      await writeFile(
        path.join(tauriDirectory, ".cargo/config.toml"),
        `[build]\ntarget = "${crossTarget}"\n`,
      );

      expect(() =>
        validateNativeCargoTarget(hostTriple, ["tauri", "build"], {
          tauriBuild: true,
          cwd: directory,
          env: { CARGO_HOME: cargoHome },
        }),
      ).toThrow(`Requested target ${crossTarget} does not match native host`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("resolves relative forwarded Cargo config paths from src-tauri", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "epikrise-cargo-config-"));
    const cargoHome = path.join(directory, "cargo-home");
    const overrideDirectory = path.join(directory, "src-tauri", "overrides");

    try {
      await mkdir(overrideDirectory, { recursive: true });
      await mkdir(cargoHome);
      await writeFile(
        path.join(overrideDirectory, "cross-target.toml"),
        `[build]\ntarget = "${crossTarget}"\n`,
      );

      expect(() =>
        validateNativeCargoTarget(
          hostTriple,
          ["tauri", "build", "--", "--config", "overrides/cross-target.toml"],
          {
            tauriBuild: true,
            cwd: directory,
            env: { CARGO_HOME: cargoHome },
          },
        ),
      ).toThrow(`Requested target ${crossTarget} does not match native host`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a forwarded Cargo --config inline target before application args", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "epikrise-cargo-config-"));
    const cargoHome = path.join(directory, "cargo-home");

    try {
      await mkdir(cargoHome);
      expect(() =>
        validateNativeCargoTarget(
          hostTriple,
          ["tauri", "build", "--", "--config", `build.target="${crossTarget}"`],
          {
            tauriBuild: true,
            cwd: directory,
            env: { CARGO_HOME: cargoHome },
          },
        ),
      ).toThrow(`Requested target ${crossTarget} does not match native host`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a target from a forwarded Cargo --config file", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "epikrise-cargo-config-"));
    const cargoHome = path.join(directory, "cargo-home");
    const overridePath = path.join(directory, "override.toml");

    try {
      await mkdir(cargoHome);
      await writeFile(overridePath, `[build]\ntarget = "${crossTarget}"\n`);

      expect(() =>
        validateNativeCargoTarget(
          hostTriple,
          ["tauri", "build", "--", "--config", overridePath],
          {
            tauriBuild: true,
            cwd: directory,
            env: { CARGO_HOME: cargoHome },
          },
        ),
      ).toThrow(`Requested target ${crossTarget} does not match native host`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("ignores Tauri --config and application arguments when resolving Cargo targets", () => {
    expect(
      validateNativeCargoTarget(
        hostTriple,
        [
          "tauri",
          "build",
          "--config",
          "tauri.conf.json",
          "--",
          "--",
          "--config",
          `build.target="${crossTarget}"`,
        ],
        {
          tauriDev: true,
          env: { CARGO_HOME: path.join(tmpdir(), "epikrise-empty-cargo-home") },
        },
      ),
    ).toEqual([]);
  });

  it("allows a native explicit target to override a cross-target config", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "epikrise-cargo-config-"));
    const cargoHome = path.join(directory, "cargo-home");

    try {
      await mkdir(path.join(directory, ".cargo"), { recursive: true });
      await mkdir(cargoHome);
      await writeFile(
        path.join(directory, ".cargo/config.toml"),
        `[build]\ntarget = "${crossTarget}"\n`,
      );

      expect(
        validateNativeCargoTarget(
          hostTriple,
          ["tauri", "build", "--target", hostTriple],
          {
            tauriBuild: true,
            cwd: directory,
            env: { CARGO_HOME: cargoHome },
          },
        ),
      ).toEqual([hostTriple]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("allows a Cargo --config target override to supersede the environment target", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "epikrise-cargo-config-"));
    const cargoHome = path.join(directory, "cargo-home");

    try {
      await mkdir(cargoHome);
      expect(
        validateNativeCargoTarget(
          hostTriple,
          ["tauri", "build", "--", "--config", `build.target="${hostTriple}"`],
          {
            tauriBuild: true,
            cwd: directory,
            env: {
              CARGO_HOME: cargoHome,
              CARGO_BUILD_TARGET: crossTarget,
            },
          },
        ),
      ).toEqual([hostTriple]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("ignores target-like text in attached Tauri feature values", () => {
    expect(
      validateNativeCargoTarget(
        hostTriple,
        ["tauri", "build", "-fdirect-release-updater"],
        {
          tauriBuild: true,
          env: { CARGO_HOME: path.join(tmpdir(), "epikrise-empty-cargo-home") },
        },
      ),
    ).toEqual([]);
  });

  it.each([
    ["split target", ["tauri", "build", "-dt", hostTriple]],
    ["attached target", ["tauri", "build", `-dvt${hostTriple}`]],
  ])("accepts a native target in a debug cluster (%s)", (_form, args) => {
    expect(
      validateNativeCargoTarget(hostTriple, args, {
        tauriBuild: true,
        env: { CARGO_HOME: path.join(tmpdir(), "epikrise-empty-cargo-home") },
      }),
    ).toEqual([hostTriple]);
  });

  it.each([
    ["split", ["tauri", "build", "--", "--target-dir", "custom-target"]],
    ["equals", ["tauri", "build", "--", "--target-dir=custom-target"]],
  ])("rejects a forwarded Cargo target directory override (%s)", (_form, args) => {
    expect(() =>
      validateNativeCargoTarget(hostTriple, args, { tauriBuild: true }),
    ).toThrow("Cargo --target-dir is not allowed for native Tauri builds");
  });

  it("rejects a forwarded target directory in inline Cargo config", () => {
    expect(() =>
      validateNativeCargoTarget(
        hostTriple,
        ["tauri", "build", "--", "--config", 'build.target-dir = "/tmp/native-target"'],
        { tauriBuild: true },
      ),
    ).toThrow("Cargo build.target-dir is not allowed for native Tauri builds");
  });

  it("rejects a forwarded target directory in a Cargo config file", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "epikrise-cargo-config-"));
    const cargoHome = path.join(directory, "cargo-home");
    const configPath = path.join(directory, "target-dir.toml");

    try {
      await mkdir(cargoHome);
      await writeFile(configPath, '[build]\ntarget-dir = "/tmp/native-target"\n');

      expect(() =>
        validateNativeCargoTarget(
          hostTriple,
          ["tauri", "build", "--", "--config", configPath],
          {
            tauriBuild: true,
            cwd: directory,
            env: { CARGO_HOME: cargoHome },
          },
        ),
      ).toThrow("Cargo build.target-dir is not allowed for native Tauri builds");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
