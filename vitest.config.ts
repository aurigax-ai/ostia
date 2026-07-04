import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * Base Vitest config — shared by every project in `vitest.workspace.ts`.
 * Holds the path aliases (mirrors tsconfig `@`/`@shared`) and the global coverage
 * settings. The per-environment `include`/`environment`/`setupFiles` live in the
 * workspace file; each project `extends` this base so aliases + coverage apply.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer'),
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html', 'lcov'],
      all: true,
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/renderer/components/ui/**', // generated shadcn/Base-UI — not hand-tested
        'src/renderer/main.tsx', // app bootstrap
        'src/renderer/vite-env.d.ts',
        'src/**/*.d.ts',
        '**/*.test.{ts,tsx}',
        'test/**',
      ],
    },
  },
})
