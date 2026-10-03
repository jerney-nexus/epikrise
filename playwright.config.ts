/// <reference types="node" />

import { defineConfig, devices, type PlaywrightTestConfig } from "@playwright/test";
import process from "node:process";

const projects: NonNullable<PlaywrightTestConfig["projects"]> = [
  {
    name: "chromium",
    use: {
      ...devices["Desktop Chrome"],
      locale: "en-US",
      viewport: { width: 1280, height: 860 },
    },
  },
];

if (process.env.PLAYWRIGHT_CROSS_BROWSER === "1") {
  projects.push(
    {
      name: "firefox-smoke",
      testMatch: "**/smoke.spec.ts",
      use: {
        ...devices["Desktop Firefox"],
        viewport: { width: 1280, height: 860 },
      },
    },
    {
      name: "webkit-smoke",
      testMatch: "**/smoke.spec.ts",
      use: {
        ...devices["Desktop Safari"],
        viewport: { width: 1280, height: 860 },
      },
    },
  );
}

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [
    [process.env.CI ? "dot" : "list"],
    ["html", { open: "never", host: "127.0.0.1" }],
  ],
  use: {
    baseURL: "http://127.0.0.1:1420",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects,
  webServer: {
    command: "pnpm dev -- --host 127.0.0.1",
    url: "http://127.0.0.1:1420",
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000,
  },
});
