import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./playwright-tests",

  /* Run tests sequentially so videos don't overlap */
  workers: 1,

  /* Retry once on failure before marking as failed */
  retries: 1,

  /* Default timeout per test — increased for CI environments with network latency */
  timeout: process.env["CI"] ? 60_000 : 30_000,
  
  /* Timeout for expect() assertions */
  expect: {
    timeout: 10_000,
  },

  /* Reporters */
  reporter: [
    ["list"],
    ["html", { outputFolder: "test-results/html-report", open: "never" }],
    ["json", { outputFile: "test-results/results.json" }],
  ],

  use: {
    /* Base URL — overridable via env var */
    baseURL:
      process.env["BASE_URL"] ??
      "https://opensource-demo.orangehrmlive.com/",

    /* ── Video recording ───────────────────────────────────────────────────
     *
     *  "on"                — record every test
     *  "off"               — never record
     *  "retain-on-failure" — keep only videos where the test failed
     *  "on-first-retry"    — record only on the first retry
     *
     * Videos are written to:
     *   test-results/<test-name>/video.webm
     * ─────────────────────────────────────────────────────────────────── */
    video: "on",

    /* Record the viewport at this resolution */
    viewport: { width: 1280, height: 720 },

    /* Capture a screenshot on failure (complements the video) */
    screenshot: "only-on-failure",

    /* Attach a full trace on first retry for debugging */
    trace: "on-first-retry",

    /* Slow down each action by 150 ms so videos are readable */
    launchOptions: {
      slowMo: 150,
    },
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  /* Output directory for all test artefacts (videos, screenshots, traces) */
  outputDir: "test-results",
});
