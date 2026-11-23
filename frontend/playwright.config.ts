import { defineConfig, devices } from "@playwright/test";

// Expects the API on :8000 (migrated DB) and starts Vite if it is not already running.
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  use: { baseURL: process.env.AUREX_WEB_URL ?? "http://localhost:5173", trace: "off" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: process.env.AUREX_WEB_URL
    ? undefined
    : { command: "npm run dev", url: "http://localhost:5173", reuseExistingServer: true, timeout: 60_000 },
});
