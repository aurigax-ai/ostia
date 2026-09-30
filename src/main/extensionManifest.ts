import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { ALL_CAPABILITIES, type Capability } from '../shared/capabilities'
import {
  EXTENSION_ICONS,
  EXTENSION_MANIFEST_FILE,
  EXTENSION_SETTING_TYPES,
  type ExtensionCommandContribution,
  type ExtensionIcon,
  type ExtensionManifest,
  type ExtensionPaneChipContribution,
  type ExtensionPanelContribution,
  type ExtensionSettingContribution,
  type ExtensionSettingType,
  validSettingValue,
} from '../shared/extensions'
import { type Workflow, parseWorkflow } from '../shared/workflows'

export const EXTENSION_ID_PATTERN = /^[a-z][a-z0-9-]{1,39}$/
const COMMAND_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/
const MAX_COMMANDS = 64
const MAX_WORKFLOWS = 64
const MAX_TEXT = 200
const MAX_PANE_CHIPS = 8
const MAX_SETTINGS = 32
const MAX_ENUM_VALUES = 32
const SETTING_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/

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

function parsePaneChips(raw: unknown): ExtensionPaneChipContribution[] | string {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > MAX_PANE_CHIPS) {
    return `contributes.paneChips must be an array of at most ${MAX_PANE_CHIPS}`
  }
  const chips: ExtensionPaneChipContribution[] = []
  for (const [i, chip] of raw.entries()) {
    const where = `contributes.paneChips[${i}]`
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
  const setting: ExtensionSettingContribution = {
    key,
    type: raw.type as ExtensionSettingType,
    default: '',
    description,
  }
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
  }
  if (!validSettingValue(setting, raw.default)) {
    return `${where}: default does not match type ${setting.type}`
  }
  setting.default = raw.default
  return setting
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
  const description = typeof raw.description === 'string' ? raw.description.slice(0, 500) : ''
  const caps = capabilities(raw.capabilities, 'manifest')
  if (typeof caps === 'string') return { ok: false, error: caps }

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
  const sidebarItems = contributes.sidebarItems === true
  const paneChips = parsePaneChips(contributes.paneChips)
  if (typeof paneChips === 'string') return { ok: false, error: paneChips }
  const settings = parseSettings(contributes.settings)
  if (typeof settings === 'string') return { ok: false, error: settings }
  const needsMain =
    commands.length > 0 || sidebarItems || panel?.entry === 'url' || paneChips.length > 0
  if (needsMain && !main) {
    return {
      ok: false,
      error: 'commands, sidebar items, pane chips and url panels need a main process',
    }
  }

  const manifest: ExtensionManifest = {
    id,
    name,
    version,
    description,
    capabilities: caps,
    contributes: { commands, sidebarItems, paneChips, settings },
  }
  if (main) manifest.main = main
  if (panel) manifest.contributes.panel = panel
  if (workflows && workflows.length > 0) manifest.contributes.workflows = workflows
  return { ok: true, manifest }
}

function readManifest(dir: string): ManifestResult {
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
