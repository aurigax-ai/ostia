import { app, BrowserWindow } from 'electron'
import type { Dict } from '../../shared/app/dict'
import type { PaneActivity } from '../../shared/terminal/ptyApi'
import type { QuitAnswer } from '../../shared/windows/windowsApi'
import { flushBus } from '../agents/busStore'
import type { ScriptTokenUsageLog } from '../approvals/scriptTokenUsage'
import type { AppLog } from '../diagnostics/appLog'
import type { Telemetry } from '../diagnostics/telemetry'
import type { SettingsFile } from '../platform/settingsFile'
import type { PtyEntry } from '../terminal/pty/ptyRegistry'
import type { ScratchFolders } from '../workspaces/scratchFolders'
import type { ScrollbackPersistence } from '../workspaces/scrollbackPersistence'
import { confirmQuit, freezeAll } from './closeGuard'
import type { QuitTrace } from './quitPlan'
import { exitAfterDeadline, keptOnQuit, planQuit, QUIT_SIGNALS, summarizeKinds } from './quitPlan'
import { nativeQuitConfirm } from './quitPrompt'
import type { QuitTeardown } from './quitTeardown'
import type { WindowBroker } from './windowBroker'
import type { WindowSend } from './windowSend'

interface AppQuitDeps {
  teardown: QuitTeardown['teardown']
  readSettingsFile: () => SettingsFile
  services: {
    appLog: AppLog | null
    broker: WindowBroker | null
    telemetry: Telemetry | null
    refreshResume: ((paneId: string) => Promise<void>) | null
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
  mainWindow: WindowSend['mainWindow']
  scratchFolders: ScratchFolders
  paneActivity: (entry: PtyEntry) => PaneActivity
  mainStrings: () => Dict
  persistScrollback: ScrollbackPersistence['persistScrollback']
  scriptTokenUsage: ScriptTokenUsageLog
}

const RESUME_REFRESH_MS = 1500

export type AppQuit = ReturnType<typeof registerAppQuit>

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
  let busFlushedForQuit = false
  let flushingBusForQuit = false
  let tearingDownForQuit = false
  let tornDownForQuit = false
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
      const refreshed = Promise.all(
        [...ptys.keys()].map((paneId) => services.refreshResume?.(paneId).catch(() => {})),
      )
      const settle = new Promise<void>((resolve) => setTimeout(resolve, RESUME_REFRESH_MS))
      void Promise.race([refreshed, settle])
        .then(() => persistScrollback())
        .finally(() => {
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
    if (!busFlushedForQuit) {
      event.preventDefault()
      if (flushingBusForQuit) return
      flushingBusForQuit = true
      quitTrace.stage('bus')
      void flushBus().finally(() => {
        busFlushedForQuit = true
        app.quit()
      })
      return
    }
    if (!tornDownForQuit) {
      event.preventDefault()
      if (tearingDownForQuit) return
      tearingDownForQuit = true
      void teardown(quitAnswer).finally(() => {
        tornDownForQuit = true
        app.quit()
      })
    }
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
