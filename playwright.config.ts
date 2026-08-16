import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: /.*\.spec\.ts/,
  // One worker: the spec's scenarios share the anvil chain started by the
  // global setup, and each seeds its own offering, so ordering stays simple.
  workers: 1,
  globalSetup: "./tests/e2e-setup.ts",
  globalTeardown: "./tests/e2e-teardown.ts",
  use: {
    baseURL: "http://localhost:4173",
    trace: "on-first-retry",
  },
  webServer: {
    // Serves the Vite build output from dist/; `npm run test:e2e` builds first.
    command: "npx vite preview --port 4173 --strictPort",
    url: "http://localhost:4173/",
    reuseExistingServer: !process.env.CI,
  },
});
