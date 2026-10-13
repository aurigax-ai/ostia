import { execSync } from 'node:child_process'
import { resolve } from 'node:path'

export default function setup(): void {
  execSync(
    'pnpm run build:cli && pnpm run build:tsnet && pnpm run build:redaction-worker && pnpm run build:extensions && pnpm run build:sdk && pnpm run build:marketplace && pnpm run build:artifact-runtime && node scripts/build-info.mjs',
    {
      cwd: resolve(__dirname, '..'),
      stdio: 'ignore',
    },
  )
}
