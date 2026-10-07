import { defineConfig } from '@playwright/test'
import { activeEntries, announce, playwrightFilter } from './test/quarantine.mjs'

const benchmarks = process.env.OSTIA_E2E_BENCH === '1'
const quarantined = activeEntries().filter((entry) => entry.file.startsWith('e2e/'))
if (!process.env.TEST_WORKER_INDEX) announce(quarantined, 'playwright')

export default defineConfig({
  testDir: './e2e',
  testMatch: benchmarks ? '**/*.bench.ts' : '**/*.spec.ts',
  ...playwrightFilter(quarantined),
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
