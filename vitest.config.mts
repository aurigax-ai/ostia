import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { pageScriptPlugin } from './scripts/pageScriptPlugin.mjs'
import { activeEntries, announce } from './test/quarantine.mjs'

announce(activeEntries(), 'vitest')

export default defineConfig({
  plugins: [pageScriptPlugin()],
  assetsInclude: ['**/*.md', '**/*.txt', '**/*.wasm'],
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
            'test/*.test.ts',
          ],
          exclude: ['**/node_modules/**', 'packages/*/src/**/*.dom.test.ts'],
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
          include: ['src/renderer/**/*.test.{ts,tsx}', 'packages/*/src/**/*.dom.test.ts'],
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
      ...(process.env.AGENT_TOKENS_OUT
        ? [
            {
              extends: true,
              test: {
                name: 'agent-tokens',
                environment: 'node',
                setupFiles: ['./test/hostEnv.ts', './test/privateTmp.ts', './test/appEnv.ts'],
                include: ['test/agentTokens.bench.ts'],
              },
            },
          ]
        : []),
    ],
  },
})
