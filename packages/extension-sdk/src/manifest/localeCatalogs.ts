import { readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { ExtensionConnectionKind } from '../contract/extensionConnections'
import {
  EXTENSION_LOCALE_FILE_MAX_BYTES,
  EXTENSION_LOCALES_DIR,
  extensionLocaleFile,
  type LocaleCatalogs,
  type LocaleStrings,
  matchLocale,
  parseMessages,
} from '../contract/extensionLocales'
import {
  COMMAND_ARGUMENT_LABEL_MAX,
  EXTENSION_SETTING_TITLE_MAX,
  type ExtensionChipContribution,
  type ExtensionManifest,
  type ExtensionPanelContribution,
} from '../contract/extensions'
import { FILE_KIND_DISPLAY_NAME_MAX } from '../contract/fileKinds'
import { isRecord } from '../contract/isRecord'
import { readConfined } from './confinedRead'
import { hasControlCharacter, MAX_DESCRIPTION, MAX_TEXT } from './manifestFields'

export interface LocaleCatalog {
  manifest: LocaleStrings
  messages: LocaleStrings
  problems: string[]
}

export type LocaleCatalogResult =
  | { ok: true; catalog: LocaleCatalog }
  | { ok: false; error: string }

const CATALOG_SECTIONS = ['manifest', 'messages']

export interface ManifestSlot {
  max: number
  text: string
}

export function manifestSlots(manifest: ExtensionManifest): Map<string, ManifestSlot> {
  const slots = new Map<string, ManifestSlot>()
  const slot = (key: string, max: number, text: string | undefined): void => {
    slots.set(key, { max, text: text ?? '' })
  }
  slot('name', MAX_TEXT, manifest.name)
  if (manifest.description) slot('description', MAX_DESCRIPTION, manifest.description)
  const c = manifest.contributes
  for (const command of c.commands) {
    slot(`commands.${command.id}.title`, MAX_TEXT, command.title)
    if (command.category) slot(`commands.${command.id}.category`, MAX_TEXT, command.category)
    if (command.argument) {
      slot(`commands.${command.id}.argument`, COMMAND_ARGUMENT_LABEL_MAX, command.argument)
    }
  }
  if (c.panel) slot('panel.title', MAX_TEXT, c.panel.title)
  for (const tab of c.panel?.toolbar?.tabs ?? []) {
    slot(`panel.toolbar.tabs.${tab.id}.title`, MAX_TEXT, tab.title)
  }
  for (const action of c.panel?.toolbar?.actions ?? []) {
    slot(`panel.toolbar.actions.${action.id}.title`, MAX_TEXT, action.title)
  }
  for (const kind of c.fileKinds ?? []) {
    slot(`fileKinds.${kind.id}.displayName`, FILE_KIND_DISPLAY_NAME_MAX, kind.displayName)
  }
  if (c.settingsPage) slot('settingsPage.title', EXTENSION_SETTING_TITLE_MAX, c.settingsPage.title)
  for (const chip of c.paneChips) slot(`paneChips.${chip.id}.title`, MAX_TEXT, chip.title)
  for (const chip of c.workspaceChips) slot(`workspaceChips.${chip.id}.title`, MAX_TEXT, chip.title)
  for (const setting of c.settings) {
    if (setting.title)
      slot(`settings.${setting.key}.title`, EXTENSION_SETTING_TITLE_MAX, setting.title)
    slot(`settings.${setting.key}.description`, MAX_DESCRIPTION, setting.description)
    for (const [value, title] of Object.entries(setting.valueTitles ?? {})) {
      slot(`settings.${setting.key}.valueTitles.${value}`, EXTENSION_SETTING_TITLE_MAX, title)
    }
  }
  for (const secret of c.secrets) {
    if (secret.title) slot(`secrets.${secret.key}.title`, EXTENSION_SETTING_TITLE_MAX, secret.title)
    slot(`secrets.${secret.key}.description`, MAX_DESCRIPTION, secret.description)
  }
  for (const kind of c.connections ?? []) {
    const base = `connections.${kind.kind}`
    slot(`${base}.title`, EXTENSION_SETTING_TITLE_MAX, kind.title)
    if (kind.description) slot(`${base}.description`, MAX_DESCRIPTION, kind.description)
    for (const entry of [
      ...kind.fields.map((f) => ({ ...f, group: 'fields' })),
      ...kind.secrets.map((f) => ({ ...f, group: 'secrets' })),
    ]) {
      slot(`${base}.${entry.group}.${entry.key}.title`, EXTENSION_SETTING_TITLE_MAX, entry.title)
      if (entry.description) {
        slot(`${base}.${entry.group}.${entry.key}.description`, MAX_DESCRIPTION, entry.description)
      }
    }
  }
  return slots
}

function localizePanel(
  panel: ExtensionPanelContribution,
  t: (key: string, fallback: string) => string,
): ExtensionPanelContribution {
  const { toolbar } = panel
  return {
    ...panel,
    title: t('panel.title', panel.title),
    ...(toolbar
      ? {
          toolbar: {
            tabs: toolbar.tabs.map((tab) => ({
              ...tab,
              title: t(`panel.toolbar.tabs.${tab.id}.title`, tab.title),
            })),
            actions: toolbar.actions.map((action) => ({
              ...action,
              title: t(`panel.toolbar.actions.${action.id}.title`, action.title),
            })),
          },
        }
      : {}),
  }
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
    const max = slots.get(key)?.max
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
      ...(c.panel ? { panel: localizePanel(c.panel, t) } : {}),
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
      ...(c.connections ? { connections: c.connections.map((kind) => localizeKind(kind, t)) } : {}),
      ...(c.fileKinds
        ? {
            fileKinds: c.fileKinds.map((kind) => ({
              ...kind,
              displayName: t(`fileKinds.${kind.id}.displayName`, kind.displayName),
            })),
          }
        : {}),
    },
  }
}

function localizeKind(
  kind: ExtensionConnectionKind,
  t: (key: string, fallback: string) => string,
): ExtensionConnectionKind {
  const base = `connections.${kind.kind}`
  const entry = <T extends { key: string; title: string; description?: string }>(
    group: string,
    item: T,
  ): T => ({
    ...item,
    title: t(`${base}.${group}.${item.key}.title`, item.title),
    ...(item.description
      ? { description: t(`${base}.${group}.${item.key}.description`, item.description) }
      : {}),
  })
  return {
    ...kind,
    title: t(`${base}.title`, kind.title),
    ...(kind.description ? { description: t(`${base}.description`, kind.description) } : {}),
    fields: kind.fields.map((f) => entry('fields', f)),
    secrets: kind.secrets.map((f) => entry('secrets', f)),
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
