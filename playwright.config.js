import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: /.*\.spec\.js/,
  use: {
    baseURL: 'http://localhost:7228',
    trace: 'on-first-retry',
  },
  webServer: {
    // Serves the Vite build output from dist/ plus /api; `npm run test:e2e` builds first.
    command: 'node server.js',
    url: 'http://localhost:7228/healthz',
    reuseExistingServer: !process.env.CI,
    env: {
      PACT_DB_PATH: '.tmp/e2e.sqlite',
      PACT_RESET_DB: '1',
      PORT: '7228',
    },
  },
});
