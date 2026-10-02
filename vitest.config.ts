import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { fontDataUrl } from './scripts/fontDataUrl.mjs'

export default defineConfig({
  plugins: [fontDataUrl()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer'),
      '@shared': resolve(__dirname, 'src/shared'),
      'vscode-jsonrpc/browser': resolve(
        __dirname,
        'node_modules/vscode-jsonrpc/lib/browser/main.js',
      ),
      '@aurigax-ai/pine-extension-sdk/assist': resolve(__dirname, 'src/extensions/sdk/assist'),
      '@aurigax-ai/pine-extension-sdk': resolve(__dirname, 'src/extensions/sdk'),
    },
  },
  test: {
    maxWorkers: 8,
    testTimeout: process.platform === 'darwin' ? 60_000 : 15_000,
    minWorkers: 1,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html', 'lcov'],
      all: true,
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/renderer/components/ui/**',
        'src/renderer/main.tsx',
        'src/renderer/vite-env.d.ts',
        'src/**/*.d.ts',
        '**/*.test.{ts,tsx}',
        'test/**',
      ],
    },
  },
})
