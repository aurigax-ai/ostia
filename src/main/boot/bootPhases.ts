import { join } from 'node:path'
import { PRODUCT_DISPLAY_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/productDisplay'
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { parseScrollbackHistory } from '../../shared/terminal/scrollbackHistory'
import { startAgent } from '../agent/agentWiring'
import { registerAgentTranscriptIpc } from '../agents/agentTranscript'
import { registerAgentWiring } from '../agents/agentWiring'
import { createAccountMoves } from '../agents/claudeAccounts/accountMovesWiring'
import { registerClaudeAccountsWiring } from '../agents/claudeAccounts/claudeAccountsWiring'
import { registerFolderTrustIpc } from '../agents/folderTrustIpc'
import { currentPlaybookFiles, setPlaybookSettings } from '../agents/playbookFiles'
import { createResumeClaimer, registerResumeClaimIpc } from '../agents/resumeClaims'
import { createStartTrust } from '../agents/startTrust'
import { registerToolbeltWiring } from '../agents/toolbeltWiring'
import { registerApprovalsWiring } from '../approvals/approvalsWiring'
import { registerArtifactViewIpc, startArtifacts } from '../artifacts/artifactWiring'
import { startShares } from '../artifacts/shares/sharesWiring'
import { registerNotifyWiring } from '../attention/notifyWiring'
import { registerBrowserGuestIpc } from '../browser/browserGuestIpc'
import { registerBrowserWiring } from '../browser/browserWiring'
import { startChat } from '../chat/chatWiring'
import { startControlServer } from '../control/controlWiring'
import { setPaneIdSalt } from '../control/idRegistry'
import { loadPaneIdSalt } from '../control/paneIdSalt'
import {
  AGENT_JOURNAL_FILE_NAME,
  AGENT_JOURNAL_KEEP,
  AGENT_JOURNAL_MAX_BYTES,
  createAgentJournal,
} from '../diagnostics/agentJournal'
import { createAppLog, LOG_FILE_NAME } from '../diagnostics/appLog'
import { registerDiagnostics } from '../diagnostics/diagnostics'
import { registerGpuReport } from '../diagnostics/gpuReport'
import { registerTelemetry, TELEMETRY_FILE } from '../diagnostics/telemetry'
import { extensionHostParts, startExtensionHost } from '../extensions/extensionWiring'
import { startMarketplace } from '../extensions/marketplace/marketplaceWiring'
import { registerFsIpc } from '../files/fsIpc'
import { createScreenLinks, startGateway } from '../gateway/gatewayWiring'
import { startManager } from '../manager/managerWiring'
import { registerPaneLifecycleIpc } from '../panes/paneLifecycleIpc'
import { listPanes } from '../panes/paneList'
import { registerPaneMethodsWiring } from '../panes/paneMethodsWiring'
import { registerParkWiring } from '../park/parkWiring'
import { storePath } from '../platform/jsonStore'
import { readLocale, readSettingsFile } from '../platform/settingsFile'
import { resolveLoginPath } from '../platform/toolPath'
import { appDataDir } from '../platform/userDirs'
import { registerPrivacyIpc } from '../privacy/privacyIpc'
import { startProfileSyncWiring } from '../profileSync/profileSyncWiring'
import { registerSandboxIpcWiring, registerSandboxWiring } from '../sandbox/sandboxWiring'
import { startServer } from '../server/serverWiring'
import { registerHistoryIpc } from '../terminal/history/historyIpc'
import { appSpillWorker, HISTORY_DIR, PaneHistories } from '../terminal/history/paneHistories'
import { registerPtyIpc } from '../terminal/pty/ptyIpc'
import { registerSelectionIpc } from '../terminal/selectionReport'
import { refreshAgentPlugin, setPlaybookSource } from '../terminal/shellIntegration'
import { startFolderAccessWatch } from '../tmux/folderAccessWiring'
import { startKeptShells } from '../tmux/keptShellsWiring'
import { appVersion, runningBuild } from '../updates/appVersion'
import { startUpdates } from '../updates/updateWiring'
import { installAppMenu } from '../windows/appMenu'
import { registerWindowInputGuards, registerWindowIpc } from '../windows/windowIpc'
import { startWindows } from '../windows/windowStartup'
import { registerContentIpc } from '../workspaces/contentWiring'
import { loadRestoredScrollback, pendingRestoredScrollback } from '../workspaces/savedScrollback'
import type { QuitContext } from './quitServices'

export type Wiring = QuitContext

export function boot(wiring: Wiring): void {
  const {
    execCommand,
    finishRecovery,
    getTerminalState,
    handleQuitSignals,
    isWaking,
    mainStrings,
    openSettingsInFocusedWindow,
    ptyPid,
    reachesPane,
    redactor,
    registerWorkspaceIpc,
    reloadFocusedWindow,
    runMenuCommandInFocusedWindow,
    services,
    startRecovery,
    telemetrySessionFacts,
    windowIds,
    windows,
  } = wiring
  setPaneIdSalt(loadPaneIdSalt(storePath('pane-id-salt', 'global')))
  const appMenu = installAppMenu(process.platform, {
    productName: PRODUCT_DISPLAY_NAME,
    text: () => mainStrings().native.appMenu,
    openSettings: openSettingsInFocusedWindow,
    runCommand: runMenuCommandInFocusedWindow,
    reloadWindow: reloadFocusedWindow,
  })
  ipcMain.on('app-menu:set', (e, spec: unknown) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (win && [...windows.values()].includes(win)) appMenu.setSpec(spec)
  })
  const logDir = join(app.getPath('userData'), 'logs')
  services.appLog = createAppLog(join(logDir, LOG_FILE_NAME))
  services.agentJournal = createAgentJournal(
    createAppLog(join(logDir, AGENT_JOURNAL_FILE_NAME), {
      maxBytes: AGENT_JOURNAL_MAX_BYTES,
      keep: AGENT_JOURNAL_KEEP,
    }),
  )
  void resolveLoginPath().then(({ path, ms }) =>
    services.appLog?.info('login-path', { found: path !== null, ms }),
  )
  services.telemetry = registerTelemetry({
    file: join(app.getPath('userData'), TELEMETRY_FILE),
    version: appVersion(),
    stamp: runningBuild()?.telemetry,
    readSettings: readSettingsFile,
    locale: readLocale,
    session: telemetrySessionFacts,
    log: (event, fields) => services.appLog?.info(event, fields),
  })
  services.diagnostics = registerDiagnostics({
    log: services.appLog,
    telemetry: services.telemetry,
    version: appVersion(),
    logDir,
    testHooks: process.env.NODE_ENV === 'test',
    startRecovery,
    finishRecovery,
    openPath: (path) => shell.openPath(path),
  })
  registerGpuReport(services.appLog)
  setPlaybookSettings(readSettingsFile().playbooks)
  setPlaybookSource(currentPlaybookFiles)
  ipcMain.on('settings:playbooks', (_e, playbooks: unknown) => {
    setPlaybookSettings(playbooks)
    refreshAgentPlugin()
  })
  handleQuitSignals()
  services.histories = new PaneHistories({
    root: join(appDataDir(), HISTORY_DIR),
    setting: () => parseScrollbackHistory(readSettingsFile().terminal?.scrollbackHistory),
    startSpill: appSpillWorker(app.getAppPath()),
    onFailed: (paneId, reason) => services.appLog?.info('history-off', { pane: paneId, reason }),
  })
  services.restoreOutcome = loadRestoredScrollback()
  services.appLog?.info('scrollback-load', {
    outcome: services.restoreOutcome,
    panes: Object.keys(pendingRestoredScrollback()).length,
  })
  startKeptShells({ ...wiring })
  startArtifacts({ ...wiring })
  registerWindowInputGuards({ ...wiring })
  registerWindowIpc({ ...wiring })
  registerPaneLifecycleIpc({ ...wiring })
  registerBrowserGuestIpc({ ...wiring })
  registerWorkspaceIpc()
  registerSandboxIpcWiring({ ...wiring })
  const accountMoves = createAccountMoves({ ...wiring })
  registerPtyIpc({
    ...wiring,
    hibernateHeld: (paneId, writes) => accountMoves.holds(paneId, writes),
  })
  registerHistoryIpc({ ...wiring })
  registerFsIpc({ ...wiring })
  registerSelectionIpc(reachesPane, redactor.text, () => services.files?.viewers ?? null)
  registerArtifactViewIpc({ ...wiring })
  registerPrivacyIpc(redactor)
  registerApprovalsWiring({ ...wiring })
  startUpdates({ ...wiring })
  registerAgentTranscriptIpc()
  registerResumeClaimIpc(
    createResumeClaimer(() =>
      listPanes({ execCommand, getTerminalState, ptyPid, windowIds, waking: isWaking }),
    ),
  )
  registerFolderTrustIpc({ ...wiring, readSettingsFile })
  registerClaudeAccountsWiring({
    ...wiring,
    accountMoves,
    trustForStart: createStartTrust({ ...wiring, readSettingsFile }),
  })
  const { notifyDeps } = registerNotifyWiring({ ...wiring })
  registerSandboxWiring({ ...wiring, notifyDeps })
  startFolderAccessWatch({ ...wiring, notifyDeps })
  const { registry, startAgentForPhone } = registerAgentWiring({ ...wiring })
  registerParkWiring({ ...wiring })
  const { paneReachDeps, turnConfirms } = registerPaneMethodsWiring({ ...wiring, registry })
  registerToolbeltWiring({ ...wiring, paneReachDeps })
  const { extensionRemoteFolders, extensionExec, resumeOfPane } = extensionHostParts({ ...wiring })
  const screenLinks = createScreenLinks({ ...wiring })
  const { extensionStore, extensionHost } = startExtensionHost({
    ...wiring,
    screenLinks,
    extensionRemoteFolders,
    notifyDeps,
    extensionExec,
    resumeOfPane,
  })
  const { marketplace } = startMarketplace({ ...wiring, extensionStore })
  const server = startServer({ ...wiring })
  startShares({ ...wiring, server })
  startProfileSyncWiring({ ...wiring, marketplace, server })
  startChat({ ...wiring })
  startAgent({ ...wiring })
  const { viewHost, ownSnippets } = registerContentIpc({ ...wiring })
  startGateway({ ...wiring, turnConfirms, startAgentForPhone, ownSnippets, server })
  registerBrowserWiring({ ...wiring })
  startControlServer({ ...wiring })
  startManager({ ...wiring })
  startWindows({
    ...wiring,
    extensionHost,
    viewHost,
  })
}
