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
});
