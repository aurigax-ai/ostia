import { readFileSync } from 'node:fs'

export function parseNoNewPrivs(status: string): boolean {
  return /^NoNewPrivs:\s*1\s*$/m.test(status)
}

export function readNoNewPrivs(
  platform: NodeJS.Platform = process.platform,
  read: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): boolean {
  if (platform !== 'linux') return false
  try {
    return parseNoNewPrivs(read('/proc/self/status'))
  } catch {
    return false
  }
}
