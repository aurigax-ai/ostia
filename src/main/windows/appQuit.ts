import { BrowserWindow, app } from 'electron'
import type { Dict } from '../../shared/app/dict'
import type { QuitAnswer } from '../../shared/types'
import type { PaneActivity } from '../../shared/types'
import type { ScriptTokenUsageLog } from '../approvals/scriptTokenUsage'
import type { AppLog } from '../diagnostics/appLog'
import type { Telemetry } from '../diagnostics/telemetry'
import type { SettingsFile } from '../platform/settingsFile'
import type { PtyEntry } from '../terminal/pty/ptyRegistry'
import type { ScratchFolders } from '../workspaces/scratchFolders'
import { confirmQuit, freezeAll } from './closeGuard'
import { QUIT_SIGNALS, exitAfterDeadline, keptOnQuit, planQuit, summarizeKinds } from './quitPlan'
import type { QuitTrace } from './quitPlan'
import { nativeQuitConfirm } from './quitPrompt'
import type { createQuitTeardown } from './quitTeardown'
import type { WindowBroker } from './windowBroker'

interface AppQuitDeps {
  teardown: ReturnType<typeof createQuitTeardown>['teardown']
  readSettingsFile: () => SettingsFile
  services: {
    appLog: AppLog | null
    broker: WindowBroker | null
    telemetry: Telemetry | null
  }
  quitTrace: QuitTrace
  quit: {
    quitApproved: boolean
    restartRequested: boolean
    savingScrollbackForQuit: boolean
    scrollbackSavedForQuit: boolean
  }
  windows: Map<string, BrowserWindow>
  ptys: Map<string, PtyEntry>
  mainWindow: () => BrowserWindow | undefined
  scratchFolders: ScratchFolders
  paneActivity: (entry: PtyEntry) => PaneActivity
  mainStrings: () => Dict
  persistScrollback: () => Promise<void>
  scriptTokenUsage: ScriptTokenUsageLog
}

export function registerAppQuit({
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
}: AppQuitDeps) {
  let telemetrySentForQuit = false
  let sendingTelemetryForQuit = false
  let quitAnswer: QuitAnswer | null = null

  function confirmQuitOn(): boolean {
    return readSettingsFile().workspaces?.confirmQuit !== false
  }
  let quitAsking = false
  let quitRequested = false

  function requestQuit(): void {
    quitRequested = true
    app.quit()
  }
  let quitSignaled = false

  function handleQuitSignals(): void {
    for (const signal of QUIT_SIGNALS) {
      process.on(signal, () => {
        services.appLog?.info('quit-signal', { signal })
        quitSignaled = true
        app.quit()
      })
    }
  }

  function exitAtQuitDeadline(): void {
    services.appLog?.warn('quit-deadline', {
      stage: quitTrace.current(),
      totalMs: quitTrace.elapsedMs(),
      alive: summarizeKinds(process.getActiveResourcesInfo()),
    })
    app.exit(0)
  }

  app.on('before-quit', (event) => {
    const plan = planQuit({
      approved: quit.quitApproved,
      requestedByOstia: quitRequested,
      signaled: quitSignaled,
      platform: process.platform,
    })
    quitRequested = false
    quitTrace.stage(`plan-${plan}`)
    if (plan === 'unattended') {
      quit.quitApproved = true
      freezeAll([...windows.values()])
      exitAfterDeadline(exitAtQuitDeadline)
    }
    if (plan === 'ask') {
      event.preventDefault()
      if (quitAsking) return
      quitAsking = true
      const all = [...windows.values()]
      const kept = keptOnQuit(
        quit.restartRequested,
        confirmQuitOn(),
        [...ptys.values()].map((entry) => ({ paneId: entry.paneId, kept: entry.kept !== null })),
      )
      void confirmQuit(all, BrowserWindow.getFocusedWindow() ?? mainWindow(), {
        scratchFiles: (workspaceId) => scratchFolders.countFiles(workspaceId),
        kept: kept.kept,
        keptShells: kept.offer,
        workspacesOf: (win) => services.broker?.workspacesOf(win) ?? [],
        processes: () =>
          [...ptys.values()].map((entry) => ({
            paneId: entry.paneId,
            workspaceId: entry.workspaceId,
            ...paneActivity(entry),
          })),
        confirmNative: nativeQuitConfirm(mainStrings),
      }).then((answer) => {
        quitAsking = false
        if (answer === 'cancel') {
          quit.restartRequested = false
          return
        }
        quitAnswer = answer
        quit.quitApproved = true
        freezeAll(all)
        app.quit()
      })
      return
    }
    if (!quit.scrollbackSavedForQuit) {
      event.preventDefault()
      if (quit.savingScrollbackForQuit) return
      quit.savingScrollbackForQuit = true
      quitTrace.stage('scrollback')
      void persistScrollback().finally(() => {
        quit.scrollbackSavedForQuit = true
        app.quit()
      })
      return
    }
    if (!telemetrySentForQuit) {
      event.preventDefault()
      if (sendingTelemetryForQuit) return
      sendingTelemetryForQuit = true
      quitTrace.stage('telemetry')
      void (services.telemetry?.shutdown() ?? Promise.resolve()).finally(() => {
        telemetrySentForQuit = true
        app.quit()
      })
      return
    }
    teardown(quitAnswer)
  })

  app.on('will-quit', () => {
    quitTrace.stage('will-quit')
    scriptTokenUsage.close()
  })
  app.on('quit', () => quitTrace.stage('quit'))

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') requestQuit()
  })

  return { requestQuit, handleQuitSignals }
}
