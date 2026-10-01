import { constants, type Stats, accessSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { OpenFileVerdict } from '../shared/openFiles'
import { loadJson, saveJson } from './jsonStore'
import { expandHome, resolveSafe } from './pathGuard'

export const OPEN_FILE_GRANTS_MAX = 200

export interface OpenFileGrantsDeps {
  roots: () => string[]
  file: string
  max?: number
}

export interface AdmitOptions {
  sandboxed: boolean
  remember: boolean
}

function storedPaths(file: string): string[] {
  const stored = loadJson<{ paths?: unknown } | null>(file, null)
  if (!Array.isArray(stored?.paths)) return []
  return stored.paths.filter((p): p is string => typeof p === 'string' && isAbsolute(p))
}

function locate(path: string): { real: string; stat: Stats } | null {
  try {
    const real = realpathSync(path)
    return { real, stat: statSync(real) }
  } catch {
    return null
  }
}

function isReadable(path: string): boolean {
  try {
    accessSync(path, constants.R_OK)
    return true
  } catch {
    return false
  }
}

export class OpenFileGrants {
  private readonly session = new Set<string>()
  private remembered: string[]

  constructor(private readonly deps: OpenFileGrantsDeps) {
    this.remembered = storedPaths(deps.file)
  }

  admit(raw: string, opts: AdmitOptions): OpenFileVerdict {
    const expanded = expandHome(raw)
    if (!isAbsolute(expanded)) return { ok: false, path: raw, error: 'not-found' }
    const roots = this.deps.roots()
    const inside = resolveSafe(expanded, roots)
    const path = inside ?? resolve(expanded)
    if (!inside && opts.sandboxed) return { ok: false, path, error: 'outside-sandbox' }
    const found = locate(path)
    if (found?.stat.isDirectory()) return { ok: false, path, error: 'directory' }
    if (inside) return { ok: true, path: inside }
    if (!found) return { ok: false, path, error: 'not-found' }
    if (!found.stat.isFile()) return { ok: false, path, error: 'not-a-file' }
    if (!isReadable(found.real)) return { ok: false, path, error: 'unreadable' }
    if (resolveSafe(found.real, roots) === null) this.grant(found.real, opts.remember)
    return { ok: true, path: found.real }
  }

  confine(path: string): string | null {
    const safe = resolveSafe(path, this.deps.roots())
    if (safe !== null) return safe
    const resolved = resolve(path)
    if (!this.session.has(resolved) && !this.remembered.includes(resolved)) return null
    const found = locate(resolved)
    return found?.real === resolved && found.stat.isFile() ? resolved : null
  }

  private grant(path: string, remember: boolean): void {
    if (!remember) {
      if (!this.remembered.includes(path)) this.session.add(path)
      return
    }
    const max = this.deps.max ?? OPEN_FILE_GRANTS_MAX
    const next = [...this.remembered.filter((p) => p !== path), path]
    for (const evicted of next.slice(0, -max)) this.session.add(evicted)
    this.remembered = next.slice(-max)
    saveJson(this.deps.file, { paths: this.remembered }, { secure: true })
  }
}
