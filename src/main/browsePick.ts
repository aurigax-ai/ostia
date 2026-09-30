import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ipcMain } from 'electron'
import {
  PICK_NOTE_MAX,
  type PickCapture,
  type PickOutcome,
  type PickSendRequest,
  type PickSendResult,
  type PickState,
  type PickTheme,
  type RawPick,
  clip,
  normalizeCapture,
  pickBusMessage,
  renderPickReport,
  screenshotRect,
} from '../shared/pick'
import { PICK_RUNTIME_GLOBAL, pickRuntimeScript } from '../shared/pickRuntime'
import { type ConsoleEntry, ownedGuest, resolveGuest } from './browse'
import { postBusMessage } from './bus'
import { registerControlMethod } from './controlServer'
import { failedRequestsFor } from './guestNetwork'
import { getByPaneId } from './idRegistry'
import { privateTmpDir } from './privateTmp'

export interface PickDeps {
  browserPanes: Map<string, number>
  errorBuffers: Map<number, ConsoleEntry[]>
  broadcast: (channel: string, payload: unknown) => void
}

export const PICK_WORLD_ID = 1024
export const REPORT_DIR_NAME = 'pine-reports'
export const DEFAULT_AGENT_PICK_TIMEOUT_MS = 120_000
export const MIN_PICK_TIMEOUT_MS = 1_000
export const MAX_PICK_TIMEOUT_MS = 600_000
const USER_PICK_TIMEOUT_MS = MAX_PICK_TIMEOUT_MS
const MAX_STORED_CAPTURES = 20
const THEME_VALUE = /^[#(),.%\w\s-]{1,64}$/

const FALLBACK_THEME: PickTheme = { accent: '#00d8ff', surface: '#313537', fg: '#e3edf5' }

const RUNTIME_SCRIPT = pickRuntimeScript()

let lastTheme: PickTheme = FALLBACK_THEME
let captureCounter = 0
const captures = new Map<string, { capture: PickCapture; paneId: string }>()
const active = new Map<string, () => void>()

export function clampPickTimeout(timeoutMs: unknown): number {
  if (typeof timeoutMs !== 'number' || Number.isNaN(timeoutMs)) {
    return DEFAULT_AGENT_PICK_TIMEOUT_MS
  }
  return Math.min(MAX_PICK_TIMEOUT_MS, Math.max(MIN_PICK_TIMEOUT_MS, timeoutMs))
}

export function sanitizeTheme(theme: unknown): PickTheme | undefined {
  if (!theme || typeof theme !== 'object') return undefined
  const t = theme as Record<string, unknown>
  const ok = (v: unknown): v is string => typeof v === 'string' && THEME_VALUE.test(v.trim())
  if (!ok(t.accent) || !ok(t.surface) || !ok(t.fg)) return undefined
  return { accent: t.accent.trim(), surface: t.surface.trim(), fg: t.fg.trim() }
}

function runInPickWorld(guest: Electron.WebContents, js: string): Promise<unknown> {
  return guest.executeJavaScriptInIsolatedWorld(PICK_WORLD_ID, [
    { code: `${RUNTIME_SCRIPT}\n${js}` },
  ])
}

function nextCaptureId(): string {
  captureCounter += 1
  return `pick-${Date.now().toString(36)}-${captureCounter}`
}

function storeCapture(capture: PickCapture, paneId: string): void {
  captures.set(capture.id, { capture, paneId })
  while (captures.size > MAX_STORED_CAPTURES) {
    const oldest = captures.keys().next().value
    if (oldest === undefined) break
    captures.delete(oldest)
  }
}

async function elementScreenshot(
  guest: Electron.WebContents,
  raw: Partial<RawPick>,
  id: string,
): Promise<string | null> {
  if (!raw.box || !raw.viewport) return null
  const rect = screenshotRect(raw.box, raw.viewport, guest.getZoomFactor())
  if (!rect) return null
  try {
    const image = await guest.capturePage(rect)
    if (image.isEmpty()) return null
    const path = join(privateTmpDir(REPORT_DIR_NAME), `${id}.png`)
    writeFileSync(path, image.toPNG(), { mode: 0o600 })
    return path
  } catch {
    return null
  }
}

async function buildCapture(
  deps: PickDeps,
  guest: Electron.WebContents,
  paneId: string,
  raw: Partial<RawPick>,
): Promise<PickCapture> {
  const id = nextCaptureId()
  const screenshotPath = await elementScreenshot(guest, raw, id)
  const capture = normalizeCapture(raw, {
    id,
    consoleErrors: deps.errorBuffers.get(guest.id) ?? [],
    failedRequests: failedRequestsFor(guest.id),
    screenshotPath,
    capturedAt: new Date(),
  })
  storeCapture(capture, paneId)
  return capture
}

export interface RunPickOptions {
  theme?: PickTheme
  timeoutMs: number
  byAgent: boolean
}

export function runPick(
  deps: PickDeps,
  guest: Electron.WebContents,
  paneId: string,
  opts: RunPickOptions,
): Promise<PickOutcome> {
  if (active.has(paneId)) return Promise.resolve({ ok: false, error: 'busy' })
  if (opts.theme) lastTheme = opts.theme
  const theme = opts.theme ?? lastTheme
  const announce = (on: boolean): void => {
    const state: PickState = { paneId, active: on, byAgent: opts.byAgent }
    deps.broadcast('browser:pick-state', state)
  }
  return new Promise<PickOutcome>((resolve) => {
    let settled = false
    const onNavigate = (
      _e: unknown,
      _url: string,
      isInPlace: boolean,
      isMainFrame: boolean,
    ): void => {
      if (isMainFrame && !isInPlace) settle({ ok: false, error: 'navigated' })
    }
    const onGone = (): void => settle({ ok: false, error: 'browser-not-ready' })
    const timer = setTimeout(() => settle({ ok: false, error: 'timeout' }), opts.timeoutMs)
    const settle = (outcome: PickOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      guest.removeListener('did-start-navigation', onNavigate)
      guest.removeListener('destroyed', onGone)
      active.delete(paneId)
      announce(false)
      if (!outcome.ok && !guest.isDestroyed()) {
        runInPickWorld(guest, `window.${PICK_RUNTIME_GLOBAL}.cancel()`).catch(() => {})
      }
      resolve(outcome)
    }
    guest.on('did-start-navigation', onNavigate)
    guest.once('destroyed', onGone)
    active.set(paneId, () => settle({ ok: false, error: 'cancelled' }))
    announce(true)
    runInPickWorld(guest, `window.${PICK_RUNTIME_GLOBAL}.start(${JSON.stringify(theme)})`)
      .then(async (raw) => {
        if (settled) return
        if (!raw || typeof raw !== 'object') {
          settle({ ok: false, error: 'cancelled' })
          return
        }
        const capture = await buildCapture(deps, guest, paneId, raw as Partial<RawPick>)
        settle({ ok: true, capture })
      })
      .catch(() => settle({ ok: false, error: 'eval-failed' }))
  })
}

export function cancelPick(paneId: string): boolean {
  const cancel = active.get(paneId)
  if (!cancel) return false
  cancel()
  return true
}

function nextReportPath(dir: string): string {
  for (let n = 1; ; n++) {
    const path = join(dir, `ui-issue-${n}.md`)
    if (!existsSync(path)) return path
  }
}

export function writePickReport(req: PickSendRequest, senderWindowId: string): PickSendResult {
  const source = getByPaneId(req.sourcePaneId)
  const target = getByPaneId(req.targetPaneId)
  if (!source || source.windowId !== senderWindowId || !target) {
    return { ok: false, error: 'not-found' }
  }
  const stored = captures.get(req.captureId)
  if (!stored || stored.paneId !== req.sourcePaneId) return { ok: false, error: 'capture-expired' }
  const note = clip(typeof req.note === 'string' ? req.note : '', PICK_NOTE_MAX)
  let path: string
  try {
    path = nextReportPath(privateTmpDir(REPORT_DIR_NAME))
    writeFileSync(path, renderPickReport(stored.capture, note), { mode: 0o600, flag: 'wx' })
  } catch {
    return { ok: false, error: 'write-failed' }
  }
  postBusMessage(source.externalId, target.externalId, pickBusMessage(stored.capture, note, path))
  return { ok: true, path }
}

export function registerPickIpc(deps: PickDeps): void {
  ipcMain.handle('browser:pick-start', (e, paneId: string, theme?: unknown) => {
    const guest = ownedGuest(deps.browserPanes, paneId, String(e.sender.id))
    if (!guest) return { ok: false, error: 'browser-not-ready' } satisfies PickOutcome
    return runPick(deps, guest, paneId, {
      theme: sanitizeTheme(theme),
      timeoutMs: USER_PICK_TIMEOUT_MS,
      byAgent: false,
    })
  })
  ipcMain.on('browser:pick-cancel', (e, paneId: string) => {
    if (getByPaneId(paneId)?.windowId === String(e.sender.id)) cancelPick(paneId)
  })
  ipcMain.handle('browser:pick-send', (e, req: PickSendRequest) =>
    writePickReport(req ?? ({} as PickSendRequest), String(e.sender.id)),
  )
}

export function registerPickMethods(deps: PickDeps): void {
  registerControlMethod('browse.pick', {
    cap: 'browse',
    handler: async (params, ctx) => {
      const { paneId, timeoutMs } = (params ?? {}) as { paneId?: string; timeoutMs?: number }
      const resolution = await resolveGuest(deps, ctx, paneId)
      if (!resolution.ok) return resolution
      if (active.has(resolution.rendererPaneId)) return { ok: false, error: 'busy' }
      const pick = runPick(deps, resolution.guest, resolution.rendererPaneId, {
        timeoutMs: clampPickTimeout(timeoutMs),
        byAgent: true,
      })
      const cancel = active.get(resolution.rendererPaneId)
      const closed = cancel ? ctx.conn.onClose(() => cancel()) : null
      try {
        return await pick
      } finally {
        closed?.dispose()
      }
    },
  })
}
