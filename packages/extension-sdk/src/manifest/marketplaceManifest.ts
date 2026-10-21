import { lstatSync, readdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { isRecord } from '../contract/isRecord'
import { isInsideDir } from './confinedRead'
import { EXTENSION_ID_PATTERN } from './manifestFields'

export const MARKETPLACE_MANIFEST_FILE = 'ostia-marketplace.json'
export const MARKETPLACE_CODE_PATTERN = /^[a-z2-7]{26}$/
export const MARKETPLACE_MAX_EXTENSIONS = 200
export const MARKETPLACE_MAX_HISTORY = 5000
export const EXTENSION_MAX_FILES = 8000
const EXTENSION_MAX_BYTES = 50 * 1024 * 1024
export const MARKETPLACE_NAME_MAX = 80
export const MARKETPLACE_DESCRIPTION_MAX = 500

interface UnlistedEntry {
  path: string
  code: string
}

export interface RevokedVersion {
  id: string
  version: string
}

export interface MarketplaceManifest {
  name: string
  description: string
  extensions: string[]
  unlisted: UnlistedEntry[]
  history: string[]
  revoked: RevokedVersion[]
}

function isRepositoryPath(path: unknown): path is string {
  return typeof path === 'string' && !!path && !isAbsolute(path) && isInsideDir('/root', path)
}

function parseUnlisted(raw: unknown, listed: string[]): UnlistedEntry[] | string {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) return 'unlisted must be an array of { path, code } entries'
  const entries: UnlistedEntry[] = []
  for (const [i, entry] of raw.entries()) {
    const { path, code } = (entry ?? {}) as Record<string, unknown>
    if (!isRepositoryPath(path)) {
      return `unlisted[${i}].path must be a folder path inside the repository`
    }
    if (typeof code !== 'string' || !MARKETPLACE_CODE_PATTERN.test(code)) {
      return `unlisted[${i}].code must be 26 characters of a-z and 2-7`
    }
    if (listed.includes(path) || entries.some((e) => e.path === path)) {
      return `unlisted[${i}].path is listed more than once`
    }
    if (entries.some((e) => e.code === code)) {
      return `unlisted[${i}].code is used by another entry`
    }
    entries.push({ path, code })
  }
  return entries
}

function parseHistory(raw: unknown): string[] | string {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > MARKETPLACE_MAX_HISTORY) {
    return `history must be an array of at most ${MARKETPLACE_MAX_HISTORY} folder paths`
  }
  for (const [i, path] of raw.entries()) {
    if (!isRepositoryPath(path)) return `history[${i}] must be a folder path inside the repository`
  }
  return [...new Set(raw as string[])]
}

function parseRevoked(raw: unknown): RevokedVersion[] | string {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > MARKETPLACE_MAX_HISTORY) {
    return `revoked must be an array of at most ${MARKETPLACE_MAX_HISTORY} { id, version } entries`
  }
  const entries: RevokedVersion[] = []
  for (const [i, entry] of raw.entries()) {
    const { id, version } = (entry ?? {}) as Record<string, unknown>
    if (typeof id !== 'string' || !EXTENSION_ID_PATTERN.test(id)) {
      return `revoked[${i}].id must be an extension id`
    }
    if (typeof version !== 'string' || !version || version.length > 40) {
      return `revoked[${i}].version must be a version`
    }
    entries.push({ id, version })
  }
  return entries
}

export function parseMarketplaceManifest(raw: unknown): MarketplaceManifest | string {
  if (!isRecord(raw)) {
    return 'the marketplace file must be a JSON object'
  }
  const { name, description, extensions, unlisted, history, revoked } = raw
  if (typeof name !== 'string' || !name.trim() || name.length > MARKETPLACE_NAME_MAX) {
    return `name must be 1-${MARKETPLACE_NAME_MAX} characters`
  }
  if (description !== undefined && typeof description !== 'string') {
    return 'description must be a string'
  }
  if (!Array.isArray(extensions) || extensions.length > MARKETPLACE_MAX_EXTENSIONS) {
    return `extensions must be an array of at most ${MARKETPLACE_MAX_EXTENSIONS} folder paths`
  }
  for (const [i, path] of extensions.entries()) {
    if (!isRepositoryPath(path)) {
      return `extensions[${i}] must be a folder path inside the repository`
    }
  }
  const listed = [...new Set(extensions as string[])]
  const hidden = parseUnlisted(unlisted, listed)
  if (typeof hidden === 'string') return hidden
  if (listed.length + hidden.length > MARKETPLACE_MAX_EXTENSIONS) {
    return `a marketplace holds at most ${MARKETPLACE_MAX_EXTENSIONS} extensions`
  }
  const older = parseHistory(history)
  if (typeof older === 'string') return older
  const withdrawn = parseRevoked(revoked)
  if (typeof withdrawn === 'string') return withdrawn
  return {
    name: name.trim(),
    description: (description ?? '').slice(0, MARKETPLACE_DESCRIPTION_MAX),
    extensions: listed,
    unlisted: hidden,
    history: older,
    revoked: withdrawn,
  }
}

export type CopyPlan =
  | { ok: true; files: string[] }
  | { ok: false; error: 'invalid-extension' | 'too-large' }

export function planCopy(dir: string): CopyPlan {
  const files: string[] = []
  let bytes = 0
  const pending = ['']
  while (pending.length > 0) {
    const rel = pending.pop() as string
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const path = join(rel, entry.name)
      if (rel === '' && entry.name === '.git') continue
      if (entry.isDirectory()) {
        pending.push(path)
        continue
      }
      if (!entry.isFile()) return { ok: false, error: 'invalid-extension' }
      bytes += lstatSync(join(dir, path)).size
      files.push(path)
      if (files.length > EXTENSION_MAX_FILES || bytes > EXTENSION_MAX_BYTES) {
        return { ok: false, error: 'too-large' }
      }
    }
  }
  return { ok: true, files }
}
