import { existsSync, rmSync } from 'node:fs'
import type { RetiredScriptToken } from '../../shared/permissions/scriptTokens'
import { loadJson, saveJson } from '../platform/jsonStore'

const RETIRED_KEEP_MS = 30 * 86_400_000

export type RetiredToken = RetiredScriptToken

interface StoredRetired extends RetiredToken {
  hash: string
}

export function loadRetired(path: string, now: Date): StoredRetired[] {
  const raw = loadJson<unknown>(path, [])
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (r): r is StoredRetired =>
      typeof r?.name === 'string' &&
      typeof r.hash === 'string' &&
      typeof r.retiredAt === 'string' &&
      now.getTime() - Date.parse(r.retiredAt) < RETIRED_KEEP_MS,
  )
}

export function retireLegacyScriptTokens(
  legacyPath: string,
  retiredPath: string,
  now = new Date(),
): string[] {
  if (!existsSync(legacyPath)) return []
  const legacy = loadJson<Record<string, { name?: unknown; hash?: unknown }> | null>(
    legacyPath,
    null,
  )
  const at = now.toISOString()
  const kept = loadRetired(retiredPath, now)
  const moved = Object.values(legacy ?? {}).flatMap((t) =>
    typeof t?.name === 'string' && typeof t.hash === 'string'
      ? [{ name: t.name, hash: t.hash, retiredAt: at }]
      : [],
  )
  const fresh = moved.filter(
    (t, i) =>
      !kept.some((k) => k.hash === t.hash) && moved.findIndex((m) => m.hash === t.hash) === i,
  )
  saveJson(retiredPath, [...kept, ...fresh], { secure: true })
  rmSync(legacyPath, { force: true })
  return moved.map((t) => t.name)
}

export function retiredScriptTokens(retiredPath: string, now = new Date()): RetiredToken[] {
  return loadRetired(retiredPath, now).map(({ name, retiredAt }) => ({ name, retiredAt }))
}
