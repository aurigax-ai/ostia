import { existsSync } from 'node:fs'
import { isAbsolute, normalize } from 'node:path'
import { SANDBOX_PATH_MAX, type SandboxEditError, type SandboxPathKind } from '../../shared/sandbox'
import { expandHome, realPath, touches, within } from './srtConfig'

export type PathCheckReason =
  | 'not-absolute'
  | 'too-long'
  | 'pattern'
  | 'too-broad'
  | 'pine-data'
  | 'protected'
  | 'missing'

export type PathCheck = { ok: true; path: string } | { ok: false; reason: PathCheckReason }

export interface SandboxPathEnv {
  home: string
  dataDirs: readonly string[]
  protectedDirs: readonly string[]
  protectedFiles: readonly string[]
}

const OPENING_KINDS: readonly SandboxPathKind[] = ['allowRead', 'allowWrite', 'allowSockets']
const PATTERN_CHARS = /[*?[\]{}]/

function trimSlashes(path: string): string {
  return path.replace(/(.)\/+$/, '$1')
}

export function checkSandboxPath(
  kind: SandboxPathKind,
  input: string,
  env: SandboxPathEnv,
): PathCheck {
  const trimmed = input.trim()
  if (trimmed.length > SANDBOX_PATH_MAX) return { ok: false, reason: 'too-long' }
  const expanded = expandHome(trimmed, env.home)
  if (!isAbsolute(expanded)) return { ok: false, reason: 'not-absolute' }
  if (PATTERN_CHARS.test(expanded)) return { ok: false, reason: 'pattern' }
  const path = trimSlashes(normalize(expanded))
  if (path === '/') return { ok: false, reason: 'too-broad' }
  const opens = OPENING_KINDS.includes(kind)
  if (opens && within(realPath(env.home), realPath(path))) return { ok: false, reason: 'too-broad' }
  if (opens && touches(path, env.dataDirs)) return { ok: false, reason: 'pine-data' }
  if (opens && touches(path, env.protectedDirs)) return { ok: false, reason: 'protected' }
  if (kind === 'allowWrite' && env.protectedFiles.some((file) => within(realPath(path), file))) {
    return { ok: false, reason: 'protected' }
  }
  if (!existsSync(path)) return { ok: false, reason: 'missing' }
  return { ok: true, path: trimSlashes(trimmed) }
}

export type PathListCheck =
  | { ok: true; paths: string[] }
  | { ok: false; errors: SandboxEditError[] }

export function checkSandboxPaths(
  kind: SandboxPathKind,
  inputs: readonly string[],
  env: SandboxPathEnv,
): PathListCheck {
  const paths: string[] = []
  const errors: SandboxEditError[] = []
  for (const value of inputs) {
    const check = checkSandboxPath(kind, value, env)
    if (check.ok) paths.push(check.path)
    else errors.push({ value, reason: check.reason })
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, paths }
}
