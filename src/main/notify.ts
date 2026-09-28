import { Notification } from 'electron'
import { registerControlMethod } from './controlServer'
import { emitPlatformEvent } from './events'
import { loadJson, saveJson, storePath } from './jsonStore'

interface NotifyEntry {
  ts: string
  title: string
  body?: string
  from: string
}

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
      const from = ctx.identity.paneId
      appendEntry({ ts: new Date().toISOString(), title, body, from })
      emitPlatformEvent('notify', { title, body, from })
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
