import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './e2e', workers: 1, timeout: 60_000, expect: { timeout: 10_000 }, reporter: 'list', outputDir: 'artifacts/ui', use: { trace: 'retain-on-failure' } });
