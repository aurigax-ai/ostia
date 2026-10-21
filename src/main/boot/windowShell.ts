import {
  normalizeRemoteCwd,
  type RemoteCwd,
} from '@aurigax-ai/ostia-extension-sdk/contract/remoteFolders'
import { BrowserWindow } from 'electron'
import { refreshCapabilitySettings } from '../approvals/capabilityStore'
import { readSettingsFile } from '../platform/settingsFile'
import { appConfigDir } from '../platform/userDirs'
import { createAppWindows } from '../windows/appWindows'
import { createWindowWiring } from '../windows/windowWiring'
import type { PaneContext } from './paneServices'

export function createWindowShell(ctx: PaneContext) {
  const {
    allowHumanPopups,
    attachBrowserMenu,
    browserAgentsOf,
    browserPanes,
    browserProfiles,
    commandsByWindow,
    consoleBuffers,
    errorBuffers,
    execCommand,
    extensionOfPartition,
    fenceBrowserGuest,
    hardenExtensionGuest,
    hidePtyFlow,
    instrumentBrowserGuest,
    mainStrings,
    mainWindow,
    openExternalSafe,
    openWaits,
    previews,
    ptys,
    quit,
    releaseWindowPtys,
    services,
    settingsChanged,
    terminalState,
    windows,
  } = ctx

  const { wireWindow } = createWindowWiring({
    contextMenuText: () => mainStrings().native.contextMenu,
    services,
    quit,
    readSettingsFile,
    requestQuit: () => services.requestQuit?.(),
    openExternalSafe,
    previews,
    extensionOfPartition,
    browserProfiles,
    hardenExtensionGuest,
    browserAgentsOf,
    instrumentBrowserGuest,
    fenceBrowserGuest,
    allowHumanPopups,
    attachBrowserMenu,
    consoleBuffers,
    errorBuffers,
    windows,
    hidePtyFlow,
    releaseWindowPtys,
    openWaits,
    commandsByWindow,
    browserPanes,
    ptys,
  })

  const {
    createWindow,
    revealWindow,
    emitFocusChanged,
    toggleAllWindows,
    applyGlobalHotkey,
    revealApp,
  } = createAppWindows({ wireWindow, services, readSettingsFile, windows })

  function configDir(): string {
    return appConfigDir()
  }

  function remoteCwdOfPane(paneId: string): RemoteCwd | undefined {
    return normalizeRemoteCwd(terminalState.get(paneId)?.remote) ?? undefined
  }

  function onSettingsWritten(): void {
    settingsChanged()
    services.telemetry?.settingsChanged()
    refreshCapabilitySettings()
    services.extensionHost?.refreshLocale()
    services.extensionHost?.assistant.reloadAssistSettings()
    services.gitService?.settingsChanged()
    services.portsService?.settingsChanged()
    applyGlobalHotkey()
    services.releaseChecks?.settingsChanged()
  }

  function openSettingsInFocusedWindow(): void {
    const focused = BrowserWindow.getFocusedWindow()
    const entry = [...windows].find(([, win]) => win === focused)
    void execCommand({ windowId: entry?.[0], workspaceId: '', paneId: null }, 'app.openSettings')
  }

  function runMenuCommandInFocusedWindow(command: string): void {
    const focused = BrowserWindow.getFocusedWindow()
    const win = focused && [...windows.values()].includes(focused) ? focused : mainWindow()
    if (win && !win.isDestroyed()) win.webContents.send('app-menu:run', command)
  }

  function reloadFocusedWindow(): void {
    const focused = BrowserWindow.getFocusedWindow()
    const win = focused && [...windows.values()].includes(focused) ? focused : mainWindow()
    if (win && !win.isDestroyed()) services.diagnostics?.reloadWindow(win.webContents)
  }

  return {
    createWindow,
    revealWindow,
    emitFocusChanged,
    toggleAllWindows,
    applyGlobalHotkey,
    revealApp,
    configDir,
    remoteCwdOfPane,
    onSettingsWritten,
    openSettingsInFocusedWindow,
    runMenuCommandInFocusedWindow,
    reloadFocusedWindow,
  }
}

export type WindowShellContext = PaneContext & ReturnType<typeof createWindowShell>
