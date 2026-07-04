import { defineConfig } from '@playwright/test'

/**
 * Playwright config for Electron E2E. Tests launch the BUILT app (out/main/index.js via the
 * package `main` field) with `_electron.launch`, so run `pnpm build` + `pnpm rebuild` first.
 * Serial (workers: 1) — the app owns singleton OS resources (pty, control socket).
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
})
