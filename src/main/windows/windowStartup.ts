import { PRODUCT_DISPLAY_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/productDisplay'
import { type BrowserWindow, app, globalShortcut } from 'electron'
import appIcon from '../../../resources/icon.png?asset'
import type { Dict } from '../../shared/app/dict'
import type { CommandTarget } from '../../shared/types'
import type { WindowBounds } from '../../shared/types'
import type { CommandResult } from '../../shared/types'
import type { AgentRunningPanes } from '../agents/agentRunning'
import type { ExtensionHost } from '../extensions/extensionHost'
import type { WorkspaceSandboxes } from '../sandbox/workspaceSandboxes'
import type { ScratchFolders } from '../workspaces/scratchFolders'
import type { ViewHost } from '../workspaces/viewHost'
import { GlobalHotkey } from './globalHotkey'
import { AppTray, unreadWorkspaces } from './tray'
import { WindowBroker } from './windowBroker'

interface WindowStartupDeps {
  extensionHost: ExtensionHost
  viewHost: ViewHost
  services: {
    appTray: AppTray | null
    broker: WindowBroker | null
    globalHotkey: GlobalHotkey | null
  }
  mainStrings: () => Dict
  windows: Map<string, BrowserWindow>
  requestQuit: () => void
  startCoreBoards: () => void
  toggleAllWindows: () => void
  applyGlobalHotkey: () => void
  createWindow: (slot: string, bounds?: WindowBounds) => BrowserWindow
  holdPtys: (paneIds: readonly string[]) => void
  execCommand: (
    target: CommandTarget,
    id: string,
    args?: unknown,
    fromMain?: boolean,
  ) => Promise<CommandResult>
  agentRunning: AgentRunningPanes
  workspaceSandboxes: WorkspaceSandboxes
  scratchFolders: ScratchFolders
  showWindow: (win: BrowserWindow) => void
  emitFocusChanged: () => void
  autosaveScrollback: () => void
  SCROLLBACK_AUTOSAVE_MS: number
  revealApp: () => void
}

export function startWindows({
  extensionHost,
  viewHost,
  services,
  mainStrings,
  windows,
  requestQuit,
  startCoreBoards,
  toggleAllWindows,
  applyGlobalHotkey,
  createWindow,
  holdPtys,
  execCommand,
  agentRunning,
  workspaceSandboxes,
  scratchFolders,
  showWindow,
  emitFocusChanged,
  autosaveScrollback,
  SCROLLBACK_AUTOSAVE_MS,
  revealApp,
}: WindowStartupDeps) {
  services.appTray = new AppTray({
    iconPath: appIcon,
    tooltip: PRODUCT_DISPLAY_NAME,
    text: () => mainStrings().native.tray,
    windows: () => [...windows.values()],
    quit: requestQuit,
    setBadgeCount: (count) => app.setBadgeCount(count),
  })
  startCoreBoards()
  services.globalHotkey = new GlobalHotkey(globalShortcut, toggleAllWindows)
  applyGlobalHotkey()
  services.broker = new WindowBroker({
    createWindow,
    holdPtys,
    execCommand,
    agents: agentRunning,
    isSandboxed: (workspaceId) => workspaceSandboxes.isEnabled(workspaceId),
    isScratch: (workspaceId) => scratchFolders.isScratch(workspaceId),
    reveal: showWindow,
    onList: (list) => services.appTray?.setUnread(unreadWorkspaces(list)),
  })
  services.broker.register()
  services.broker.openAll()
  extensionHost.processes.startEager()
  extensionHost.processes.watchUserExtensions()
  viewHost.watch()
  app.on('browser-window-focus', emitFocusChanged)
  app.on('browser-window-blur', emitFocusChanged)
  setInterval(autosaveScrollback, SCROLLBACK_AUTOSAVE_MS).unref()

  app.on('activate', revealApp)
}
