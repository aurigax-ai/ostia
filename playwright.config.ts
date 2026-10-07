import { defineConfig } from '@playwright/test'

const benchmarks = process.env.OSTIA_E2E_BENCH === '1'

export default defineConfig({
  testDir: './e2e',
  testMatch: benchmarks ? '**/*.bench.ts' : '**/*.spec.ts',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['blob']] : [['list']],
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
})
