import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type BrowserWindow, Notification, app, ipcMain } from 'electron'
import {
  type NotificationSettings,
  parseNotificationSettings,
} from '../../shared/app/notificationSettings'
import type { RedactText } from '../../shared/privacy/redactionTargets'
import {
  type NotificationEntry,
  type NotificationKind,
  type NotificationPost,
  notificationKindOf,
} from '../../shared/types'
import { registerControlMethod } from '../control/controlServer'
import { emitPlatformEvent } from '../control/events'
import { getByPaneId } from '../control/idRegistry'
import { loadJson, saveJson, storePath } from '../platform/jsonStore'
import { type AttentionDeps, clampMessage, targetOf } from './attention'
import { runNotifyCommand } from './notifyCommand'

const LOG_CAP = 500
const TITLE_MAX = 256

export interface NotifyDeps extends AttentionDeps {
  windows: () => Iterable<BrowserWindow>
  windowById: (windowId: string) => BrowserWindow | undefined
  isScratchPane: (paneId: string) => boolean
  redact: RedactText
}

const unsaved: NotificationEntry[] = []

function logPath(): string {
  return storePath('notifications', 'global')
}

function savedLog(): NotificationEntry[] {
  return loadJson<NotificationEntry[]>(logPath(), [])
}

function readLog(): NotificationEntry[] {
  if (unsaved.length === 0) return savedLog()
  return [...savedLog(), ...unsaved].sort((a, b) => a.ts.localeCompare(b.ts)).slice(-LOG_CAP)
}

function keep(log: NotificationEntry[], entry: NotificationEntry): void {
  log.push(entry)
  if (log.length > LOG_CAP) log.splice(0, log.length - LOG_CAP)
}

function broadcastChanged(deps: NotifyDeps): void {
  for (const win of deps.windows()) {
    if (!win.isDestroyed()) win.webContents.send('notifications:changed')
  }
}

function activatePane(deps: NotifyDeps, paneId: string): void {
  const windowId = getByPaneId(paneId)?.windowId
  const win = windowId ? deps.windowById(windowId) : undefined
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  win.webContents.send('notifications:activate', paneId)
}

function readNotificationSettings(): NotificationSettings {
  try {
    const path = join(app.getPath('userData'), 'settings.json')
    if (!existsSync(path)) return parseNotificationSettings(undefined)
    const settings = JSON.parse(readFileSync(path, 'utf8')) as { notifications?: unknown }
    return parseNotificationSettings(settings.notifications)
  } catch {
    return parseNotificationSettings(undefined)
  }
}

export function ostiaInFront(windows: Iterable<BrowserWindow>): boolean {
  for (const win of windows) {
    if (!win.isDestroyed() && win.isVisible() && win.isFocused()) return true
  }
  return false
}

function desktopNotification(deps: NotifyDeps, title: string, body?: string): Notification | null {
  if (!Notification.isSupported()) return null
  const settings = readNotificationSettings()
  if (!settings.desktop) return null
  if (!settings.whenFocused && ostiaInFront(deps.windows())) return null
  return new Notification({ title, body, silent: !settings.sound })
}

function showDesktop(deps: NotifyDeps, title: string, body?: string, paneId?: string): void {
  const n = desktopNotification(deps, title, body)
  if (!n) return
  if (paneId) n.on('click', () => activatePane(deps, paneId))
  n.show()
}

interface RecordInput {
  kind?: NotificationKind
  title: string
  body?: string
  paneId?: string
  from: string
  extId?: string
  panelPath?: string
}

let recording: Promise<void> = Promise.resolve()

export function notificationsRecorded(): Promise<void> {
  return recording
}

function record(deps: NotifyDeps, input: RecordInput): Promise<void> {
  const ts = new Date().toISOString()
  recording = recording.then(() => writeRecord(deps, input, ts)).catch(() => {})
  return recording
}

async function writeRecord(deps: NotifyDeps, input: RecordInput, ts: string): Promise<void> {
  const entry: NotificationEntry = {
    id: randomUUID(),
    ts,
    kind: input.kind ?? 'message',
    title: await deps.redact(input.title),
    body: input.body === undefined ? undefined : await deps.redact(input.body),
    from: input.from,
    paneId: input.paneId,
  }
  if (input.extId) entry.extId = input.extId
  if (input.extId && input.panelPath) entry.panelPath = input.panelPath
  if (entry.paneId && deps.isScratchPane(entry.paneId)) {
    keep(unsaved, entry)
  } else {
    const log = savedLog()
    keep(log, entry)
    saveJson(logPath(), log)
  }
  emitPlatformEvent('notify', { title: entry.title, body: entry.body, from: entry.from })
  runNotifyCommand(readNotificationSettings().command, {
    title: entry.title,
    body: entry.body ?? '',
    pane: entry.paneId ?? '',
  })
  broadcastChanged(deps)
}

export function postNotification(
  deps: NotifyDeps,
  input: { title: string; body?: string; from: string },
): void {
  showDesktop(deps, input.title, input.body)
  void record(deps, input)
}

export function postActionNotification(
  deps: NotifyDeps,
  input: { title: string; body?: string; from: string },
  onClick: () => void,
): void {
  const n = desktopNotification(deps, input.title, input.body)
  if (n) {
    n.on('click', onClick)
    n.show()
  }
  void record(deps, input)
}

export function postPanelNotification(
  deps: NotifyDeps,
  input: { title: string; body?: string; from: string; extId: string; panelPath?: string },
  openPanel: () => void,
): void {
  const n = desktopNotification(deps, input.title, input.body)
  if (n) {
    n.on('click', () => {
      const win = [...deps.windows()].find((w) => !w.isDestroyed())
      if (win) {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      }
      openPanel()
    })
    n.show()
  }
  void record(deps, input)
}

export function registerNotifyMethods(deps: NotifyDeps): void {
  registerControlMethod('notify', {
    cap: 'notify',
    scripts: true,
    handler: async (params: unknown, ctx) => {
      const { title: rawTitle, body: rawBody } = (params ?? {}) as {
        title?: unknown
        body?: unknown
      }
      const title = typeof rawTitle === 'string' ? rawTitle.slice(0, TITLE_MAX) : ''
      const body = clampMessage(rawBody)
      if (!title) return { ok: false, error: 'missing-title' }
      const { paneId, externalId } = ctx.identity
      if (ctx.identity.kind === 'script') {
        showDesktop(deps, title, body)
        await record(deps, { title, body, from: externalId })
        return { ok: true }
      }
      await record(deps, { title, body, paneId, from: externalId })
      const res = await deps.execCommand(targetOf(ctx.identity), 'attention.notify', {
        message: body ? `${title}: ${body}` : title,
      })
      const result = res.ok ? (res.result as { desktop?: unknown } | undefined) : undefined
      if (!res.ok || result?.desktop !== false) showDesktop(deps, title, body, paneId)
      return { ok: true }
    },
  })

  registerControlMethod('notify.list', {
    cap: 'notify',
    handler: (params: unknown) => {
      const { n } = (params ?? {}) as { n?: number }
      return readLog().slice(-(n ?? 20))
    },
  })
}

export function registerNotifyIpc(deps: NotifyDeps): void {
  ipcMain.handle('notifications:list', (): NotificationEntry[] =>
    readLog()
      .map((entry) => ({ ...entry, kind: notificationKindOf(entry.kind) }))
      .reverse(),
  )

  ipcMain.on('notifications:post', (e, post: NotificationPost) => {
    if (!post || typeof post.paneId !== 'string' || typeof post.title !== 'string') return
    const identity = getByPaneId(post.paneId)
    if (identity && identity.windowId !== String(e.sender.id)) return
    const title = post.title.slice(0, TITLE_MAX)
    if (!title) return
    const body = clampMessage(post.body)
    void record(deps, {
      kind: notificationKindOf(post.kind),
      title,
      body,
      paneId: post.paneId,
      from: identity?.externalId ?? '',
    })
    if (post.desktop) showDesktop(deps, title, body, post.paneId)
  })

  ipcMain.on('notifications:reveal', (_e, paneId: unknown) => {
    if (typeof paneId === 'string') activatePane(deps, paneId)
  })

  ipcMain.on('notifications:clear', () => {
    unsaved.length = 0
    saveJson(logPath(), [])
    broadcastChanged(deps)
  })
}
