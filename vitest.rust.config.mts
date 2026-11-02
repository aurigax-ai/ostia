import { defineConfig } from 'vitest/config'
import base from './vitest.config.mts'

const cliTests = process.env.OSTIA_RUST_CLI === '1' ? ['src/cli/*.e2e.test.ts'] : []

export default defineConfig({
  plugins: base.plugins,
  assetsInclude: base.assetsInclude,
  resolve: base.resolve,
  server: base.server,
  test: {
    environment: 'node',
    server: base.test?.server,
    testTimeout: base.test?.testTimeout,
    maxWorkers: 2,
    globalSetup: ['./test/rust/rustCliSetup.ts'],
    setupFiles: [
      './test/hostEnv.ts',
      './test/privateTmp.ts',
      './test/runDir.ts',
      './test/appEnv.ts',
    ],
    include: ['test/rust/**/*.test.ts', ...cliTests],
  },
})
