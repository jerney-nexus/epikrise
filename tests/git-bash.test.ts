import path from "node:path";
import { describe, expect, it } from "vitest";
import { findGitBash } from "../scripts/git-bash.mjs";

describe("Git Bash selection", () => {
  it("prefers a verified Git for Windows installation over PATH bash", () => {
    const expectedGitBash = path.win32.join(
      "C:\\Program Files",
      "Git",
      "bin",
      "bash.exe",
    );
    const pathBash = path.win32.join("C:\\Windows\\System32", "bash.exe");

    expect(
      findGitBash(
        {
          ProgramFiles: "C:\\Program Files",
          PATH: `C:\\Windows\\System32${path.win32.delimiter}C:\\Git\\bin`,
        },
        (candidate) => [expectedGitBash, pathBash].includes(candidate),
        (candidate) => candidate === expectedGitBash,
      ),
    ).toBe(expectedGitBash);
  });

  it("rejects PATH bash executables that are not Git Bash", () => {
    expect(
      findGitBash(
        { PATH: `C:\\Windows\\System32${path.win32.delimiter}C:\\WSL` },
        () => true,
        () => false,
      ),
    ).toBeUndefined();
  });
});
