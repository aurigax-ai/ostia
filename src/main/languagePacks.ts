import { resolve } from 'node:path'
import { ipcMain } from 'electron'
import type { LanguageCatalog, LanguageContribution, LanguagePack } from '../shared/languagePack'
import { isDangerousSegment } from '../shared/protoGuard'
import { readConfined } from './iconThemes'

export const LANGUAGE_FILE_MAX_BYTES = 1024 * 1024
export const LANGUAGE_MAX_DEPTH = 8
export const LANGUAGE_MAX_STRINGS = 20_000
export const LANGUAGE_STRING_MAX = 4000

export interface LanguageSource {
  extId: string
  dir: string
  language: LanguageContribution
}

export interface LanguagePackDeps {
  languages: () => LanguageSource[]
  onError: (extId: string, error: string) => void
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function normalizeCatalog(raw: unknown): LanguageCatalog | null {
  if (!isRecord(raw)) return null
  const budget = { left: LANGUAGE_MAX_STRINGS }
  const walk = (node: Record<string, unknown>, depth: number): LanguageCatalog => {
    const out: LanguageCatalog = Object.create(null)
    for (const [key, value] of Object.entries(node)) {
      if (budget.left <= 0) break
      if (!key || isDangerousSegment(key)) continue
      if (typeof value === 'string') {
        if (value.length > LANGUAGE_STRING_MAX) continue
        out[key] = value
        budget.left--
      } else if (isRecord(value) && depth < LANGUAGE_MAX_DEPTH) {
        out[key] = walk(value, depth + 1)
      }
    }
    return out
  }
  return walk(raw, 1)
}

export type CatalogResult = { ok: true; catalog: LanguageCatalog } | { ok: false; error: string }

export function readCatalog(dir: string, path: string): CatalogResult {
  const file = readConfined(dir, resolve(dir, path), LANGUAGE_FILE_MAX_BYTES)
  if (!file.ok) return file
  let raw: unknown
  try {
    raw = JSON.parse(file.data.toString('utf8'))
  } catch {
    return { ok: false, error: 'not valid JSON' }
  }
  const catalog = normalizeCatalog(raw)
  return catalog ? { ok: true, catalog } : { ok: false, error: 'must be a JSON object' }
}

export function loadLanguagePacks(deps: LanguagePackDeps): LanguagePack[] {
  const packs: LanguagePack[] = []
  for (const { extId, dir, language } of deps.languages()) {
    if (packs.some((p) => p.id === language.id)) {
      deps.onError(extId, `language '${language.id}' is already provided`)
      continue
    }
    const res = readCatalog(dir, language.path)
    if (!res.ok) {
      deps.onError(extId, `${language.path}: ${res.error}`)
      continue
    }
    packs.push({ extId, id: language.id, label: language.label, catalog: res.catalog })
  }
  return packs
}

export function registerLanguagePackIpc(deps: LanguagePackDeps): void {
  ipcMain.handle('languagePacks:load', () => loadLanguagePacks(deps))
}
