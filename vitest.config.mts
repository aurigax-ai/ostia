import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { dataUrl } from './scripts/dataUrl.mjs'
import { activeEntries, announce } from './test/quarantine.mjs'

announce(activeEntries(), 'vitest')

export default defineConfig({
  plugins: [dataUrl()],
  assetsInclude: ['**/*.md', '**/*.txt'],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer'),
      '@shared': resolve(__dirname, 'src/shared'),
      'vscode-jsonrpc/browser': resolve(
        __dirname,
        'node_modules/vscode-jsonrpc/lib/browser/main.js',
      ),
    },
  },
  test: {
    maxWorkers: 8,
    testTimeout: process.platform === 'darwin' ? 60_000 : 15_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html', 'lcov'],
      include: ['src/**/*.{ts,tsx}', 'packages/*/src/**/*.ts'],
      exclude: [
        'src/renderer/components/ui/**',
        'src/renderer/main.tsx',
        'src/renderer/vite-env.d.ts',
        'src/**/*.d.ts',
        '**/*.test.{ts,tsx}',
        'test/**',
      ],
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          globalSetup: ['./test/buildOnce.ts'],
          setupFiles: [
            './test/hostEnv.ts',
            './test/privateTmp.ts',
            './test/appEnv.ts',
            './test/quarantineSetup.ts',
          ],
          include: [
            'src/main/**/*.test.ts',
            'src/shared/**/*.test.ts',
            'src/cli/**/*.test.ts',
            'src/extensions/**/*.test.ts',
            'packages/*/src/**/*.test.ts',
            'test/quarantine.test.ts',
            'test/e2eImports.test.ts',
            'test/affectedTests.test.ts',
            'test/e2eAreas.test.ts',
            'test/ciMergeQueue.test.ts',
            'test/mergeQueueVerified.test.ts',
            'test/mainBuild.test.ts',
            'test/retry.test.ts',
            'test/installScript.test.ts',
            'test/electronHeaders.test.ts',
            'test/releaseNotes.test.ts',
            'test/coverageReport.test.ts',
            'test/heldPort.test.ts',
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'dom',
          environment: 'jsdom',
          globals: true,
          setupFiles: [
            './test/hostEnv.ts',
            './test/domEvents.ts',
            './test/setup.ts',
            './test/quarantineSetup.ts',
          ],
          include: ['src/renderer/**/*.test.{ts,tsx}'],
          server: { deps: { inline: ['@aurigax-ai/ghostty-web'] } },
          deps: {
            optimizer: {
              client: {
                enabled: true,
                include: ['@phosphor-icons/react'],
              },
            },
          },
        },
      },
    ],
  },
})
