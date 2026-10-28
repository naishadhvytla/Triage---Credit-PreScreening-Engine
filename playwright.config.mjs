// Playwright smoke tests: npx playwright test
// Serves app/ through tests/serve.mjs, which applies netlify.toml's redirects and headers (CSP included).
// The signed-in tests need a test account in the Supabase project from app/config.js:
//   TRIAGE_TEST_EMAIL=... TRIAGE_TEST_PASSWORD=...   (environment, or a gitignored .env file)
import {defineConfig, devices} from "@playwright/test";
import {readFileSync, existsSync} from "node:fs";

if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
// Behind an outbound proxy (CI sandboxes), let the browser reach the CDNs and Supabase through it
const proxy = process.env.HTTPS_PROXY ? {server: process.env.HTTPS_PROXY, bypass: "127.0.0.1,localhost"} : undefined;
const PORT = 4173;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 45_000,
  expect: {timeout: 10_000},
  fullyParallel: false,
  workers: 2,
  reporter: [["list"]],
  use: {baseURL: `http://127.0.0.1:${PORT}`, proxy, trace: "retain-on-failure"},
  projects: [
    {name: "desktop", use: {...devices["Desktop Chrome"], viewport: {width: 1280, height: 900}}},
    {name: "mobile-360", use: {viewport: {width: 360, height: 780}, hasTouch: true, isMobile: true}},
  ],
  webServer: {command: `node tests/serve.mjs ${PORT}`, url: `http://127.0.0.1:${PORT}/`, reuseExistingServer: true},
});
