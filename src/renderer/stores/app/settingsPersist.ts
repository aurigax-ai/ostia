import { isIdentityRemap } from '@shared/keyboard/modifierRemap'
import { debounce } from 'es-toolkit'
import { writeKeyboard } from '@/lib/settings/keyboardSettings'
import {
  type Capabilities,
  HERE,
  type Persisted,
  type PersistedFile,
  type SettingsState,
} from './settingsModel'
import { parsePersisted } from './settingsParse'

let lastWritten: string | null = null

async function capabilitiesOnDisk(path: string): Promise<Capabilities | undefined> {
  const res = await window.ostia.fs.read(path).catch(() => null)
  const raw = res?.ok ? res.text : ''
  if (!raw) return undefined
  try {
    return parsePersisted(JSON.parse(raw) as Partial<Persisted>).capabilities
  } catch {
    return undefined
  }
}

export async function writeSettings(s: SettingsState): Promise<void> {
  const path = await window.ostia.settings.path()
  const capabilities = await capabilitiesOnDisk(path)
  const keyboard = writeKeyboard(
    {
      keymap: s.keymap,
      terminalKeymap: s.terminalKeymap,
      keybindings: s.keybindings,
      terminalKeys: s.terminalKeys,
    },
    s.keyboardElsewhere,
    HERE,
  )
  const snapshot: PersistedFile = {
    locale: s.locale,
    appearance: s.appearance,
    behavior: s.behavior,
    files: s.files,
    terminal: s.terminal,
    panes: s.panes,
    notifications: s.notifications,
    sidebar: s.sidebar,
    workspaces: s.workspaces,
    browser: s.browser,
    editor: s.editor,
    ...keyboard,
    modifierRemap: isIdentityRemap(s.modifierRemap) ? undefined : s.modifierRemap,
    agents: s.agents,
    assistant: s.assistant,
    agent: s.agent,
    workspaceGroups: s.workspaceGroups,
    extensionSettings: s.extensionSettings,
    capabilities,
    manager: s.manager,
    sync: s.sync,
    approvals: s.approvals,
    actions: s.actions,
    trustedActions: s.trustedActions,
    sandbox: s.sandbox,
    privacy: s.privacy,
    git: s.git,
    ports: s.ports,
  }
  const text = `${JSON.stringify(snapshot, null, 2)}\n`
  lastWritten = text
  await window.ostia.fs.write(path, text)
}

export const saveSettings = (s: SettingsState): Promise<void> =>
  writeSettings(s).catch((err: unknown) => console.error('[settings] save failed', err))

export const scheduleSave = debounce((get: () => SettingsState): void => {
  void saveSettings(get())
}, 300)

export function cancelSettingsSave(): void {
  scheduleSave.cancel()
}

export function isOwnWrite(raw: string): boolean {
  return raw === lastWritten
}
