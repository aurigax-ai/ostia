import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: 'app-fails.ts',
  timeout: 30_000,
  workers: 1,
  retries: 0,
  reporter: [['json']],
})
