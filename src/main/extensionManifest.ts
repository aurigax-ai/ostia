import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { type AssistPoint, isAssistPoint } from '../shared/assist'
import { ALL_CAPABILITIES, type Capability } from '../shared/capabilities'
import { apiProblem } from '../shared/extensionApi'
import {
  COMMAND_ARGUMENT_LABEL_MAX,
  EXTENSION_CATEGORIES,
  EXTENSION_ICONS,
  EXTENSION_MANIFEST_FILE,
  EXTENSION_SETTING_TITLE_MAX,
  EXTENSION_SETTING_TYPES,
  EXTENSION_SETTING_UNITS,
  type ExtensionCategory,
  type ExtensionChipContribution,
  type ExtensionCommandContribution,
  type ExtensionIcon,
  type ExtensionManifest,
  type ExtensionPanelContribution,
  type ExtensionSecretContribution,
  type ExtensionSettingContribution,
  type ExtensionSettingType,
  type ExtensionSettingUnit,
  validSettingValue,
} from '../shared/extensions'
import { ICON_THEME_ID_PATTERN, type IconThemeContribution } from '../shared/iconTheme'
import { LANGUAGE_ID_PATTERN, type LanguageContribution } from '../shared/languagePack'
import { parseLanguageServers } from '../shared/languageServers'
import { type Workflow, parseWorkflow } from '../shared/workflows'

export const EXTENSION_ID_PATTERN = /^[a-z][a-z0-9-]{1,39}$/
export const COMMAND_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/
export const MAX_COMMANDS = 64
export const MAX_WORKFLOWS = 64
export const MAX_TEXT = 200
export const MAX_CHIPS = 8
export const MAX_ICON_THEMES = 16
export const MAX_LANGUAGES = 8
export const MAX_SETTINGS = 32
export const MAX_ENUM_VALUES = 32
export const MAX_SECRETS = 8
export const SETTING_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/

export type ManifestResult =
  | { ok: true; manifest: ExtensionManifest }
  | { ok: false; error: string }

export interface DiscoveredExtension {
  dir: string
  builtin: boolean
  manifest: ExtensionManifest
}

export interface ExtensionRoot {
  dir: string
  builtin: boolean
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function text(v: unknown, max = MAX_TEXT): string | null {
  return typeof v === 'string' && v.trim() && v.length <= max ? v : null
}

export function isInsideDir(dir: string, path: string): boolean {
  const rel = relative(resolve(dir), resolve(dir, path))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

function capabilities(v: unknown, where: string): Capability[] | string {
  if (v === undefined) return []
  if (!Array.isArray(v)) return `${where}: capabilities must be an array`
  for (const cap of v) {
    if (!ALL_CAPABILITIES.includes(cap as Capability))
      return `${where}: unknown capability '${cap}'`
  }
  return [...new Set(v as Capability[])]
}

export function parseCommand(raw: unknown, index: number): ExtensionCommandContribution | string {
  const where = `contributes.commands[${index}]`
  if (!isRecord(raw)) return `${where}: must be an object`
  const id = raw.id
  if (typeof id !== 'string' || !COMMAND_ID_PATTERN.test(id)) return `${where}: invalid id`
  const title = text(raw.title)
  if (!title) return `${where}: missing title`
  const caps = capabilities(raw.capabilities, where)
  if (typeof caps === 'string') return caps
  const command: ExtensionCommandContribution = {
    id,
    title,
    palette: raw.palette !== false,
    stdin: raw.stdin === true,
    capabilities: caps,
  }
  const category = text(raw.category)
  if (category) command.category = category
  const usage = text(raw.usage)
  if (usage) command.usage = usage
  const argument = text(raw.argument, COMMAND_ARGUMENT_LABEL_MAX)
  if (argument) command.argument = argument
  if (raw.interactive === true) command.interactive = true
  return command
}

function parseIcon(v: unknown): ExtensionIcon | undefined {
  return EXTENSION_ICONS.includes(v as ExtensionIcon) ? (v as ExtensionIcon) : undefined
}

function parsePanel(raw: unknown, dir: string): ExtensionPanelContribution | string | undefined {
  if (raw === undefined) return undefined
  if (!isRecord(raw)) return 'contributes.panel: must be an object'
  const title = text(raw.title)
  if (!title) return 'contributes.panel: missing title'
  const entry = raw.entry
  if (typeof entry !== 'string') return 'contributes.panel: missing entry'
  if (entry !== 'url' && (!entry.endsWith('.html') || !isInsideDir(dir, entry))) {
    return "contributes.panel: entry must be 'url' or a .html path inside the extension"
  }
  const panel: ExtensionPanelContribution = { title, entry }
  const icon = parseIcon(raw.icon)
  if (icon) panel.icon = icon
  return panel
}

function parseChips(
  raw: unknown,
  field: 'paneChips' | 'workspaceChips',
): ExtensionChipContribution[] | string {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > MAX_CHIPS) {
    return `contributes.${field} must be an array of at most ${MAX_CHIPS}`
  }
  const chips: ExtensionChipContribution[] = []
  for (const [i, chip] of raw.entries()) {
    const where = `contributes.${field}[${i}]`
    if (!isRecord(chip)) return `${where}: must be an object`
    if (typeof chip.id !== 'string' || !COMMAND_ID_PATTERN.test(chip.id)) {
      return `${where}: invalid id`
    }
    const title = text(chip.title)
    if (!title) return `${where}: missing title`
    if (chips.some((c) => c.id === chip.id)) return `${where}: duplicate id '${chip.id}'`
    chips.push({ id: chip.id, title })
  }
  return chips
}

function parseSetting(key: string, raw: unknown): ExtensionSettingContribution | string {
  const where = `contributes.settings.${key}`
  if (!SETTING_KEY_PATTERN.test(key)) return `${where}: invalid key`
  if (!isRecord(raw)) return `${where}: must be an object`
  if (!EXTENSION_SETTING_TYPES.includes(raw.type as ExtensionSettingType)) {
    return `${where}: type must be one of ${EXTENSION_SETTING_TYPES.join(', ')}`
  }
  const description = text(raw.description, 500)
  if (!description) return `${where}: missing description`
  const title = optionalTitle(raw.title)
  if (title === null) return `${where}: title must be 1-${EXTENSION_SETTING_TITLE_MAX} characters`
  const setting: ExtensionSettingContribution = {
    key,
    type: raw.type as ExtensionSettingType,
    default: '',
    ...(title ? { title } : {}),
    description,
  }
  const numeric = parseNumberBounds(raw, setting.type)
  if (typeof numeric === 'string') return `${where}: ${numeric}`
  Object.assign(setting, numeric)
  if (setting.type === 'enum') {
    const values = raw.values
    if (
      !Array.isArray(values) ||
      values.length === 0 ||
      values.length > MAX_ENUM_VALUES ||
      !values.every((v) => text(v, 100) !== null)
    ) {
      return `${where}: enum needs 1-${MAX_ENUM_VALUES} string values`
    }
    setting.values = [...new Set(values as string[])]
    const valueTitles = parseValueTitles(raw.valueTitles, setting.values)
    if (typeof valueTitles === 'string') return `${where}: ${valueTitles}`
    if (valueTitles) setting.valueTitles = valueTitles
  } else if (raw.valueTitles !== undefined) {
    return `${where}: valueTitles is for enum settings`
  }
  if (!validSettingValue(setting, raw.default)) {
    return `${where}: default does not match type ${setting.type}`
  }
  setting.default = raw.default
  return setting
}

function optionalTitle(raw: unknown): string | undefined | null {
  if (raw === undefined) return undefined
  const title = text(raw, EXTENSION_SETTING_TITLE_MAX)
  if (!title || hasControlCharacter(title)) return null
  return title
}

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

function parseValueTitles(
  raw: unknown,
  values: readonly string[],
): Record<string, string> | string | undefined {
  if (raw === undefined) return undefined
  if (!isRecord(raw)) return 'valueTitles must be an object'
  const titles: Record<string, string> = {}
  for (const [value, title] of Object.entries(raw)) {
    if (!values.includes(value)) return `valueTitles.${value} is not one of the values`
    const parsed = optionalTitle(title)
    if (!parsed) return `valueTitles.${value} must be 1-${EXTENSION_SETTING_TITLE_MAX} characters`
    titles[value] = parsed
  }
  return titles
}

type NumberBounds = Pick<ExtensionSettingContribution, 'minimum' | 'maximum' | 'unit'>

function parseNumberBounds(
  raw: Record<string, unknown>,
  type: ExtensionSettingType,
): NumberBounds | string {
  const { minimum, maximum, unit } = raw
  if (minimum === undefined && maximum === undefined && unit === undefined) return {}
  if (type !== 'number') return 'minimum, maximum and unit are for number settings'
  const bounds: NumberBounds = {}
  for (const [name, value] of [
    ['minimum', minimum],
    ['maximum', maximum],
  ] as const) {
    if (value === undefined) continue
    if (typeof value !== 'number' || !Number.isFinite(value)) return `${name} must be a number`
    bounds[name] = value
  }
  if (
    bounds.minimum !== undefined &&
    bounds.maximum !== undefined &&
    bounds.minimum > bounds.maximum
  ) {
    return 'minimum is greater than maximum'
  }
  if (unit !== undefined) {
    if (!EXTENSION_SETTING_UNITS.includes(unit as ExtensionSettingUnit)) {
      return `unit must be one of ${EXTENSION_SETTING_UNITS.join(', ')}`
    }
    bounds.unit = unit as ExtensionSettingUnit
  }
  return bounds
}

function parseSettings(raw: unknown): ExtensionSettingContribution[] | string {
  if (raw === undefined) return []
  if (!isRecord(raw)) return 'contributes.settings must be an object'
  const entries = Object.entries(raw)
  if (entries.length > MAX_SETTINGS)
    return `contributes.settings has more than ${MAX_SETTINGS} keys`
  const settings: ExtensionSettingContribution[] = []
  for (const [key, value] of entries) {
    const parsed = parseSetting(key, value)
    if (typeof parsed === 'string') return parsed
    settings.push(parsed)
  }
  return settings
}

function parseSecrets(raw: unknown): ExtensionSecretContribution[] | string {
  if (raw === undefined) return []
  if (!isRecord(raw)) return 'contributes.secrets must be an object'
  const entries = Object.entries(raw)
  if (entries.length > MAX_SECRETS) return `contributes.secrets has more than ${MAX_SECRETS} keys`
  const secrets: ExtensionSecretContribution[] = []
  for (const [key, value] of entries) {
    const where = `contributes.secrets.${key}`
    if (!SETTING_KEY_PATTERN.test(key)) return `${where}: invalid key`
    const description = isRecord(value) ? text(value.description, 500) : null
    if (!description) return `${where}: missing description`
    const title = optionalTitle((value as Record<string, unknown>).title)
    if (title === null) return `${where}: title must be 1-${EXTENSION_SETTING_TITLE_MAX} characters`
    secrets.push({ key, ...(title ? { title } : {}), description })
  }
  return secrets
}

function parseAssist(raw: unknown, caps: Capability[]): AssistPoint[] | string {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || !raw.every(isAssistPoint)) {
    return 'contributes.assist must be an array of input, command, completion, chat'
  }
  if (raw.length > 0 && !caps.includes('assist')) {
    return "contributes.assist needs the 'assist' capability"
  }
  return [...new Set(raw)]
}

function parseIconThemes(raw: unknown, dir: string): IconThemeContribution[] | string {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > MAX_ICON_THEMES) {
    return `contributes.iconThemes must be an array of at most ${MAX_ICON_THEMES}`
  }
  const themes: IconThemeContribution[] = []
  for (const [i, item] of raw.entries()) {
    const where = `contributes.iconThemes[${i}]`
    if (!isRecord(item)) return `${where}: must be an object`
    if (typeof item.id !== 'string' || !ICON_THEME_ID_PATTERN.test(item.id)) {
      return `${where}: invalid id`
    }
    const label = text(item.label)
    if (!label) return `${where}: missing label`
    const path = item.path
    if (typeof path !== 'string' || !path.endsWith('.json') || !isInsideDir(dir, path)) {
      return `${where}: path must be a .json file inside the extension`
    }
    if (themes.some((t) => t.id === item.id)) return `${where}: duplicate id '${item.id}'`
    themes.push({ id: item.id, label, path })
  }
  return themes
}

function parseLanguages(raw: unknown, dir: string): LanguageContribution[] | string {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > MAX_LANGUAGES) {
    return `contributes.languages must be an array of at most ${MAX_LANGUAGES}`
  }
  const languages: LanguageContribution[] = []
  for (const [i, item] of raw.entries()) {
    const where = `contributes.languages[${i}]`
    if (!isRecord(item)) return `${where}: must be an object`
    if (typeof item.id !== 'string' || !LANGUAGE_ID_PATTERN.test(item.id)) {
      return `${where}: id must be a language tag such as fr or zh-Hant`
    }
    const label = text(item.label)
    if (!label) return `${where}: missing label`
    const path = item.path
    if (typeof path !== 'string' || !path.endsWith('.json') || !isInsideDir(dir, path)) {
      return `${where}: path must be a .json file inside the extension`
    }
    if (languages.some((l) => l.id === item.id)) return `${where}: duplicate id '${item.id}'`
    languages.push({ id: item.id, label, path })
  }
  return languages
}

function parseWorkflows(raw: unknown): Workflow[] | string | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw) || raw.length > MAX_WORKFLOWS) {
    return `contributes.workflows must be an array of at most ${MAX_WORKFLOWS}`
  }
  const workflows: Workflow[] = []
  for (const [i, item] of raw.entries()) {
    const workflow = parseWorkflow(item)
    if (workflow instanceof Error) return `contributes.workflows[${i}]: ${workflow.message}`
    workflows.push(workflow)
  }
  return workflows
}

export function parseManifest(raw: unknown, dir: string): ManifestResult {
  if (!isRecord(raw)) return { ok: false, error: 'manifest must be a JSON object' }
  const id = raw.id
  if (typeof id !== 'string' || !EXTENSION_ID_PATTERN.test(id)) {
    return { ok: false, error: 'invalid id (lowercase letters, digits, dashes)' }
  }
  const name = text(raw.name)
  const version = text(raw.version, 40)
  if (!name) return { ok: false, error: 'missing name' }
  if (!version) return { ok: false, error: 'missing version' }
  if (raw.api === undefined) return { ok: false, error: 'missing api' }
  const incompatible = apiProblem(raw.api)
  if (incompatible) return { ok: false, error: incompatible }
  const description = typeof raw.description === 'string' ? raw.description.slice(0, 500) : ''
  const caps = capabilities(raw.capabilities, 'manifest')
  if (typeof caps === 'string') return { ok: false, error: caps }
  const category = raw.category === undefined ? 'other' : raw.category
  if (!EXTENSION_CATEGORIES.includes(category as ExtensionCategory)) {
    return { ok: false, error: `category must be one of ${EXTENSION_CATEGORIES.join(', ')}` }
  }

  let main: string | undefined
  if (raw.main !== undefined) {
    if (typeof raw.main !== 'string' || !isInsideDir(dir, raw.main)) {
      return { ok: false, error: 'main must be a path inside the extension' }
    }
    main = raw.main
  }

  const contributes = raw.contributes === undefined ? {} : raw.contributes
  if (!isRecord(contributes)) return { ok: false, error: 'contributes must be an object' }
  const rawCommands = contributes.commands ?? []
  if (!Array.isArray(rawCommands) || rawCommands.length > MAX_COMMANDS) {
    return { ok: false, error: `contributes.commands must be an array of at most ${MAX_COMMANDS}` }
  }
  const commands: ExtensionCommandContribution[] = []
  for (const [i, c] of rawCommands.entries()) {
    const parsed = parseCommand(c, i)
    if (typeof parsed === 'string') return { ok: false, error: parsed }
    if (commands.some((x) => x.id === parsed.id)) {
      return { ok: false, error: `duplicate command '${parsed.id}'` }
    }
    commands.push(parsed)
  }
  const panel = parsePanel(contributes.panel, dir)
  if (typeof panel === 'string') return { ok: false, error: panel }
  const workflows = parseWorkflows(contributes.workflows)
  if (typeof workflows === 'string') return { ok: false, error: workflows }
  const completions = contributes.completions
  if (
    completions !== undefined &&
    (typeof completions !== 'string' || !isInsideDir(dir, completions))
  ) {
    return { ok: false, error: 'contributes.completions must be a folder inside the extension' }
  }
  const sidebarItems = contributes.sidebarItems === true
  const paneChips = parseChips(contributes.paneChips, 'paneChips')
  if (typeof paneChips === 'string') return { ok: false, error: paneChips }
  const workspaceChips = parseChips(contributes.workspaceChips, 'workspaceChips')
  if (typeof workspaceChips === 'string') return { ok: false, error: workspaceChips }
  const settings = parseSettings(contributes.settings)
  if (typeof settings === 'string') return { ok: false, error: settings }
  const secrets = parseSecrets(contributes.secrets)
  if (typeof secrets === 'string') return { ok: false, error: secrets }
  const assist = parseAssist(contributes.assist, caps)
  if (typeof assist === 'string') return { ok: false, error: assist }
  const iconThemes = parseIconThemes(contributes.iconThemes, dir)
  if (typeof iconThemes === 'string') return { ok: false, error: iconThemes }
  const languages = parseLanguages(contributes.languages, dir)
  if (typeof languages === 'string') return { ok: false, error: languages }
  const languageServers = parseLanguageServers(contributes.languageServers, {
    isInside: (path) => isInsideDir(dir, path),
    capabilities: caps,
    settingKeys: settings.map((setting) => setting.key),
  })
  if (typeof languageServers === 'string') return { ok: false, error: languageServers }
  const needsMain =
    commands.length > 0 ||
    sidebarItems ||
    panel?.entry === 'url' ||
    paneChips.length > 0 ||
    workspaceChips.length > 0 ||
    assist.length > 0
  if (needsMain && !main) {
    return {
      ok: false,
      error: 'commands, sidebar items, chips, assist and url panels need a main process',
    }
  }

  const manifest: ExtensionManifest = {
    id,
    name,
    version,
    api: raw.api as string,
    description,
    category: category as ExtensionCategory,
    capabilities: caps,
    contributes: { commands, sidebarItems, paneChips, workspaceChips, settings, assist, secrets },
  }
  if (main) manifest.main = main
  if (panel) manifest.contributes.panel = panel
  if (workflows && workflows.length > 0) manifest.contributes.workflows = workflows
  if (completions !== undefined) manifest.contributes.completions = completions
  if (iconThemes.length > 0) manifest.contributes.iconThemes = iconThemes
  if (languages.length > 0) manifest.contributes.languages = languages
  if (languageServers.length > 0) manifest.contributes.languageServers = languageServers
  return { ok: true, manifest }
}

export function readManifest(dir: string): ManifestResult {
  const path = join(dir, EXTENSION_MANIFEST_FILE)
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    return { ok: false, error: `unreadable ${EXTENSION_MANIFEST_FILE}: ${(err as Error).message}` }
  }
  return parseManifest(raw, dir)
}

function subdirs(root: string): string[] {
  if (!existsSync(root)) return []
  try {
    return readdirSync(root)
      .sort()
      .map((name) => join(root, name))
      .filter((dir) => {
        try {
          return statSync(dir).isDirectory() && existsSync(join(dir, EXTENSION_MANIFEST_FILE))
        } catch {
          return false
        }
      })
  } catch {
    return []
  }
}

export function discoverExtensions(
  roots: ExtensionRoot[],
  onError: (dir: string, error: string) => void = () => {},
): DiscoveredExtension[] {
  const found = new Map<string, DiscoveredExtension>()
  const ordered = [...roots].sort((a, b) => Number(b.builtin) - Number(a.builtin))
  for (const root of ordered) {
    for (const dir of subdirs(root.dir)) {
      const res = readManifest(dir)
      if (!res.ok) {
        onError(dir, res.error)
        continue
      }
      if (found.has(res.manifest.id)) {
        onError(dir, `duplicate extension id '${res.manifest.id}'`)
        continue
      }
      found.set(res.manifest.id, { dir, builtin: root.builtin, manifest: res.manifest })
    }
  }
  return [...found.values()]
}
