import type { ExtensionSettingValues } from './extensions'
import { isRecord } from './isRecord'
import {
  EXTENSION_DIR_PLACEHOLDER,
  type JsonObject,
  type JsonValue,
  type LanguageServerContribution,
  ROOT_PLACEHOLDER,
} from './languageServers'

export function substitutePlaceholders(text: string, extensionDir: string, root: string): string {
  return text
    .replaceAll(EXTENSION_DIR_PLACEHOLDER, () => extensionDir)
    .replaceAll(ROOT_PLACEHOLDER, () => root)
}

export function substituteJson(value: JsonValue, extensionDir: string, root: string): JsonValue {
  if (typeof value === 'string') return substitutePlaceholders(value, extensionDir, root)
  if (Array.isArray(value)) return value.map((item) => substituteJson(item, extensionDir, root))
  if (value === null || typeof value !== 'object') return value
  const out: JsonObject = {}
  for (const [key, item] of Object.entries(value)) {
    out[key] = substituteJson(item, extensionDir, root)
  }
  return out
}

export function overlaySettings(
  base: JsonObject,
  paths: Record<string, string>,
  values: ExtensionSettingValues,
): JsonObject {
  const out = structuredClone(base)
  for (const [key, path] of Object.entries(paths)) {
    if (!Object.hasOwn(values, key)) continue
    const segments = path.split('.')
    let node = out
    for (const segment of segments.slice(0, -1)) {
      const next = Object.hasOwn(node, segment) ? node[segment] : undefined
      if (isRecord(next)) {
        node = next
      } else {
        const created: JsonObject = {}
        node[segment] = created
        node = created
      }
    }
    node[segments[segments.length - 1]] = values[key]
  }
  return out
}

export function configurationSection(settings: JsonObject, section: unknown): JsonValue {
  if (typeof section !== 'string' || section === '') return settings
  let node: JsonValue = settings
  for (const segment of section.split('.')) {
    if (!isRecord(node)) return null
    if (!Object.hasOwn(node, segment)) return null
    node = node[segment]
  }
  return node
}

export function documentLanguageId(
  server: Pick<LanguageServerContribution, 'documentLanguageIds'>,
  path: string,
  language: string,
): string {
  const ids = server.documentLanguageIds
  if (!ids) return language
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  let best: string | undefined
  for (const key of Object.keys(ids)) {
    if (!key.startsWith('.') || !name.endsWith(key.toLowerCase())) continue
    if (best === undefined || key.length > best.length) best = key
  }
  if (best !== undefined) return ids[best]
  return Object.hasOwn(ids, language) ? ids[language] : language
}
