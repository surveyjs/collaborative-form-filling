import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3001",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // The dev script boots Express + Vite middleware + Socket.IO on a single
  // port (3001); the client is served from there too.
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3001/health",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
