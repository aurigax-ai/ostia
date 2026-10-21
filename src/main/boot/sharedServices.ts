import { OFFICIAL_MARKETPLACE } from '@aurigax-ai/ostia-extension-sdk/contract/product'
import { app, shell } from 'electron'
import { externalHref } from '../../shared/common/externalLinks'
import { createCommandBridge } from '../control/commandBridge'
import { createSessionFacts } from '../diagnostics/sessionFacts'
import {
  marketplaceId,
  normalizeMarketplaceUrl,
} from '../extensions/marketplace/marketplaceSources'
import { createMainStrings } from '../extensions/strings'
import { managerSettings, readLocale, readSettingsFile } from '../platform/settingsFile'
import { createKeptShellsWiring } from '../tmux/keptShellsWiring'
import { signaturePolicy } from '../updates/macReplace'
import { createWindowSend } from '../windows/windowSend'
import type { AppState } from './appState'

export function createSharedServices(ctx: AppState) {
  const { commandsByWindow, ptys, services, terminalState, windows } = ctx

  const {
    settingsChanged,
    windowIds,
    workspaceWindowId,
    publishRemoteFolders,
    sendToWorkspaceWindow,
    broadcast,
    publishWorkspaceChips,
    publishInbox,
    focusPaneInWindow,
    primaryWindowId,
    showWindow,
    mainWindow,
    sendToWindow,
  } = createWindowSend({ windows, services })

  const { listCommandsFor, getTerminalState, execCommand, openTerminalInWindow } =
    createCommandBridge({ commandsByWindow, terminalState, windows, mainWindow, workspaceWindowId })

  const telemetrySessionFacts = createSessionFacts({
    readSettings: readSettingsFile,
    installedExtensions: () => services.marketplaceInstallIds(),
    extensions: () => services.extensionHost?.list() ?? [],
    windows,
    workspacesOf: (win) => services.broker?.workspacesOf(win).length ?? 0,
    restoreOutcome: () => services.restoreOutcome,
  })

  const officialMarketplaceId = marketplaceId(normalizeMarketplaceUrl(OFFICIAL_MARKETPLACE) ?? '')

  function openExternalSafe(url: string): boolean {
    const href = externalHref(url, { apps: false })
    if (!href) return false
    void shell.openExternal(href)
    return true
  }

  const {
    keptShells,
    keepShellsOn,
    keptShellsProgram,
    savedPaneIds,
    withKeptProcess,
    syncKeptMeta,
    paneLauncherDir,
    keptPlumbing,
    keptPaneEnv,
  } = createKeptShellsWiring({
    ptys,
    readSettingsFile,
    processes: () => services.processes,
    appLog: () => services.appLog,
  })
  const updatePolicy = signaturePolicy(app.isPackaged, process.env)
  const UPDATE_HOST_GRANT_ID = 'core:update'

  const languagePackDeps = {
    languages: () => services.extensionHost?.contributions.languages() ?? [],
    onError: (extId: string, error: string) => console.warn(`[language pack ${extId}] ${error}`),
  }

  const mainStrings = createMainStrings({ ...languagePackDeps, locale: readLocale })

  return {
    settingsChanged,
    windowIds,
    workspaceWindowId,
    publishRemoteFolders,
    sendToWorkspaceWindow,
    broadcast,
    publishWorkspaceChips,
    publishInbox,
    focusPaneInWindow,
    primaryWindowId,
    showWindow,
    mainWindow,
    sendToWindow,
    listCommandsFor,
    getTerminalState,
    execCommand,
    openTerminalInWindow,
    telemetrySessionFacts,
    officialMarketplaceId,
    openExternalSafe,
    keptShells,
    keepShellsOn,
    keptShellsProgram,
    savedPaneIds,
    withKeptProcess,
    syncKeptMeta,
    paneLauncherDir,
    keptPlumbing,
    keptPaneEnv,
    updatePolicy,
    UPDATE_HOST_GRANT_ID,
    languagePackDeps,
    mainStrings,
    readSettingsFile,
    managerSettings,
  }
}

export type SharedContext = AppState & ReturnType<typeof createSharedServices>
