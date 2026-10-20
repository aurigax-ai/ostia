import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import picomatch from 'picomatch'

export function sourceFiles(dir: string, pattern: string): string[] {
  const root = resolve(dir)
  const matches = picomatch(pattern, { dot: true, ignore: ['**/*.test.{ts,tsx}'] })
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((file) => matches(file))
    .map((file) => join(root, file))
}
