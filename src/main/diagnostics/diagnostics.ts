import { mkdirSync } from 'node:fs'
import { basename } from 'node:path'
import { type BrowserWindow, app, ipcMain } from 'electron'
import type { ErrorInput } from '../../shared/privacy/telemetry'
import type { AppLog } from './appLog'
import { ReportLimiter, normalizePaneIds, normalizeRendererReport } from './rendererReports'

export const CRASH_RELOADS_PER_MINUTE = 3

export type RecoveryReason = 'reload' | 'render-error' | 'renderer-gone'

export interface DiagnosticsDeps {
  log: AppLog
  telemetry: { error: (input: ErrorInput) => void }
  version: string
  logDir: string
  testHooks: boolean
  startRecovery: (windowId: string, reason: RecoveryReason) => void
  finishRecovery: (windowId: string, livePaneIds: Set<string>) => void
  openPath: (path: string) => Promise<string>
}

export interface Diagnostics {
  watchWindow: (win: BrowserWindow) => void
}

function errorFields(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) return { message: err.message, stack: err.stack }
  return { message: String(err) }
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'Error'
}

const RENDERER_SOURCES = {
  error: 'renderer-error',
  rejection: 'renderer-rejection',
  render: 'render-error',
  surface: 'surface-error',
} as const

function sourceOf(sourceId: string, line: number): string | undefined {
  return sourceId ? `${basename(sourceId)}:${line}` : undefined
}

export function registerDiagnostics(deps: DiagnosticsDeps): Diagnostics {
  const { log } = deps
  const reports = new ReportLimiter()
  const crashReloads = new ReportLimiter(CRASH_RELOADS_PER_MINUTE)

  log.info('app-start', {
    version: deps.version,
    electron: process.versions.electron,
    platform: process.platform,
    packaged: app.isPackaged,
  })

  process.on('uncaughtException', (err) => {
    log.error('main-uncaught-exception', errorFields(err))
    deps.telemetry.error({ source: 'main-exception', name: errorName(err), ...errorFields(err) })
    console.error('[main] uncaught exception', err)
  })
  process.on('unhandledRejection', (reason) => {
    log.error('main-unhandled-rejection', errorFields(reason))
    deps.telemetry.error({
      source: 'main-rejection',
      name: errorName(reason),
      ...errorFields(reason),
    })
    console.error('[main] unhandled rejection', reason)
  })

  app.on('child-process-gone', (_e, details) => {
    log.warn('child-process-gone', {
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
      name: details.name,
      service: details.serviceName,
    })
  })
  app.on('render-process-gone', (_e, contents, details) => {
    if (contents.getType() === 'window') return
    log.warn('guest-process-gone', {
      type: contents.getType(),
      reason: details.reason,
      exitCode: details.exitCode,
    })
  })

  const windowIdOf = (sender: Electron.WebContents): string => String(sender.id)

  const allowReport = (key: string, windowId: string): boolean => {
    const { allowed, suppressed } = reports.take(key)
    if (suppressed > 0) log.warn('renderer-reports-suppressed', { window: windowId, suppressed })
    return allowed
  }

  ipcMain.on('diagnostics:report', (e, raw: unknown) => {
    const report = normalizeRendererReport(raw)
    if (!report) return
    const windowId = windowIdOf(e.sender)
    if (report.kind === 'render') deps.startRecovery(windowId, 'render-error')
    if (!allowReport(`report:${windowId}`, windowId)) return
    log.error('renderer-error', { window: windowId, ...report })
    deps.telemetry.error({
      source: RENDERER_SOURCES[report.kind],
      name: 'Error',
      message: report.message,
      stack: report.stack,
    })
  })

  ipcMain.on('diagnostics:ready', (e, raw: unknown) => {
    const paneIds = normalizePaneIds(raw)
    if (paneIds) deps.finishRecovery(windowIdOf(e.sender), paneIds)
  })

  ipcMain.on('diagnostics:reload-window', (e) => {
    if (e.sender.isDestroyed()) return
    deps.startRecovery(windowIdOf(e.sender), 'reload')
    e.sender.reload()
  })

  ipcMain.on('diagnostics:toggle-devtools', (e) => {
    if (e.sender.isDestroyed()) return
    log.info('devtools-toggled', { window: windowIdOf(e.sender) })
    e.sender.toggleDevTools()
  })

  ipcMain.handle('diagnostics:open-log-folder', async () => {
    mkdirSync(deps.logDir, { recursive: true })
    return (await deps.openPath(deps.logDir)) === ''
  })

  ipcMain.handle('diagnostics:test-hooks', () => deps.testHooks)

  function watchWindow(win: BrowserWindow): void {
    const contents = win.webContents
    const windowId = String(contents.id)
    let loaded = false

    contents.on('did-finish-load', () => {
      loaded = true
    })
    contents.on('did-start-navigation', (details) => {
      if (!loaded || !details.isMainFrame || details.isSameDocument) return
      log.info('window-reload', { window: windowId })
      deps.startRecovery(windowId, 'reload')
    })
    contents.on('did-fail-load', (_e, code, description, _url, isMainFrame) => {
      log.warn('did-fail-load', { window: windowId, code, description, mainFrame: isMainFrame })
    })
    contents.on('render-process-gone', (_e, details) => {
      log.error('render-process-gone', {
        window: windowId,
        reason: details.reason,
        exitCode: details.exitCode,
      })
      if (details.reason === 'clean-exit' || win.isDestroyed()) return
      deps.telemetry.error({
        source: 'renderer-gone',
        name: 'RendererGone',
        message: `${details.reason} (${details.exitCode})`,
      })
      deps.startRecovery(windowId, 'renderer-gone')
      if (!crashReloads.take(windowId).allowed) {
        log.error('renderer-reload-skipped', { window: windowId, reason: 'crash-loop' })
        return
      }
      log.info('renderer-reload', { window: windowId })
      contents.reload()
    })
    contents.on('console-message', (event) => {
      if (event.level !== 'error') return
      if (!allowReport(`console:${windowId}`, windowId)) return
      log.error('renderer-console-error', {
        window: windowId,
        message: event.message,
        source: sourceOf(event.sourceId, event.lineNumber),
      })
    })
    win.on('unresponsive', () => log.warn('window-unresponsive', { window: windowId }))
    win.on('responsive', () => log.info('window-responsive', { window: windowId }))
    win.on('closed', () => {
      reports.forget(`report:${windowId}`)
      reports.forget(`console:${windowId}`)
      crashReloads.forget(windowId)
    })
  }

  return { watchWindow }
}
