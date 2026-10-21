import { create } from 'zustand'
import { createPlaybookActions } from './playbookActions'
import {
  createAppearanceActions,
  createKeyboardActions,
  createTerminalActions,
  createTrustActions,
  createWorkspaceActions,
} from './settingsActions'
import { DEFAULTS, type Persisted, type SettingsState } from './settingsModel'
import { applySetting, getByPath, parsePersisted } from './settingsParse'
import { isOwnWrite, saveSettings, scheduleSave } from './settingsPersist'

export function saveSettingsNow(): Promise<void> {
  scheduleSave.cancel()
  return saveSettings(useSettingsStore.getState())
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...DEFAULTS,

  init: async () => {
    const path = await window.ostia.settings.path()
    const res = await window.ostia.fs.read(path)
    const raw = res.ok ? res.text : ''
    if (!raw || isOwnWrite(raw)) return
    try {
      set(parsePersisted(JSON.parse(raw) as Partial<Persisted>))
    } catch {}
  },
  previewSetting: (path, value) => applySetting(get(), path, value),
  setByPath: (path, value) => {
    const change = applySetting(get(), path, value)
    set(change.next)
    scheduleSave(get)
    return change
  },
  unsetByPath: (path) => {
    const fallback = getByPath(DEFAULTS, path)
    if (fallback === undefined) throw new Error(`unknown settings key: ${path}`)
    return get().setByPath(path, structuredClone(fallback))
  },
  ...createAppearanceActions(set, get),
  ...createTerminalActions(set, get),
  ...createWorkspaceActions(set, get),
  ...createKeyboardActions(set, get),
  ...createTrustActions(set, get),
  ...createPlaybookActions(set, get),
}))
