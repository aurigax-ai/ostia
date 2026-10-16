import { app } from 'electron'
import { readSettingsFile } from '../platform/settingsFile'
import { createRedactor } from '../privacy/redaction'
import { createWorkerScan, redactionWorkerScript } from '../privacy/redactionScan'
import { registerAppQuit } from '../windows/appQuit'
import { createQuitTrace } from '../windows/quitPlan'
import { createQuitTeardown } from '../windows/quitTeardown'
import { createScrollbackPersistence } from '../workspaces/scrollbackPersistence'
import type { FeatureContext } from './featureServices'

export function createQuitServices(ctx: FeatureContext) {
  const {
    artifactFolders,
    artifactHistory,
    isScratchPane,
    keptHostPanes,
    keptShells,
    languageServerWatches,
    mainStrings,
    mainWindow,
    paneActivity,
    portForwarder,
    previews,
    ptys,
    quit,
    scratchFolders,
    scriptTokenUsage,
    services,
    syncKeptExposed,
    updatePolicy,
    windows,
    workspaceAgents,
    workspaceSandboxes,
  } = ctx

  const redactionScan = createWorkerScan(redactionWorkerScript(app.getAppPath()))
  const redactor = createRedactor(
    () => (readSettingsFile() as { privacy?: unknown }).privacy,
    redactionScan.scan,
  )

  const quitTrace = createQuitTrace((event, fields) => services.appLog?.info(event, fields))

  const { persistScrollback, SCROLLBACK_AUTOSAVE_MS, autosaveScrollback } =
    createScrollbackPersistence({ redactor, services, ptys, isScratchPane, quit, quitTrace })

  const { teardown } = createQuitTeardown({
    quitTrace,
    services,
    ptys,
    quit,
    keptHostPanes,
    syncKeptExposed,
    portForwarder,
    keptShells,
    languageServerWatches,
    workspaceSandboxes,
    workspaceAgents,
    scratchFolders,
    artifactFolders,
    artifactHistory,
    previews,
    updatePolicy,
  })

  const { requestQuit, handleQuitSignals } = registerAppQuit({
    teardown,
    readSettingsFile,
    services,
    quitTrace,
    quit,
    windows,
    ptys,
    mainWindow,
    scratchFolders,
    paneActivity,
    mainStrings,
    persistScrollback,
    scriptTokenUsage,
  })

  services.requestQuit = requestQuit

  return {
    redactionScan,
    redactor,
    SCROLLBACK_AUTOSAVE_MS,
    autosaveScrollback,
    requestQuit,
    handleQuitSignals,
  }
}

export type QuitContext = FeatureContext & ReturnType<typeof createQuitServices>
