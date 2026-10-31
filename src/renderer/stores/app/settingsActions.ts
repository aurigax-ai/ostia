import { parseAssistModelSettings } from '@aurigax-ai/ostia-extension-sdk/contract/assistReports'
import { AGENT_ACT_TOOLS } from '@shared/agent/agentCoreTools'
import { parseManagerSettings } from '@shared/agents/managerSettings'
import { clampZoom } from '@shared/app/zoom'
import { parseChatToolSettings } from '@shared/assist/chatTools'
import { parseGitSettings } from '@shared/boards/git'
import { parsePortsSettings } from '@shared/boards/ports'
import { parseModifierRemap } from '@shared/keyboard/modifierRemap'
import { parseRedactionSettings } from '@shared/privacy/redaction'
import { parseTelemetrySettings } from '@shared/privacy/telemetry'
import { offKinds } from '@shared/profileSync/syncKinds'
import { parsePromptSettings } from '@shared/terminal/promptSettings'
import { parseScrollbackHistory } from '@shared/terminal/scrollbackHistory'
import type { StoreApi } from 'zustand'
import { parseBrowserSettings, parseEditorSettings } from '@/lib/settings/browserEditorSettings'
import { parseFileTreeSettings } from '@/lib/settings/fileTreeSettings'
import { parseKeymapSetting, parseTerminalKeymapSetting } from '@/lib/settings/keymapSetting'
import {
  clampContrast,
  clampScrollback,
  clampScrollSpeed,
} from '@/lib/settings/terminalPaneSettings'
import { parseWindowTitle } from '@/lib/settings/windowTitle'
import { normalizeHex } from '@/lib/theme/color'
import { clampLineHeight, type SettingsState, withBaseSize } from './settingsModel'
import { parseHibernation, syncSettingsOf } from './settingsParse'
import { scheduleSave, writeSettings } from './settingsPersist'

type SetSettings = StoreApi<SettingsState>['setState']
type GetSettings = () => SettingsState

export function createAppearanceActions(
  set: SetSettings,
  get: GetSettings,
): Pick<
  SettingsState,
  | 'setLocale'
  | 'setTheme'
  | 'setFollowSystem'
  | 'setLightTheme'
  | 'setDarkTheme'
  | 'setAccent'
  | 'setZoom'
  | 'setMotion'
  | 'setSurfaceFont'
  | 'setTerminalLineHeight'
  | 'setWindowTitle'
> {
  return {
    setLocale: (locale) => {
      set({ locale })
      scheduleSave(get)
    },

    setTheme: (theme) => {
      set((s) => ({ appearance: { ...s.appearance, theme } }))
      scheduleSave(get)
    },

    setFollowSystem: (followSystem) => {
      set((s) => ({ appearance: { ...s.appearance, followSystem } }))
      scheduleSave(get)
    },

    setLightTheme: (lightTheme) => {
      set((s) => ({ appearance: { ...s.appearance, lightTheme } }))
      scheduleSave(get)
    },

    setDarkTheme: (darkTheme) => {
      set((s) => ({ appearance: { ...s.appearance, darkTheme } }))
      scheduleSave(get)
    },

    setAccent: (hex) => {
      const accent = hex.trim() === '' ? '' : normalizeHex(hex)
      if (accent === null) return false
      set((s) => ({ appearance: { ...s.appearance, accent } }))
      scheduleSave(get)
      return true
    },

    setZoom: (percent) => {
      set((s) => ({ appearance: { ...s.appearance, zoom: clampZoom(percent) } }))
      scheduleSave(get)
    },

    setMotion: (motion) => {
      set((s) => ({ appearance: { ...s.appearance, motion } }))
      scheduleSave(get)
    },

    setSurfaceFont: (surface, patch) => {
      set((s) => {
        const { baseSize, ...rest } = s.appearance[surface]
        const kept = 'size' in patch && !('baseSize' in patch) ? {} : { baseSize }
        const next = withBaseSize({ ...rest, ...kept, ...patch })
        return { appearance: { ...s.appearance, [surface]: next } }
      })
      scheduleSave(get)
    },

    setTerminalLineHeight: (lineHeight) => {
      set((s) => ({
        appearance: {
          ...s.appearance,
          terminal: { ...s.appearance.terminal, lineHeight: clampLineHeight(lineHeight) },
        },
      }))
      scheduleSave(get)
    },

    setWindowTitle: (windowTitle) => {
      set((s) => ({ appearance: { ...s.appearance, windowTitle: parseWindowTitle(windowTitle) } }))
      scheduleSave(get)
    },
  }
}

export function createTerminalActions(
  set: SetSettings,
  get: GetSettings,
): Pick<SettingsState, 'setBehavior' | 'setTerminal' | 'setPanes' | 'setNotifications'> {
  return {
    setBehavior: (patch) => {
      set((s) => ({ behavior: { ...s.behavior, ...patch } }))
      scheduleSave(get)
    },

    setTerminal: (patch) => {
      set((s) => ({
        terminal: {
          ...s.terminal,
          ...patch,
          scrollSpeed: clampScrollSpeed(patch.scrollSpeed ?? s.terminal.scrollSpeed),
          scrollbackLines: clampScrollback(patch.scrollbackLines ?? s.terminal.scrollbackLines),
          scrollbackHistory: parseScrollbackHistory(
            patch.scrollbackHistory ?? s.terminal.scrollbackHistory,
          ),
          minimumContrast: clampContrast(patch.minimumContrast ?? s.terminal.minimumContrast),
          prompt: parsePromptSettings(patch.prompt ?? s.terminal.prompt),
        },
      }))
      scheduleSave(get)
    },

    setPanes: (patch) => {
      set((s) => ({ panes: { ...s.panes, ...patch } }))
      scheduleSave(get)
    },

    setNotifications: (patch) => {
      set((s) => ({ notifications: { ...s.notifications, ...patch } }))
      scheduleSave(get)
    },
  }
}

export function createWorkspaceActions(
  set: SetSettings,
  get: GetSettings,
): Pick<
  SettingsState,
  'setFiles' | 'setGit' | 'setPorts' | 'setSidebar' | 'setWorkspaces' | 'setBrowser' | 'setEditor'
> {
  return {
    setFiles: (patch) => {
      set((s) => ({ files: parseFileTreeSettings({ ...s.files, ...patch }) }))
      scheduleSave(get)
    },

    setGit: (patch) => {
      set((s) => ({ git: parseGitSettings({ ...s.git, ...patch }) }))
      scheduleSave(get)
    },

    setPorts: (patch) => {
      set((s) => ({ ports: parsePortsSettings({ ...s.ports, ...patch }) }))
      scheduleSave(get)
    },

    setSidebar: (patch) => {
      set((s) => ({ sidebar: { ...s.sidebar, ...patch } }))
      scheduleSave(get)
    },

    setWorkspaces: (patch) => {
      set((s) => ({ workspaces: { ...s.workspaces, ...patch } }))
      scheduleSave(get)
    },

    setBrowser: (patch) => {
      set((s) => ({ browser: parseBrowserSettings({ ...s.browser, ...patch }) }))
      scheduleSave(get)
    },

    setEditor: (patch) => {
      set((s) => ({ editor: parseEditorSettings({ ...s.editor, ...patch }) }))
      scheduleSave(get)
    },
  }
}

export function createKeyboardActions(
  set: SetSettings,
  get: GetSettings,
): Pick<
  SettingsState,
  | 'setKeymap'
  | 'setTerminalKeymap'
  | 'setKeybinding'
  | 'resetKeybinding'
  | 'setKeybindings'
  | 'setTerminalKey'
  | 'resetTerminalKey'
  | 'setTerminalKeys'
  | 'setModifierRemap'
> {
  return {
    setKeymap: (ref) => {
      set({ keymap: parseKeymapSetting(ref) })
      scheduleSave(get)
    },

    setTerminalKeymap: (id) => {
      set({ terminalKeymap: parseTerminalKeymapSetting(id) })
      scheduleSave(get)
    },

    setKeybinding: (id, chord) => {
      set((s) => ({ keybindings: { ...s.keybindings, [id]: chord } }))
      scheduleSave(get)
    },

    resetKeybinding: (id) => {
      set((s) => {
        const { [id]: _removed, ...rest } = s.keybindings
        return { keybindings: rest }
      })
      scheduleSave(get)
    },

    setKeybindings: (keybindings) => {
      set({ keybindings })
      scheduleSave(get)
    },

    setTerminalKey: (keys, send) => {
      set((s) => ({ terminalKeys: { ...s.terminalKeys, [keys]: send } }))
      scheduleSave(get)
    },

    resetTerminalKey: (keys) => {
      set((s) => {
        const { [keys]: _removed, ...rest } = s.terminalKeys
        return { terminalKeys: rest }
      })
      scheduleSave(get)
    },

    setTerminalKeys: (terminalKeys) => {
      set({ terminalKeys })
      scheduleSave(get)
    },

    setModifierRemap: (table) => {
      set({ modifierRemap: parseModifierRemap(table) })
      scheduleSave(get)
    },
  }
}

export function createTrustActions(
  set: SetSettings,
  get: GetSettings,
): Pick<
  SettingsState,
  | 'setSandbox'
  | 'setManager'
  | 'setRedaction'
  | 'setTelemetry'
  | 'setExtensionSettings'
  | 'setChatHistory'
  | 'setChatTools'
  | 'setAssistModels'
  | 'setAutoResume'
  | 'setTrustWorkspaceFolders'
  | 'setAgentHooks'
  | 'setAgentAlwaysAsk'
  | 'setHibernation'
  | 'trustAction'
  | 'removeAction'
  | 'setApprovalMode'
  | 'setSyncDir'
  | 'setSyncMethod'
  | 'setSyncKinds'
> {
  return {
    setSandbox: async (next) => {
      set({ sandbox: next })
      await writeSettings(get())
      await window.ostia.sandbox.globalsChanged()
    },

    setManager: (patch) => {
      set((s) => ({ manager: parseManagerSettings({ ...s.manager, ...patch }) }))
      scheduleSave(get)
    },

    setRedaction: async (patch) => {
      set((s) => ({
        privacy: {
          ...s.privacy,
          redaction: parseRedactionSettings({ ...s.privacy.redaction, ...patch }),
        },
      }))
      scheduleSave.cancel()
      await writeSettings(get())
    },

    setTelemetry: async (patch) => {
      set((s) => ({
        privacy: {
          ...s.privacy,
          telemetry: parseTelemetrySettings({ ...s.privacy.telemetry, ...patch }),
        },
      }))
      scheduleSave.cancel()
      await writeSettings(get())
    },

    setExtensionSettings: (extId, values) => {
      set((s) => ({ extensionSettings: { ...s.extensionSettings, [extId]: values } }))
      scheduleSave(get)
    },

    setChatHistory: (chatHistory) => {
      set((s) => ({ assistant: { ...s.assistant, chatHistory } }))
      scheduleSave(get)
    },

    setChatTools: async (patch) => {
      set((s) => ({
        assistant: { ...s.assistant, ...parseChatToolSettings({ ...s.assistant, ...patch }) },
      }))
      scheduleSave.cancel()
      await writeSettings(get())
    },

    setAssistModels: async (patch) => {
      set((s) => ({
        assistant: { ...s.assistant, ...parseAssistModelSettings({ ...s.assistant, ...patch }) },
      }))
      scheduleSave.cancel()
      await writeSettings(get())
    },

    setAutoResume: (autoResume) => {
      set((s) => ({ agents: { ...s.agents, autoResume } }))
      scheduleSave(get)
    },

    setTrustWorkspaceFolders: (trustWorkspaceFolders) => {
      set((s) => ({ agents: { ...s.agents, trustWorkspaceFolders } }))
      scheduleSave(get)
    },

    setAgentHooks: (patch) => {
      set((s) => ({ agents: { ...s.agents, hooks: { ...s.agents.hooks, ...patch } } }))
      scheduleSave(get)
    },

    setAgentAlwaysAsk: (tool, ask) => {
      set((s) => ({
        agent: {
          ...s.agent,
          alwaysAsk: AGENT_ACT_TOOLS.filter((name) =>
            name === tool ? ask : s.agent.alwaysAsk.includes(name),
          ),
        },
      }))
      scheduleSave(get)
    },

    setHibernation: (patch) => {
      set((s) => ({
        agents: {
          ...s.agents,
          hibernation: parseHibernation({ ...s.agents.hibernation, ...patch }),
        },
      }))
      scheduleSave(get)
    },

    trustAction: (fingerprint) => {
      set((s) =>
        s.trustedActions.includes(fingerprint)
          ? s
          : { trustedActions: [...s.trustedActions, fingerprint] },
      )
      scheduleSave(get)
    },

    removeAction: (id) => {
      set((s) => ({ actions: s.actions.filter((a) => a.id !== id) }))
      scheduleSave(get)
    },

    setApprovalMode: (mode) => {
      set({ approvals: { mode } })
      scheduleSave(get)
    },

    setSyncDir: async (dir) => {
      scheduleSave.cancel()
      const { method, kinds } = get().sync ?? {}
      set({ sync: syncSettingsOf(dir, method, kinds) })
      await writeSettings(get())
    },

    setSyncMethod: async (method) => {
      scheduleSave.cancel()
      const { dir = '', kinds } = get().sync ?? {}
      set({ sync: syncSettingsOf(dir, method === 'server' ? 'server' : undefined, kinds) })
      await writeSettings(get())
    },

    setSyncKinds: async (kinds) => {
      scheduleSave.cancel()
      const { dir = '', method } = get().sync ?? {}
      set({ sync: syncSettingsOf(dir, method, offKinds(kinds)) })
      await writeSettings(get())
    },
  }
}
