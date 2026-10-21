import {
  AGENT_SKILL_ENTRY,
  AGENT_SKILL_FILE_PATTERN,
  AGENT_SKILL_NAME_PATTERN,
  type AgentHookContribution,
  type AgentSkillContribution,
  isAgentHookEvent,
  MAX_AGENT_HOOKS,
  MAX_AGENT_SKILL_FILES,
  MAX_AGENT_SKILLS,
} from '../contract/agentPlugins'
import { type AssistPoint, isAssistPoint } from '../contract/assist'
import type { Capability } from '../contract/capabilities'
import { EXTENSION_LOCALES_MAX } from '../contract/extensionLocales'
import {
  COMMAND_ARGUMENT_LABEL_MAX,
  type ExtensionChipContribution,
  type ExtensionCommandContribution,
  type ExtensionPanelContribution,
  PANEL_TAB_SURFACES,
  PANEL_TOOLBAR_MAX_ACTIONS,
  PANEL_TOOLBAR_MAX_TABS,
  type PanelTabSurface,
  type PanelToolbarContribution,
} from '../contract/extensions'
import { ICON_THEME_ID_PATTERN, type IconThemeContribution } from '../contract/iconTheme'
import { isRecord } from '../contract/isRecord'
import {
  isKeymapPlatform,
  KEYMAP_LABEL_MAX,
  KEYMAP_PLATFORMS,
  type KeymapContribution,
} from '../contract/keymap'
import { LANGUAGE_ID_PATTERN, type LanguageContribution } from '../contract/languagePack'
import { parseSnippet, type Snippet } from '../contract/snippets'
import { isInsideDir } from './confinedRead'
import { COMMAND_ID_PATTERN, capabilities, parseIcon, text } from './manifestFields'

export const KEYMAP_ID_PATTERN = new RegExp(COMMAND_ID_PATTERN)
export const MAX_COMMANDS = 64
export const MAX_SNIPPETS = 64
export const MAX_CHIPS = 8
export const MAX_ICON_THEMES = 16
export const MAX_LANGUAGES = 8
export const MAX_KEYMAPS = 8

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

export function parseCommands(raw: unknown): ExtensionCommandContribution[] | string {
  const rawCommands = raw ?? []
  if (!Array.isArray(rawCommands) || rawCommands.length > MAX_COMMANDS) {
    return `contributes.commands must be an array of at most ${MAX_COMMANDS}`
  }
  const commands: ExtensionCommandContribution[] = []
  for (const [i, c] of rawCommands.entries()) {
    const parsed = parseCommand(c, i)
    if (typeof parsed === 'string') return parsed
    if (commands.some((x) => x.id === parsed.id)) return `duplicate command '${parsed.id}'`
    commands.push(parsed)
  }
  return commands
}

function parsePanelToolbar(raw: unknown): PanelToolbarContribution | string {
  if (!isRecord(raw)) return 'contributes.panel.toolbar: must be an object'
  const tabs = parseToolbarItems(raw.tabs, 'tabs', PANEL_TOOLBAR_MAX_TABS)
  if (typeof tabs === 'string') return tabs
  const actions = parseToolbarItems(raw.actions, 'actions', PANEL_TOOLBAR_MAX_ACTIONS)
  if (typeof actions === 'string') return actions
  const withIcon: PanelToolbarContribution['actions'] = []
  for (const [i, action] of actions.entries()) {
    const icon = parseIcon(action.icon)
    if (!icon) return `contributes.panel.toolbar.actions[${i}]: missing or unknown icon`
    withIcon.push({ id: action.id, title: action.title, icon })
  }
  return {
    tabs: tabs.map(({ id, title, surface }) => ({
      id,
      title,
      ...(surface ? { surface } : {}),
    })),
    actions: withIcon,
  }
}

function parseToolbarItems(
  raw: unknown,
  field: 'tabs' | 'actions',
  max: number,
): { id: string; title: string; icon?: unknown; surface?: PanelTabSurface }[] | string {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > max) {
    return `contributes.panel.toolbar.${field} must be an array of at most ${max}`
  }
  const items: { id: string; title: string; icon?: unknown; surface?: PanelTabSurface }[] = []
  for (const [i, item] of raw.entries()) {
    const where = `contributes.panel.toolbar.${field}[${i}]`
    if (!isRecord(item)) return `${where}: must be an object`
    if (typeof item.id !== 'string' || !COMMAND_ID_PATTERN.test(item.id)) {
      return `${where}: invalid id`
    }
    const title = text(item.title)
    if (!title) return `${where}: missing title`
    if (items.some((x) => x.id === item.id)) return `${where}: duplicate id '${item.id}'`
    if (item.surface !== undefined) {
      if (field !== 'tabs' || !PANEL_TAB_SURFACES.includes(item.surface as PanelTabSurface)) {
        return `${where}: surface must be one of ${PANEL_TAB_SURFACES.join(', ')}`
      }
    }
    items.push({
      id: item.id,
      title,
      icon: item.icon,
      ...(item.surface ? { surface: item.surface as PanelTabSurface } : {}),
    })
  }
  return items
}

export function parsePanel(
  raw: unknown,
  dir: string,
): ExtensionPanelContribution | string | undefined {
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
  if (raw.toolbar !== undefined) {
    const toolbar = parsePanelToolbar(raw.toolbar)
    if (typeof toolbar === 'string') return toolbar
    panel.toolbar = toolbar
  }
  return panel
}

export function parseChips(
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

export function parseAssist(raw: unknown, caps: Capability[]): AssistPoint[] | string {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || !raw.every(isAssistPoint)) {
    return 'contributes.assist must be an array of input, command, completion, chat'
  }
  if (raw.length > 0 && !caps.includes('assist')) {
    return "contributes.assist needs the 'assist' capability"
  }
  return [...new Set(raw)]
}

export function parseIconThemes(raw: unknown, dir: string): IconThemeContribution[] | string {
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

export function parseLanguages(raw: unknown, dir: string): LanguageContribution[] | string {
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

export function parseKeymaps(raw: unknown, dir: string): KeymapContribution[] | string {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > MAX_KEYMAPS) {
    return `contributes.keymaps must be an array of at most ${MAX_KEYMAPS}`
  }
  const keymaps: KeymapContribution[] = []
  for (const [i, item] of raw.entries()) {
    const where = `contributes.keymaps[${i}]`
    if (!isRecord(item)) return `${where}: must be an object`
    if (typeof item.id !== 'string' || !KEYMAP_ID_PATTERN.test(item.id)) {
      return `${where}: id must be lowercase letters, digits and dashes`
    }
    const label = text(item.label, KEYMAP_LABEL_MAX)
    if (!label) return `${where}: label must be 1-${KEYMAP_LABEL_MAX} characters`
    const path = item.path
    if (typeof path !== 'string' || !path.endsWith('.json') || !isInsideDir(dir, path)) {
      return `${where}: path must be a .json file inside the extension`
    }
    const platform = item.platform
    if (platform !== undefined && !isKeymapPlatform(platform)) {
      return `${where}: platform must be one of ${KEYMAP_PLATFORMS.join(', ')}`
    }
    if (keymaps.some((k) => k.id === item.id)) return `${where}: duplicate id '${item.id}'`
    keymaps.push({ id: item.id, label, path, ...(isKeymapPlatform(platform) ? { platform } : {}) })
  }
  return keymaps
}

export function parseLocales(raw: unknown): string[] | string {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > EXTENSION_LOCALES_MAX) {
    return `locales must be an array of at most ${EXTENSION_LOCALES_MAX} language tags`
  }
  const locales: string[] = []
  for (const tag of raw) {
    if (typeof tag !== 'string' || !LANGUAGE_ID_PATTERN.test(tag)) {
      return 'locales: each entry must be a language tag such as fr or zh-Hant'
    }
    if (locales.some((l) => l.toLowerCase() === tag.toLowerCase())) {
      return `locales: duplicate '${tag}'`
    }
    locales.push(tag)
  }
  return locales
}

export function parseSnippets(raw: unknown): Snippet[] | string | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw) || raw.length > MAX_SNIPPETS) {
    return `contributes.snippets must be an array of at most ${MAX_SNIPPETS}`
  }
  const snippets: Snippet[] = []
  for (const [i, item] of raw.entries()) {
    const snippet = parseSnippet(item)
    if (snippet instanceof Error) return `contributes.snippets[${i}]: ${snippet.message}`
    snippets.push(snippet)
  }
  return snippets
}

export function parseAgentSkills(raw: unknown, dir: string): AgentSkillContribution[] | string {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > MAX_AGENT_SKILLS) {
    return `contributes.agentSkills must be an array of at most ${MAX_AGENT_SKILLS}`
  }
  const skills: AgentSkillContribution[] = []
  for (const [i, item] of raw.entries()) {
    const where = `contributes.agentSkills[${i}]`
    if (!isRecord(item)) return `${where}: must be an object`
    if (typeof item.name !== 'string' || !AGENT_SKILL_NAME_PATTERN.test(item.name)) {
      return `${where}: name must be lowercase letters, digits and dashes`
    }
    if (skills.some((s) => s.name === item.name)) return `${where}: duplicate name '${item.name}'`
    if (typeof item.path !== 'string' || !isInsideDir(dir, item.path)) {
      return `${where}: path must be a folder inside the extension`
    }
    const files = item.files === undefined ? [] : item.files
    if (!Array.isArray(files) || files.length > MAX_AGENT_SKILL_FILES) {
      return `${where}: files must be an array of at most ${MAX_AGENT_SKILL_FILES} file names`
    }
    for (const file of files) {
      if (
        typeof file !== 'string' ||
        !AGENT_SKILL_FILE_PATTERN.test(file) ||
        file === AGENT_SKILL_ENTRY
      ) {
        return `${where}: files lists names of .md or .txt files in the skill folder, other than ${AGENT_SKILL_ENTRY}`
      }
    }
    if (new Set(files).size !== files.length) return `${where}: duplicate file`
    if (item.bare !== undefined && typeof item.bare !== 'boolean') {
      return `${where}: bare must be true or false`
    }
    skills.push({
      name: item.name,
      path: item.path,
      files: files as string[],
      ...(item.bare === true ? { bare: true } : {}),
    })
  }
  return skills
}

export function parseAgentHooks(
  raw: unknown,
  commands: readonly ExtensionCommandContribution[],
): AgentHookContribution[] | string {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > MAX_AGENT_HOOKS) {
    return `contributes.agentHooks must be an array of at most ${MAX_AGENT_HOOKS}`
  }
  const hooks: AgentHookContribution[] = []
  for (const [i, item] of raw.entries()) {
    const where = `contributes.agentHooks[${i}]`
    if (!isRecord(item)) return `${where}: must be an object`
    if (!isAgentHookEvent(item.event)) return `${where}: unknown event '${String(item.event)}'`
    const command = commands.find((c) => c.id === item.command)
    if (!command) return `${where}: command must be one of this extension's commands`
    if (!command.stdin || command.interactive || command.capabilities.length > 0) {
      return `${where}: command '${command.id}' must read stdin, not be interactive and need no capabilities`
    }
    if (hooks.some((h) => h.event === item.event && h.command === command.id)) {
      return `${where}: duplicate hook`
    }
    hooks.push({ event: item.event, command: command.id })
  }
  return hooks
}
