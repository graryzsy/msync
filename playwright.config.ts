import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', workers: 1, timeout: 60_000, expect: { timeout: 10_000 }, reporter: 'list', outputDir: 'artifacts/ui',
  use: { baseURL: 'http://127.0.0.1:19429', viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure',
    launchOptions: { ...(process.env.MSYNC_CHROMIUM_EXECUTABLE ? { executablePath: process.env.MSYNC_CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'] } },
  webServer: { command: 'node e2e/start-server.mjs', url: 'http://127.0.0.1:19429/health', timeout: 30_000, reuseExistingServer: false }
});
