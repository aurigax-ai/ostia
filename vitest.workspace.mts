import { defineWorkspace } from 'vitest/config'
import { activeEntries, announce } from './test/quarantine.mjs'

announce(activeEntries(), 'vitest')

export default defineWorkspace([
  {
    extends: './vitest.config.mts',
    test: {
      name: 'node',
      environment: 'node',
      globalSetup: ['./test/buildOnce.ts'],
      setupFiles: ['./test/privateTmp.ts', './test/appEnv.ts', './test/quarantineSetup.ts'],
      include: [
        'src/main/**/*.test.ts',
        'src/shared/**/*.test.ts',
        'src/cli/**/*.test.ts',
        'src/extensions/**/*.test.ts',
        'test/quarantine.test.ts',
        'test/e2eImports.test.ts',
        'test/affectedTests.test.ts',
        'test/mergeQueueVerified.test.ts',
      ],
    },
  },
  {
    extends: './vitest.config.mts',
    test: {
      name: 'dom',
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./test/domEvents.ts', './test/setup.ts', './test/quarantineSetup.ts'],
      include: ['src/renderer/**/*.test.{ts,tsx}'],
      deps: {
        optimizer: {
          web: {
            enabled: true,
            include: ['@phosphor-icons/react'],
          },
        },
      },
    },
  },
  {
    extends: './vitest.config.mts',
    test: {
      name: 'security',
      environment: 'node',
      include: ['test/security/**/*.test.ts'],
      passWithNoTests: true,
    },
  },
])
