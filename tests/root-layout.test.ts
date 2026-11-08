import { describe, expect, it } from "vitest";
import * as layout from "../src/routes/+layout";

describe("root layout load configuration", () => {
  it("disables SSR so the Tauri app runs as a SPA", () => {
    expect(layout.ssr).toBe(false);
  });
});
