import { defineConfig, devices } from "@playwright/test";

const projects = [
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
  reporter: "list",
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
    timeout: 120_000,
  },
});
