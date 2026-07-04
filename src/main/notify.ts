/**
 * `notify` toolbelt service (agent-toolbelt plan, capability 'notify' — a DEFAULT since
 * firing a desktop notification is low-risk). Fires an OS notification via Electron's
 * `Notification` API and appends every fire to a capped, global JSON log (`jsonStore`)
 * so `notify.list` (and future UI) can show recent activity across all panes/windows.
 */
import { Notification } from 'electron'
import { registerControlMethod } from './controlServer'
import { loadJson, saveJson, storePath } from './jsonStore'

interface NotifyEntry {
  ts: string
  title: string
  body?: string
  from: string
}

/** Cap on the persisted log — oldest entries drop off once this is exceeded. */
const LOG_CAP = 500

function logPath(): string {
  return storePath('notifications', 'global')
}

function appendEntry(entry: NotifyEntry): void {
  const log = loadJson<NotifyEntry[]>(logPath(), [])
  log.push(entry)
  if (log.length > LOG_CAP) log.splice(0, log.length - LOG_CAP)
  saveJson(logPath(), log)
}

export function registerNotifyMethods(): void {
  registerControlMethod('notify', {
    cap: 'notify',
    handler: (params: unknown, ctx) => {
      const { title, body } = (params ?? {}) as { title: string; body?: string }
      if (Notification.isSupported()) {
        new Notification({ title, body }).show()
      }
      appendEntry({
        ts: new Date().toISOString(),
        title,
        body,
        from: ctx.identity.paneId,
      })
      return { ok: true }
    },
  })

  registerControlMethod('notify.list', {
    cap: 'notify',
    handler: (params: unknown) => {
      const { n } = (params ?? {}) as { n?: number }
      const log = loadJson<NotifyEntry[]>(logPath(), [])
      const count = n ?? 20
      return log.slice(-count)
    },
  })
}
