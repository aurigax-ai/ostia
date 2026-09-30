import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type BrowserWindow, Notification, app, ipcMain } from 'electron'
import {
  type NotificationSettings,
  parseNotificationSettings,
} from '../shared/notificationSettings'
import type { NotificationEntry, NotificationPost } from '../shared/types'
import { type AttentionDeps, clampMessage, targetOf } from './attention'
import { registerControlMethod } from './controlServer'
import { emitPlatformEvent } from './events'
import { getByPaneId } from './idRegistry'
import { loadJson, saveJson, storePath } from './jsonStore'

const LOG_CAP = 500
const TITLE_MAX = 256

export interface NotifyDeps extends AttentionDeps {
  windows: () => Iterable<BrowserWindow>
  windowById: (windowId: string) => BrowserWindow | undefined
}

function logPath(): string {
  return storePath('notifications', 'global')
}

function readLog(): NotificationEntry[] {
  return loadJson<NotificationEntry[]>(logPath(), [])
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

function desktopNotification(title: string, body?: string): Notification | null {
  if (!Notification.isSupported()) return null
  const settings = readNotificationSettings()
  if (!settings.desktop) return null
  return new Notification({ title, body, silent: !settings.sound })
}

function showDesktop(deps: NotifyDeps, title: string, body?: string, paneId?: string): void {
  const n = desktopNotification(title, body)
  if (!n) return
  if (paneId) n.on('click', () => activatePane(deps, paneId))
  n.show()
}

function record(
  deps: NotifyDeps,
  input: { title: string; body?: string; paneId?: string; from: string; extId?: string },
): NotificationEntry {
  const entry: NotificationEntry = {
    id: randomUUID(),
    ts: new Date().toISOString(),
    title: input.title,
    body: input.body,
    from: input.from,
    paneId: input.paneId,
  }
  if (input.extId) entry.extId = input.extId
  const log = readLog()
  log.push(entry)
  if (log.length > LOG_CAP) log.splice(0, log.length - LOG_CAP)
  saveJson(logPath(), log)
  emitPlatformEvent('notify', { title: entry.title, body: entry.body, from: entry.from })
  broadcastChanged(deps)
  return entry
}

export function postNotification(
  deps: NotifyDeps,
  input: { title: string; body?: string; from: string },
): void {
  showDesktop(deps, input.title, input.body)
  record(deps, input)
}

export function postPanelNotification(
  deps: NotifyDeps,
  input: { title: string; body?: string; from: string; extId: string },
  openPanel: () => void,
): void {
  const n = desktopNotification(input.title, input.body)
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
  record(deps, input)
}

export function registerNotifyMethods(deps: NotifyDeps): void {
  registerControlMethod('notify', {
    cap: 'notify',
    handler: async (params: unknown, ctx) => {
      const { title: rawTitle, body: rawBody } = (params ?? {}) as {
        title?: unknown
        body?: unknown
      }
      const title = typeof rawTitle === 'string' ? rawTitle.slice(0, TITLE_MAX) : ''
      const body = clampMessage(rawBody)
      if (!title) return { ok: false, error: 'missing-title' }
      const { paneId, externalId } = ctx.identity
      record(deps, { title, body, paneId, from: externalId })
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
  ipcMain.handle('notifications:list', (): NotificationEntry[] => readLog().reverse())

  ipcMain.on('notifications:post', (e, post: NotificationPost) => {
    if (!post || typeof post.paneId !== 'string' || typeof post.title !== 'string') return
    const identity = getByPaneId(post.paneId)
    if (identity && identity.windowId !== String(e.sender.id)) return
    const title = post.title.slice(0, TITLE_MAX)
    if (!title) return
    const body = clampMessage(post.body)
    record(deps, { title, body, paneId: post.paneId, from: identity?.externalId ?? '' })
    if (post.desktop) showDesktop(deps, title, body, post.paneId)
  })

  ipcMain.on('notifications:clear', () => {
    saveJson(logPath(), [])
    broadcastChanged(deps)
  })
}
