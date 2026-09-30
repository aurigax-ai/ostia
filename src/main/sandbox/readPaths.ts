import { existsSync } from 'node:fs'
import { isAbsolute, join, normalize, relative, sep } from 'node:path'

export type ReadPathCheck =
  | { ok: true; path: string }
  | { ok: false; reason: 'not-absolute' | 'too-broad' | 'pine-data' | 'missing' }

export interface ReadPathEnv {
  home: string
  dataDirs: readonly string[]
}

function expand(input: string, home: string): string | null {
  if (input === '~') return home
  if (input.startsWith('~/')) return join(home, input.slice(2))
  return isAbsolute(input) ? input : null
}

function within(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.startsWith(`..${sep}`))
}

export function checkReadPath(input: string, env: ReadPathEnv): ReadPathCheck {
  const trimmed = input.trim()
  const expanded = expand(trimmed, env.home)
  if (!expanded) return { ok: false, reason: 'not-absolute' }
  const path = normalize(expanded).replace(/(.)\/+$/, '$1')
  if (path === '/' || path === normalize(env.home).replace(/\/+$/, '')) {
    return { ok: false, reason: 'too-broad' }
  }
  if (env.dataDirs.some((dir) => within(path, dir))) return { ok: false, reason: 'pine-data' }
  if (!existsSync(path)) return { ok: false, reason: 'missing' }
  return { ok: true, path: trimmed.replace(/(.)\/+$/, '$1') }
}
