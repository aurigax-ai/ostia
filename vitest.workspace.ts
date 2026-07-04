import { defineWorkspace } from 'vitest/config'

/**
 * Vitest 2 multi-environment setup (the v2 spelling of what v3 calls `test.projects`).
 * Three projects so a single `vitest run` covers main-process logic (node), renderer
 * stores/components (jsdom), and the security regression suite (kept separate so the
 * default `pnpm test` — which selects `node`+`dom` — stays green while the fs tests are RED).
 *
 * Each project `extends` `vitest.config.ts` to inherit the `@`/`@shared` aliases + coverage.
 */
export default defineWorkspace([
  {
    extends: './vitest.config.ts',
    test: {
      name: 'node',
      environment: 'node',
      include: ['src/main/**/*.test.ts', 'src/shared/**/*.test.ts'],
    },
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'dom',
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./test/setup.ts'],
      include: ['src/renderer/**/*.test.{ts,tsx}'],
    },
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'security',
      environment: 'node',
      include: ['test/security/**/*.test.ts'],
      // Reserved for RED (currently-failing) regression tests. The path-traversal fix ships as a
      // GREEN module instead (src/main/pathGuard.ts + .test.ts in the node project), so this is
      // empty for now — pass cleanly rather than erroring on "no test files".
      passWithNoTests: true,
    },
  },
])
