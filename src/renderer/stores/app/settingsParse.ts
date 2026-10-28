import { parseAssistModelSettings } from '@aurigax-ai/ostia-extension-sdk/contract/assistReports'
import type { ExtensionSettingValues } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { isDangerousSegment } from '@aurigax-ai/ostia-extension-sdk/contract/protoGuard'
import { parseAgentSettings } from '@shared/agent/agentSettings'
import { parseAgentHooks } from '@shared/agents/agentHooks'
import { parseManagerSettings } from '@shared/agents/managerSettings'
import { parsePlaybooks } from '@shared/agents/playbooks'
import { parseNotificationSettings } from '@shared/app/notificationSettings'
import { parseUpdateChannel } from '@shared/app/releases'
import { clampZoom } from '@shared/app/zoom'
import { parseChatToolSettings } from '@shared/assist/chatTools'
import { parseGitSettings } from '@shared/boards/git'
import { parsePortsSettings } from '@shared/boards/ports'
import { parseGlobalHotkey } from '@shared/keyboard/globalHotkey'
import { parseModifierRemap } from '@shared/keyboard/modifierRemap'
import { parseApprovalSettings } from '@shared/permissions/approvals'
import { parsePrivacySettings } from '@shared/privacy/redaction'
import { offKinds, type SyncKinds } from '@shared/profileSync/syncKinds'
import { parseSandboxGlobals } from '@shared/sandbox/sandboxParse'
import { normalizeGroupName } from '@shared/workspaces/workspaceGroups'
import { parseActions } from '@/lib/settings/actions'
import { parseBrowserSettings, parseEditorSettings } from '@/lib/settings/browserEditorSettings'
import { parseFileTreeSettings } from '@/lib/settings/fileTreeSettings'
import { type KeyboardField, readKeyboard } from '@/lib/settings/keyboardSettings'
import { parsePaneSettings, parseTerminalSettings } from '@/lib/settings/terminalPaneSettings'
import { parseWindowTitle } from '@/lib/settings/windowTitle'
import type { GroupRule } from '@/lib/sidebar/workspaceGroups'
import { normalizeHex } from '@/lib/theme/color'
import {
  type Behavior,
  CURSOR_STYLES,
  type CursorStyle,
  clampIdleSeconds,
  clampLineHeight,
  clampMaxLive,
  DEFAULT_HIBERNATION,
  DEFAULT_WORKSPACE_SETTINGS,
  DEFAULTS,
  HERE,
  type HibernationSettings,
  inputEscape,
  inputMode,
  isPlainObject,
  kindOf,
  mergeFont,
  motionMode,
  NEW_WORKSPACE_PLACEMENTS,
  type NewWorkspacePlacement,
  type Persisted,
  pickBooleans,
  type SettingChange,
  type SettingsState,
  type SyncSettings,
  type WorkspaceGroupSettings,
  type WorkspaceSettings,
} from './settingsModel'

export function parseHibernation(raw: unknown): HibernationSettings {
  if (!isPlainObject(raw)) return DEFAULT_HIBERNATION
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_HIBERNATION.enabled,
    idleSeconds: clampIdleSeconds(raw.idleSeconds ?? DEFAULT_HIBERNATION.idleSeconds),
    maxLiveTerminals: clampMaxLive(raw.maxLiveTerminals ?? DEFAULT_HIBERNATION.maxLiveTerminals),
  }
}

const MAX_GROUP_RULES = 50

function parseWorkspaceGroupSettings(raw: unknown): WorkspaceGroupSettings {
  const list = isPlainObject(raw) && Array.isArray(raw.byCwd) ? raw.byCwd : []
  const byCwd: GroupRule[] = []
  for (const entry of list) {
    if (byCwd.length >= MAX_GROUP_RULES) break
    if (!isPlainObject(entry) || typeof entry.pattern !== 'string') continue
    const pattern = entry.pattern.trim()
    const group = normalizeGroupName(entry.group)
    if (pattern && group) byCwd.push({ pattern, group })
  }
  return { byCwd }
}

function parseWorkspaceSettings(raw: unknown): WorkspaceSettings {
  const base = DEFAULT_WORKSPACE_SETTINGS
  if (!isPlainObject(raw)) return base
  const folder = typeof raw.defaultFolder === 'string' ? raw.defaultFolder.trim() : ''
  return {
    ...pickBooleans(base, raw),
    placement: NEW_WORKSPACE_PLACEMENTS.includes(raw.placement as NewWorkspacePlacement)
      ? (raw.placement as NewWorkspacePlacement)
      : base.placement,
    defaultFolder: folder || base.defaultFolder,
    globalHotkey: parseGlobalHotkey(raw.globalHotkey),
  }
}

const DATA_KEYS: readonly string[] = [
  'locale',
  'appearance',
  'behavior',
  'files',
  'terminal',
  'panes',
  'notifications',
  'sidebar',
  'workspaces',
  'browser',
  'editor',
  'agents',
  'workspaceGroups',
  'actions',
]

function parseBehavior(raw: unknown): Behavior {
  const src = isPlainObject(raw) ? raw : {}
  const base = pickBooleans(DEFAULTS.behavior, src)
  return {
    ...base,
    cursorStyle: CURSOR_STYLES.includes(src.cursorStyle as CursorStyle)
      ? (src.cursorStyle as CursorStyle)
      : DEFAULTS.behavior.cursorStyle,
    externalEditor:
      typeof src.externalEditor === 'string'
        ? src.externalEditor
        : DEFAULTS.behavior.externalEditor,
    inputEscape: inputEscape(src.inputEscape),
    inputMode: inputMode(src.inputMode),
    updateChannel: parseUpdateChannel(src.updateChannel),
  }
}

function keyboardFrom(p: Partial<Persisted>): Pick<Persisted, KeyboardField | 'keyboardElsewhere'> {
  const { current, elsewhere } = readKeyboard(p, HERE)
  return { ...current, keyboardElsewhere: elsewhere }
}

export function parsePersisted(p: Partial<Persisted>): Persisted {
  return {
    locale: p.locale ?? DEFAULTS.locale,
    appearance: {
      theme: p.appearance?.theme ?? DEFAULTS.appearance.theme,
      followSystem:
        typeof p.appearance?.followSystem === 'boolean'
          ? p.appearance.followSystem
          : DEFAULTS.appearance.followSystem,
      lightTheme: p.appearance?.lightTheme ?? DEFAULTS.appearance.lightTheme,
      darkTheme: p.appearance?.darkTheme ?? DEFAULTS.appearance.darkTheme,
      accent: normalizeHex(p.appearance?.accent) ?? '',
      zoom: clampZoom(p.appearance?.zoom),
      motion: motionMode(p.appearance?.motion),
      ui: mergeFont(DEFAULTS.appearance.ui, p.appearance?.ui),
      terminal: {
        ...mergeFont(DEFAULTS.appearance.terminal, p.appearance?.terminal),
        lineHeight: clampLineHeight(
          Number(p.appearance?.terminal?.lineHeight ?? DEFAULTS.appearance.terminal.lineHeight),
        ),
      },
      editor: mergeFont(DEFAULTS.appearance.editor, p.appearance?.editor),
      windowTitle: parseWindowTitle(p.appearance?.windowTitle),
    },
    behavior: parseBehavior(p.behavior),
    files: parseFileTreeSettings(p.files),
    terminal: parseTerminalSettings(p.terminal),
    panes: parsePaneSettings(p.panes),
    notifications: parseNotificationSettings(p.notifications),
    sidebar: pickBooleans(DEFAULTS.sidebar, p.sidebar),
    workspaces: parseWorkspaceSettings(p.workspaces),
    browser: parseBrowserSettings(p.browser),
    editor: parseEditorSettings(p.editor),
    ...keyboardFrom(p),
    modifierRemap: parseModifierRemap(p.modifierRemap),
    agents: {
      hibernation: parseHibernation(p.agents?.hibernation),
      autoResume: p.agents?.autoResume === true,
      trustWorkspaceFolders: p.agents?.trustWorkspaceFolders === true,
      hooks: parseAgentHooks(p.agents?.hooks),
    },
    agent: parseAgentSettings(p.agent),
    assistant: {
      chatHistory: p.assistant?.chatHistory !== false,
      ...parseChatToolSettings(p.assistant),
      ...parseAssistModelSettings(p.assistant),
    },
    workspaceGroups: parseWorkspaceGroupSettings(p.workspaceGroups),
    extensionSettings: extensionSettingsOf(p.extensionSettings),
    capabilities: isPlainObject(p.capabilities) ? p.capabilities : undefined,
    manager: parseManagerSettings(p.manager),
    sync: syncOf(p.sync),
    approvals: parseApprovalSettings(p.approvals),
    actions: parseActions(p.actions),
    trustedActions: Array.isArray(p.trustedActions)
      ? p.trustedActions.filter((f): f is string => typeof f === 'string')
      : [],
    sandbox: p.sandbox === undefined ? undefined : parseSandboxGlobals(p.sandbox),
    privacy: parsePrivacySettings(p.privacy),
    git: parseGitSettings(p.git),
    ports: parsePortsSettings(p.ports),
    playbooks: parsePlaybooks(p.playbooks),
  }
}

export function getByPath(root: unknown, path: string): unknown {
  return path
    .split('.')
    .filter(Boolean)
    .reduce<unknown>((acc, key) => (isPlainObject(acc) && key in acc ? acc[key] : undefined), root)
}

function survives(wanted: unknown, parsed: unknown): boolean {
  if (Array.isArray(wanted)) {
    return (
      Array.isArray(parsed) &&
      parsed.length === wanted.length &&
      wanted.every((item, i) => survives(item, parsed[i]))
    )
  }
  if (isPlainObject(wanted)) {
    return isPlainObject(parsed) && Object.keys(wanted).every((k) => survives(wanted[k], parsed[k]))
  }
  return JSON.stringify(wanted) === JSON.stringify(parsed)
}

function dataRoot(s: Persisted): Record<string, unknown> {
  const root: Record<string, unknown> = Object.create(null)
  for (const key of DATA_KEYS) root[key] = s[key as keyof Persisted]
  return root
}

export function applySetting(s: SettingsState, path: string, value: unknown): SettingChange {
  const keys = path.split('.').filter(Boolean)
  if (keys.length === 0) throw new Error('settings path is empty')
  if (keys.some(isDangerousSegment)) throw new Error(`invalid settings path: ${path}`)
  if (!DATA_KEYS.includes(keys[0])) {
    throw new Error(`unknown settings key: ${keys[0]} (expected one of ${DATA_KEYS.join(', ')})`)
  }
  if (value === undefined) throw new Error(`cannot set ${path}: value is undefined`)
  const root = dataRoot(s)
  let cursor = root
  for (let i = 0; i < keys.length - 1; i++) {
    const existing = cursor[keys[i]]
    if (existing !== undefined && !isPlainObject(existing)) {
      const at = keys.slice(0, i + 1).join('.')
      throw new Error(`cannot set ${path}: ${at} is ${kindOf(existing)}, not an object`)
    }
    const next: Record<string, unknown> = Object.assign(Object.create(null), existing)
    cursor[keys[i]] = next
    cursor = next
  }
  const leaf = keys[keys.length - 1]
  const previous = cursor[leaf]
  if (previous === undefined) throw new Error(`unknown settings key: ${path}`)
  if (kindOf(previous) !== kindOf(value)) {
    throw new Error(`cannot set ${path}: expected ${kindOf(previous)}, got ${kindOf(value)}`)
  }
  cursor[leaf] = value
  const parsed = parsePersisted({ ...s, ...(root as Partial<Persisted>) })
  const stored = getByPath(parsed, path)
  if (!survives(value, stored)) {
    throw new Error(`invalid value for ${path}: ${JSON.stringify(value)}`)
  }
  const next = dataRoot(parsed) as Partial<SettingsState>
  return { path, previous, value: getByPath(parsed, path), next }
}

const extensionSettingsOf = (v: unknown): Record<string, ExtensionSettingValues> => {
  if (!isPlainObject(v)) return {}
  const out: Record<string, ExtensionSettingValues> = {}
  for (const [extId, values] of Object.entries(v)) {
    if (!isDangerousSegment(extId) && isPlainObject(values)) {
      out[extId] = values as ExtensionSettingValues
    }
  }
  return out
}

export const syncSettingsOf = (
  dir: string,
  method: 'server' | undefined,
  kinds: Partial<SyncKinds> | undefined,
): SyncSettings | undefined =>
  dir || method || kinds
    ? { dir, ...(method ? { method } : {}), ...(kinds ? { kinds } : {}) }
    : undefined

const syncOf = (v: unknown): SyncSettings | undefined => {
  if (!isPlainObject(v)) return undefined
  const dir = typeof v.dir === 'string' ? v.dir : ''
  const kinds = offKinds(v.kinds)
  const server = v.method === 'server'
  if (!server && !kinds && typeof v.dir !== 'string') return undefined
  return { dir, ...(server ? { method: 'server' as const } : {}), ...(kinds ? { kinds } : {}) }
}
