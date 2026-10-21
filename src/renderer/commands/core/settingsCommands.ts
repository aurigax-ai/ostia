import { PROGRAM_SETTINGS } from '@shared/permissions/programSettings'
import { registerCore } from '@/commands/coreCommand'
import { setKeybindingSetting } from '@/lib/keyboard/chords'
import { keymapSettingValue, terminalKeymapSettingValue } from '@/lib/settings/keymapSetting'
import { settingsSchemaAt } from '@/lib/settings/settingsSchema'
import { isMac } from '@/platform'
import type { SettingChange } from '@/stores/app/settingsModel'
import { getByPath } from '@/stores/app/settingsParse'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { saveSnapshotNow } from '@/stores/workspaces/persistence'

const HUMAN_ONLY_ROOTS: readonly string[] = [
  'privacy',
  'terminalKeys',
  'modifierRemap',
  'capabilities',
  'workspaceGroups',
  'agent',
  'playbooks',
]

function launchesProgram(key: string, value: unknown): string | null {
  const path = key.split('.').filter(Boolean).join('.')
  const root = path.split('.')[0]
  if (HUMAN_ONLY_ROOTS.includes(root)) return root
  const state = useSettingsStore.getState()
  for (const { group, field } of PROGRAM_SETTINGS) {
    const setting = `${group}.${field}`
    if (path === setting || path.startsWith(`${setting}.`)) return setting
    if (path !== group || typeof value !== 'object' || value === null || !(field in value)) continue
    const current = (state[group] as unknown as Record<string, unknown>)[field]
    if ((value as Record<string, unknown>)[field] !== current) return setting
  }
  return null
}

const KEYMAP_KEY = 'keymap'
const TERMINAL_KEYMAP_KEY = 'terminalKeymap'

const isKeybindingPath = (key: string): boolean =>
  key === 'keybindings' || key.startsWith('keybindings.')

function readableSettings() {
  const s = useSettingsStore.getState()
  return {
    locale: s.locale,
    appearance: s.appearance,
    behavior: s.behavior,
    terminal: s.terminal,
    panes: s.panes,
    notifications: s.notifications,
    sidebar: s.sidebar,
    workspaces: s.workspaces,
    browser: s.browser,
    editor: s.editor,
    agents: s.agents,
    workspaceGroups: s.workspaceGroups,
    keymap: s.keymap,
    terminalKeymap: s.terminalKeymap,
    keybindings: { ...s.keybindings },
    terminalKeys: { ...s.terminalKeys },
    modifierRemap: { ...s.modifierRemap },
    capabilities: s.capabilities,
    approvals: s.approvals,
    actions: s.actions,
  }
}

function settingResult(change: SettingChange): { previous: unknown; value: unknown } {
  return { previous: change.previous, value: change.value }
}

export function registerSettingsCommands(): void {
  registerCore<undefined, { saved: boolean }>({
    id: 'workspace.save',
    category: 'app',
    capabilities: ['settings-write'],
    target: 'none',
    run: () => {
      const enabled = useSettingsStore.getState().behavior.restoreWorkspace
      saveSnapshotNow()
      return { saved: enabled }
    },
  })

  registerCore<{ key?: string } | undefined, unknown>({
    id: 'settings.get',
    hidden: true,
    capabilities: ['settings-read'],
    target: 'none',
    run: (args) => {
      const state = readableSettings()
      const key = args?.key
      if (key && isKeybindingPath(key)) {
        const id = key.split('.').slice(1).join('.')
        return id ? state.keybindings[id] : state.keybindings
      }
      return key ? getByPath(state, key) : state
    },
  })

  registerCore<
    { key: string; value: unknown; dryRun?: boolean },
    { previous: unknown; value: unknown; applied: boolean }
  >({
    id: 'settings.set',
    hidden: true,
    capabilities: ['settings-write'],
    target: 'none',
    run: ({ key, value, dryRun }) => {
      const program = launchesProgram(key, value)
      if (program) throw new Error(`${program} can only be changed by you in Settings`)
      if (isKeybindingPath(key)) {
        const previous = getByPath(readableSettings(), key) ?? null
        if (!dryRun) setKeybindingSetting(key, value, isMac)
        return { previous, value, applied: !dryRun }
      }
      if (key === KEYMAP_KEY) {
        const previous = useSettingsStore.getState().keymap
        const next = keymapSettingValue(value)
        if (!dryRun) useSettingsStore.getState().setKeymap(next)
        return { previous, value: next, applied: !dryRun }
      }
      if (key === TERMINAL_KEYMAP_KEY) {
        const previous = useSettingsStore.getState().terminalKeymap
        const next = terminalKeymapSettingValue(value)
        if (!dryRun) useSettingsStore.getState().setTerminalKeymap(next)
        return { previous, value: next, applied: !dryRun }
      }
      const settings = useSettingsStore.getState()
      const change = dryRun ? settings.previewSetting(key, value) : settings.setByPath(key, value)
      return { ...settingResult(change), applied: !dryRun }
    },
  })

  registerCore<{ key: string }, { previous: unknown; value: unknown }>({
    id: 'settings.unset',
    hidden: true,
    capabilities: ['settings-write'],
    target: 'none',
    run: ({ key }) => {
      const program = launchesProgram(key, undefined)
      if (program) throw new Error(`${program} can only be changed by you in Settings`)
      if (key === KEYMAP_KEY) {
        const previous = useSettingsStore.getState().keymap
        useSettingsStore.getState().setKeymap(null)
        return { previous, value: null }
      }
      if (key === TERMINAL_KEYMAP_KEY) {
        const previous = useSettingsStore.getState().terminalKeymap
        useSettingsStore.getState().setTerminalKeymap(null)
        return { previous, value: null }
      }
      return settingResult(useSettingsStore.getState().unsetByPath(key))
    },
  })

  registerCore<{ key?: string } | undefined, unknown>({
    id: 'settings.schema',
    hidden: true,
    capabilities: ['settings-read'],
    target: 'none',
    run: (args) => settingsSchemaAt(args?.key),
  })
}
