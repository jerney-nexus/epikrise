import { describe, expect, it } from "vitest";
import {
  assertNativeBuildMetadata,
  verifyNativeBuildEnvironment,
} from "../scripts/verify-native-build-environment.mjs";

const nativeTargets = [
  ["Linux", "X64", "linux", "x86_64", "x86_64-unknown-linux-gnu"],
  ["Linux", "ARM64", "linux", "aarch64", "aarch64-unknown-linux-gnu"],
  ["macOS", "X64", "darwin", "x86_64", "x86_64-apple-darwin"],
  ["macOS", "ARM64", "darwin", "aarch64", "aarch64-apple-darwin"],
  ["Windows", "X64", "windows", "x86_64", "x86_64-pc-windows-msvc"],
  ["Windows", "ARM64", "windows", "aarch64", "aarch64-pc-windows-msvc"],
] as const;

describe("native Actions build environment", () => {
  it.each(nativeTargets)(
    "accepts matching runner, physical host, Rust host, and target for %s %s",
    (runnerOS, runnerArch, physicalOS, physicalArch, target) => {
      expect(
        verifyNativeBuildEnvironment({
          runnerOS,
          runnerArch,
          physicalOS,
          physicalArch,
          rustHost: target,
          target,
          buildMode: "diagnostic",
        }),
      ).toMatchObject({ target, build_mode: "diagnostic" });
    },
  );

  it("accepts matching signed-release metadata", () => {
    expect(
      assertNativeBuildMetadata({
        runnerOS: "Windows",
        runnerArch: "ARM64",
        rustHost: "aarch64-pc-windows-msvc",
        target: "aarch64-pc-windows-msvc",
        buildMode: "signed-release",
      }),
    ).toMatchObject({ build_mode: "signed-release" });
  });

  it.each([
    [
      { runnerOS: "Linux", target: "x86_64-apple-darwin" },
      "Actions runner OS Linux does not match target",
    ],
    [
      { runnerArch: "ARM64", target: "x86_64-unknown-linux-gnu" },
      "Actions runner architecture ARM64 does not match target",
    ],
    [
      {
        runnerOS: "macOS",
        physicalOS: "linux",
        rustHost: "x86_64-apple-darwin",
        target: "x86_64-apple-darwin",
      },
      "Physical host OS linux does not match target",
    ],
    [
      { physicalArch: "aarch64", target: "x86_64-unknown-linux-gnu" },
      "Physical host architecture aarch64 does not match target",
    ],
    [
      { rustHost: "aarch64-unknown-linux-gnu" },
      "Rust host aarch64-unknown-linux-gnu does not match selected target",
    ],
    [{ buildMode: "cross" }, "Unsupported native build mode: cross."],
  ])("rejects mismatched native evidence", (overrides, error) => {
    const [runnerOS, runnerArch, physicalOS, physicalArch, target] = nativeTargets[0];
    expect(() =>
      verifyNativeBuildEnvironment({
        runnerOS,
        runnerArch,
        physicalOS,
        physicalArch,
        rustHost: target,
        target,
        buildMode: "diagnostic",
        ...overrides,
      }),
    ).toThrow(error);
  });
});
