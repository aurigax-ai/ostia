import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { PRODUCT_NAME } from '../shared/product'

export type StoreScope = 'project' | 'global'

export function storePath(name: string, scope: StoreScope, workDir?: string): string {
  if (scope === 'project') {
    const base = workDir?.trim() ? workDir : process.cwd()
    return join(base, '.pine', `${name}.json`)
  }
  return join(
    process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'),
    PRODUCT_NAME,
    `${name}.json`,
  )
}

export function loadJson<T>(path: string, fallback: T): T {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : fallback
  } catch {
    return fallback
  }
}

export function saveJson(path: string, data: unknown, opts?: { secure?: boolean }): void {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  renameSync(tmp, path)
  if (opts?.secure) {
    chmodSync(dir, 0o700)
    chmodSync(path, 0o600)
  }
}
