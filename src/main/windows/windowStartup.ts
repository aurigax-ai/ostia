import { PRODUCT_DISPLAY_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/productDisplay'
import { app, type BrowserWindow, globalShortcut } from 'electron'
import appIcon from '../../../resources/icon.png?asset'
import type { Dict } from '../../shared/app/dict'
import type { AgentRunningPanes } from '../agents/agentRunning'
import type { CommandBridge } from '../control/commandBridge'
import type { ExtensionHost } from '../extensions/extensionHost'
import type { CoreBoards } from '../git/coreBoards'
import type { WorkspaceSandboxes } from '../sandbox/workspaceSandboxes'
import type { ScratchFolders } from '../workspaces/scratchFolders'
import type { ScrollbackPersistence } from '../workspaces/scrollbackPersistence'
import type { ViewHost } from '../workspaces/viewHost'
import type { AppQuit } from './appQuit'
import type { AppWindows } from './appWindows'
import { GlobalHotkey } from './globalHotkey'
import { AppTray, unreadWorkspaces } from './tray'
import { WindowBroker } from './windowBroker'
import type { WindowSend } from './windowSend'

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
  requestQuit: AppQuit['requestQuit']
  startCoreBoards: CoreBoards['startCoreBoards']
  toggleAllWindows: AppWindows['toggleAllWindows']
  applyGlobalHotkey: AppWindows['applyGlobalHotkey']
  createWindow: AppWindows['createWindow']
  holdPtys: (paneIds: readonly string[]) => void
  execCommand: CommandBridge['execCommand']
  agentRunning: AgentRunningPanes
  workspaceSandboxes: WorkspaceSandboxes
  scratchFolders: ScratchFolders
  showWindow: WindowSend['showWindow']
  emitFocusChanged: AppWindows['emitFocusChanged']
  autosaveScrollback: ScrollbackPersistence['autosaveScrollback']
  SCROLLBACK_AUTOSAVE_MS: ScrollbackPersistence['SCROLLBACK_AUTOSAVE_MS']
  revealApp: AppWindows['revealApp']
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
  app.once('browser-window-created', (_event, win) =>
    win.once('ready-to-show', () => extensionHost.processes.startEager()),
  )
  services.broker.openAll()
  extensionHost.processes.watchUserExtensions()
  viewHost.watch()
  app.on('browser-window-focus', emitFocusChanged)
  app.on('browser-window-blur', emitFocusChanged)
  setInterval(autosaveScrollback, SCROLLBACK_AUTOSAVE_MS).unref()

  app.on('activate', revealApp)
}
