import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, extname, resolve } from 'node:path'
import { ipcMain } from 'electron'
import type { IconAssociations, IconThemeContribution, LoadedIconTheme } from '../shared/iconTheme'
import { isInsideDir } from './extensionManifest'

export const ICON_THEME_MAX_BYTES = 4 * 1024 * 1024
export const ICON_FILE_MAX_BYTES = 512 * 1024
export const ICON_TOTAL_MAX_BYTES = 48 * 1024 * 1024
const MAX_DEFINITIONS = 10_000
const MAX_ASSOCIATIONS = 50_000
const MAX_KEY_LENGTH = 200

const IMAGE_TYPES: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

export type IconThemeResult = { ok: true; theme: LoadedIconTheme } | { ok: false; error: string }

type FileRead = { ok: true; data: Buffer } | { ok: false; error: string }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function readConfined(root: string, path: string, maxBytes: number): FileRead {
  if (!isInsideDir(root, path)) return { ok: false, error: 'outside the extension' }
  let st: ReturnType<typeof lstatSync>
  try {
    st = lstatSync(path)
  } catch {
    return { ok: false, error: 'missing' }
  }
  if (st.isSymbolicLink()) return { ok: false, error: 'symlink refused' }
  if (!st.isFile()) return { ok: false, error: 'not a file' }
  if (st.size > maxBytes) return { ok: false, error: `larger than ${maxBytes} bytes` }
  try {
    if (!isInsideDir(root, realpathSync(path))) return { ok: false, error: 'outside the extension' }
    return { ok: true, data: readFileSync(path) }
  } catch {
    return { ok: false, error: 'unreadable' }
  }
}

function stringMap(raw: unknown, defined: ReadonlySet<string>, budget: { left: number }) {
  const out: Record<string, string> = {}
  if (!isRecord(raw)) return out
  for (const [key, value] of Object.entries(raw)) {
    if (budget.left <= 0) break
    if (typeof value !== 'string' || !defined.has(value)) continue
    if (!key || key.length > MAX_KEY_LENGTH) continue
    out[key.toLowerCase()] = value
    budget.left--
  }
  return out
}

function associations(
  raw: unknown,
  defined: ReadonlySet<string>,
  budget: { left: number },
): IconAssociations {
  const src = isRecord(raw) ? raw : {}
  const single = (v: unknown): string | undefined =>
    typeof v === 'string' && defined.has(v) ? v : undefined
  const out: IconAssociations = {
    fileExtensions: stringMap(src.fileExtensions, defined, budget),
    fileNames: stringMap(src.fileNames, defined, budget),
    folderNames: stringMap(src.folderNames, defined, budget),
    folderNamesExpanded: stringMap(src.folderNamesExpanded, defined, budget),
    languageIds: stringMap(src.languageIds, defined, budget),
  }
  const file = single(src.file)
  const folder = single(src.folder)
  const folderExpanded = single(src.folderExpanded)
  if (file) out.file = file
  if (folder) out.folder = folder
  if (folderExpanded) out.folderExpanded = folderExpanded
  return out
}

function dataUrl(path: string, data: Buffer): string {
  return `data:${IMAGE_TYPES[extname(path).toLowerCase()]};base64,${data.toString('base64')}`
}

export function loadIconTheme(
  extDir: string,
  contribution: IconThemeContribution,
): IconThemeResult {
  let root: string
  try {
    root = realpathSync(extDir)
  } catch {
    return { ok: false, error: 'extension folder is missing' }
  }
  const themePath = resolve(root, contribution.path)
  const file = readConfined(root, themePath, ICON_THEME_MAX_BYTES)
  if (!file.ok) return { ok: false, error: `${contribution.path}: ${file.error}` }
  let raw: unknown
  try {
    raw = JSON.parse(file.data.toString('utf8'))
  } catch (err) {
    return { ok: false, error: `${contribution.path}: ${(err as Error).message}` }
  }
  if (!isRecord(raw) || !isRecord(raw.iconDefinitions)) {
    return { ok: false, error: `${contribution.path}: missing iconDefinitions` }
  }

  const icons: Record<string, string> = {}
  let total = 0
  let count = 0
  for (const [id, def] of Object.entries(raw.iconDefinitions)) {
    if (count >= MAX_DEFINITIONS) break
    if (!isRecord(def) || typeof def.iconPath !== 'string') continue
    const iconPath = resolve(dirname(themePath), def.iconPath)
    if (!IMAGE_TYPES[extname(iconPath).toLowerCase()]) continue
    const icon = readConfined(root, iconPath, ICON_FILE_MAX_BYTES)
    if (!icon.ok) continue
    total += icon.data.length
    if (total > ICON_TOTAL_MAX_BYTES) {
      return {
        ok: false,
        error: `${contribution.path}: icons exceed ${ICON_TOTAL_MAX_BYTES} bytes`,
      }
    }
    icons[id] = dataUrl(iconPath, icon.data)
    count++
  }

  const defined = new Set(Object.keys(icons))
  const budget = { left: MAX_ASSOCIATIONS }
  const theme: LoadedIconTheme = {
    id: contribution.id,
    label: contribution.label,
    icons,
    base: associations(raw, defined, budget),
  }
  if (isRecord(raw.light)) theme.light = associations(raw.light, defined, budget)
  if (isRecord(raw.highContrast)) {
    theme.highContrast = associations(raw.highContrast, defined, budget)
  }
  return { ok: true, theme }
}

export interface IconThemeSource {
  dir: string
  theme: IconThemeContribution
}

export interface IconThemeDeps {
  themes: () => IconThemeSource[]
  onError: (id: string, error: string) => void
}

interface Cached {
  key: string
  theme: LoadedIconTheme | null
}

const cache = new Map<string, Cached>()

function cacheKey(source: IconThemeSource): string {
  try {
    const st = lstatSync(resolve(source.dir, source.theme.path))
    return `${source.dir}\n${source.theme.path}\n${st.mtimeMs}\n${st.size}`
  } catch {
    return `${source.dir}\n${source.theme.path}\nmissing`
  }
}

export function iconThemeFor(id: unknown, deps: IconThemeDeps): LoadedIconTheme | null {
  if (typeof id !== 'string') return null
  const source = deps.themes().find((s) => s.theme.id === id)
  if (!source) return null
  const key = cacheKey(source)
  const hit = cache.get(id)
  if (hit && hit.key === key) return hit.theme
  const res = loadIconTheme(source.dir, source.theme)
  if (!res.ok) deps.onError(id, res.error)
  const theme = res.ok ? res.theme : null
  cache.set(id, { key, theme })
  return theme
}

export function registerIconThemeIpc(deps: IconThemeDeps): void {
  ipcMain.handle('iconThemes:load', (_e, id: unknown) => iconThemeFor(id, deps))
}
