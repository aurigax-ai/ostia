/**
 * Typed JSON persistence for the agent-toolbelt features (notify/process/vault/wiki/kanban/
 * bus, ...), scoped either to the current project (`<workDir>/.pine/<name>.json`) or globally
 * to the machine (`~/.local/share/pine/<name>.json`, honoring `XDG_DATA_HOME`). Callers own
 * the shape `T`; this module only handles path resolution and durable read/write.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type StoreScope = 'project' | 'global'

/** project = <workDir>/.pine/<name>.json ; global = ~/.local/share/pine/<name>.json */
export function storePath(name: string, scope: StoreScope, workDir?: string): string {
  if (scope === 'project') {
    const base = workDir?.trim() ? workDir : process.cwd()
    return join(base, '.pine', `${name}.json`)
  }
  return join(
    process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'),
    'pine',
    `${name}.json`,
  )
}

/** Load JSON from `path`, tolerating a missing file or corrupt contents by returning `fallback`. */
export function loadJson<T>(path: string, fallback: T): T {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : fallback
  } catch {
    return fallback
  }
}

/**
 * Atomic write: mkdir -p, write temp, rename. `opts.secure` locks the file down to owner-only
 * (`0600`) and its containing directory to owner-only (`0700`) after the write — for stores
 * holding secrets (e.g. `gateway/devices.ts`'s paired-device bearer tokens) so another local
 * user on the machine can't read them. Omitted by every other caller (no behavior change).
 * Re-asserted on every save (not just first-create) in case the file/dir predates this option.
 */
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
