import { execSync } from 'node:child_process'
import { resolve } from 'node:path'

export default function setup(): void {
  execSync('pnpm run build:cli && pnpm run build:extensions && pnpm run build:sdk', {
    cwd: resolve(__dirname, '..'),
    stdio: 'ignore',
  })
}
