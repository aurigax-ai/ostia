import { readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import {
  EXTENSION_LOCALES_DIR,
  EXTENSION_LOCALE_FILE_MAX_BYTES,
  type LocaleCatalogs,
  type LocaleStrings,
  extensionLocaleFile,
  matchLocale,
  parseMessages,
} from '../shared/extensionLocales'
import {
  COMMAND_ARGUMENT_LABEL_MAX,
  EXTENSION_SETTING_TITLE_MAX,
  type ExtensionChipContribution,
  type ExtensionManifest,
} from '../shared/extensions'
import { readConfined } from './confinedRead'
import { MAX_DESCRIPTION, MAX_TEXT, hasControlCharacter } from './extensionManifest'

export interface LocaleCatalog {
  manifest: LocaleStrings
  messages: LocaleStrings
  problems: string[]
}

export type LocaleCatalogResult =
  | { ok: true; catalog: LocaleCatalog }
  | { ok: false; error: string }

const CATALOG_SECTIONS = ['manifest', 'messages']

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function manifestSlots(manifest: ExtensionManifest): Map<string, number> {
  const slots = new Map<string, number>([['name', MAX_TEXT]])
  if (manifest.description) slots.set('description', MAX_DESCRIPTION)
  const c = manifest.contributes
  for (const command of c.commands) {
    slots.set(`commands.${command.id}.title`, MAX_TEXT)
    if (command.category) slots.set(`commands.${command.id}.category`, MAX_TEXT)
    if (command.argument) {
      slots.set(`commands.${command.id}.argument`, COMMAND_ARGUMENT_LABEL_MAX)
    }
  }
  if (c.panel) slots.set('panel.title', MAX_TEXT)
  if (c.settingsPage) slots.set('settingsPage.title', EXTENSION_SETTING_TITLE_MAX)
  for (const chip of c.paneChips) slots.set(`paneChips.${chip.id}.title`, MAX_TEXT)
  for (const chip of c.workspaceChips) slots.set(`workspaceChips.${chip.id}.title`, MAX_TEXT)
  for (const setting of c.settings) {
    if (setting.title) slots.set(`settings.${setting.key}.title`, EXTENSION_SETTING_TITLE_MAX)
    slots.set(`settings.${setting.key}.description`, MAX_DESCRIPTION)
    for (const value of Object.keys(setting.valueTitles ?? {})) {
      slots.set(`settings.${setting.key}.valueTitles.${value}`, EXTENSION_SETTING_TITLE_MAX)
    }
  }
  for (const secret of c.secrets) {
    if (secret.title) slots.set(`secrets.${secret.key}.title`, EXTENSION_SETTING_TITLE_MAX)
    slots.set(`secrets.${secret.key}.description`, MAX_DESCRIPTION)
  }
  return slots
}

function parseManifestStrings(
  raw: unknown,
  manifest: ExtensionManifest,
): { strings: LocaleStrings; problems: string[] } {
  const strings: LocaleStrings = Object.create(null)
  const problems: string[] = []
  if (raw === undefined) return { strings, problems }
  if (!isRecord(raw)) return { strings, problems: ['manifest must be an object of strings'] }
  const slots = manifestSlots(manifest)
  for (const [key, value] of Object.entries(raw)) {
    const max = slots.get(key)
    if (max === undefined) {
      problems.push(`manifest.${key}: not a string this extension's manifest declares`)
    } else if (typeof value !== 'string') {
      problems.push(`manifest.${key}: must be a string`)
    } else if (!value.trim() || value.length > max) {
      problems.push(`manifest.${key}: must be 1-${max} characters`)
    } else if (hasControlCharacter(value)) {
      problems.push(`manifest.${key}: must not contain control characters`)
    } else {
      strings[key] = value
    }
  }
  return { strings, problems }
}

export function parseLocaleCatalog(
  raw: unknown,
  manifest: ExtensionManifest,
): LocaleCatalog | null {
  if (!isRecord(raw)) return null
  const unknown = Object.keys(raw)
    .filter((section) => !CATALOG_SECTIONS.includes(section))
    .map((section) => `${section}: unknown section (a catalog holds manifest and messages)`)
  const translated = parseManifestStrings(raw.manifest, manifest)
  const messages = parseMessages(raw.messages)
  return {
    manifest: translated.strings,
    messages: messages.messages,
    problems: [...unknown, ...translated.problems, ...messages.problems],
  }
}

export function readLocaleCatalog(
  dir: string,
  tag: string,
  manifest: ExtensionManifest,
): LocaleCatalogResult {
  let root: string
  try {
    root = realpathSync(dir)
  } catch {
    return { ok: false, error: 'unreadable' }
  }
  const path = join(root, extensionLocaleFile(tag))
  const file = readConfined(root, path, EXTENSION_LOCALE_FILE_MAX_BYTES)
  if (!file.ok) return file
  let raw: unknown
  try {
    if (realpathSync(path) !== path) return { ok: false, error: 'symlink refused' }
    raw = JSON.parse(file.data.toString('utf8'))
  } catch {
    return { ok: false, error: 'not valid JSON' }
  }
  const catalog = parseLocaleCatalog(raw, manifest)
  return catalog ? { ok: true, catalog } : { ok: false, error: 'must be a JSON object' }
}

export function loadLocaleCatalogs(
  dir: string,
  manifest: ExtensionManifest,
  onProblem: (problem: string) => void = () => {},
): LocaleCatalogs {
  const catalogs: LocaleCatalogs = Object.create(null)
  for (const tag of manifest.locales ?? []) {
    const file = extensionLocaleFile(tag)
    const res = readLocaleCatalog(dir, tag, manifest)
    if (!res.ok) {
      onProblem(`${file}: ${res.error}`)
      continue
    }
    for (const problem of res.catalog.problems) onProblem(`${file}: ${problem}`)
    catalogs[tag] = res.catalog.manifest
  }
  return catalogs
}

export function localeProblems(dir: string, manifest: ExtensionManifest): string[] {
  const problems: string[] = []
  loadLocaleCatalogs(dir, manifest, (problem) => problems.push(problem))
  const declared = new Set((manifest.locales ?? []).map((tag) => `${tag}.json`))
  let files: string[] = []
  try {
    files = readdirSync(join(dir, EXTENSION_LOCALES_DIR)).filter((name) => name.endsWith('.json'))
  } catch {}
  for (const name of files.sort()) {
    if (declared.has(name)) continue
    const tag = name.slice(0, -'.json'.length)
    const file = extensionLocaleFile(tag)
    const res = readLocaleCatalog(dir, tag, manifest)
    if (!res.ok) {
      problems.push(`${file}: ${res.error}`)
      continue
    }
    problems.push(...res.catalog.problems.map((problem) => `${file}: ${problem}`))
    if (Object.keys(res.catalog.manifest).length > 0) {
      problems.push(`${file}: translates the manifest but '${tag}' is not listed in locales`)
    }
  }
  return problems
}

function localizeChips(
  chips: ExtensionChipContribution[],
  field: string,
  t: (key: string, fallback: string) => string,
): ExtensionChipContribution[] {
  return chips.map((chip) => ({ ...chip, title: t(`${field}.${chip.id}.title`, chip.title) }))
}

export function localizeManifest(
  manifest: ExtensionManifest,
  strings: LocaleStrings,
): ExtensionManifest {
  const t = (key: string, fallback: string): string =>
    Object.hasOwn(strings, key) ? strings[key] : fallback
  const c = manifest.contributes
  return {
    ...manifest,
    name: t('name', manifest.name),
    description: t('description', manifest.description),
    contributes: {
      ...c,
      commands: c.commands.map((command) => ({
        ...command,
        title: t(`commands.${command.id}.title`, command.title),
        ...(command.category
          ? { category: t(`commands.${command.id}.category`, command.category) }
          : {}),
        ...(command.argument
          ? { argument: t(`commands.${command.id}.argument`, command.argument) }
          : {}),
      })),
      ...(c.panel ? { panel: { ...c.panel, title: t('panel.title', c.panel.title) } } : {}),
      ...(c.settingsPage
        ? {
            settingsPage: {
              ...c.settingsPage,
              title: t('settingsPage.title', c.settingsPage.title),
            },
          }
        : {}),
      paneChips: localizeChips(c.paneChips, 'paneChips', t),
      workspaceChips: localizeChips(c.workspaceChips, 'workspaceChips', t),
      settings: c.settings.map((setting) => {
        const base = `settings.${setting.key}`
        return {
          ...setting,
          ...(setting.title ? { title: t(`${base}.title`, setting.title) } : {}),
          description: t(`${base}.description`, setting.description),
          ...(setting.valueTitles
            ? {
                valueTitles: Object.fromEntries(
                  Object.entries(setting.valueTitles).map(([value, title]) => [
                    value,
                    t(`${base}.valueTitles.${value}`, title),
                  ]),
                ),
              }
            : {}),
        }
      }),
      secrets: c.secrets.map((secret) => ({
        ...secret,
        ...(secret.title ? { title: t(`secrets.${secret.key}.title`, secret.title) } : {}),
        description: t(`secrets.${secret.key}.description`, secret.description),
      })),
    },
  }
}

export function manifestIn(
  manifest: ExtensionManifest,
  catalogs: LocaleCatalogs,
  locale: string | undefined,
): ExtensionManifest {
  const tag = matchLocale(locale, Object.keys(catalogs))
  return tag ? localizeManifest(manifest, catalogs[tag]) : manifest
}
