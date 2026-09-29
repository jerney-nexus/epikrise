import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import TOML from "@iarna/toml";
import { describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);

describe("frontend test harness", () => {
  it("executes Vitest with the project configuration", () => {
    expect(true).toBe(true);
  });

  it("converts a text prompt into a TOML template", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "epikrise-template-"));
    const inputPath = path.join(directory, "prompt.txt");
    const outputPath = path.join(directory, "converted.epitpl");
    const scriptPath = new URL("../scripts/convert-prompt.mjs", import.meta.url)
      .pathname;

    try {
      await writeFile(inputPath, "Synthetic test prompt", "utf8");
      await execFile(process.execPath, [scriptPath, inputPath, outputPath]);

      const template = TOML.parse(await readFile(outputPath, "utf8"));
      expect(template.system_prompt).toBe("Synthetic test prompt");
      expect(template.sections).toHaveLength(1);
      expect(template.schema_version).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
