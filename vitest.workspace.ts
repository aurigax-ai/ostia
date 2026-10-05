import { defineWorkspace } from 'vitest/config'

export default defineWorkspace([
  {
    extends: './vitest.config.ts',
    test: {
      name: 'node',
      environment: 'node',
      globalSetup: ['./test/buildOnce.ts'],
      setupFiles: ['./test/privateTmp.ts', './test/appEnv.ts'],
      include: [
        'src/main/**/*.test.ts',
        'src/shared/**/*.test.ts',
        'src/cli/**/*.test.ts',
        'src/extensions/**/*.test.ts',
      ],
    },
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'dom',
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./test/domEvents.ts', './test/setup.ts'],
      include: ['src/renderer/**/*.test.{ts,tsx}'],
    },
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'security',
      environment: 'node',
      include: ['test/security/**/*.test.ts'],
      passWithNoTests: true,
    },
  },
])
