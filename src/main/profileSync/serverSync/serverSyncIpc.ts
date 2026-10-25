import { type IpcMainInvokeEvent, ipcMain } from 'electron'
import type { ServerSyncResult, ServerSyncStatus } from '../../../shared/profileSync/serverSync'
import type { ServerSyncService } from './serverSyncService'

export interface ServerSyncIpcDeps {
  service: ServerSyncService
  run: () => Promise<unknown>
  broadcast: (channel: string, payload?: unknown) => void
}

const SECRET_INPUT_MAX = 1024

const REFUSED_STATUS: ServerSyncStatus = { state: 'signed-out', host: null }

const refused = (error: 'not-a-window' | 'invalid-input'): ServerSyncResult => ({
  ok: false,
  error,
  status: REFUSED_STATUS,
})

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.length <= SECRET_INPUT_MAX ? value : null

function fromWindow(e: IpcMainInvokeEvent): boolean {
  return e.sender.getType() === 'window'
}

export function registerServerSyncIpc({ service, run, broadcast }: ServerSyncIpcDeps): void {
  const act = (
    channel: string,
    arity: number,
    perform: (...args: string[]) => Promise<ServerSyncResult>,
  ): void => {
    ipcMain.handle(channel, async (e, ...raw: unknown[]): Promise<ServerSyncResult> => {
      if (!fromWindow(e)) return refused('not-a-window')
      const args = raw.slice(0, arity).map(text)
      if (args.length < arity || args.some((a) => a === null)) return refused('invalid-input')
      const result = await perform(...(args as string[]))
      if (result.ok) void run()
      broadcast('syncServer:status', result.status)
      return result
    })
  }

  ipcMain.handle('syncServer:status', (e) =>
    fromWindow(e) ? service.status() : Promise.resolve(REFUSED_STATUS),
  )
  act('syncServer:setup', 2, (pw = '', confirm = '') => service.setup(pw, confirm))
  act('syncServer:unlock', 1, (pw = '') => service.unlock(pw))
  act('syncServer:recover', 3, (key = '', pw = '', confirm = '') =>
    service.recover(key, pw, confirm),
  )
  act('syncServer:change-passphrase', 3, (current = '', next = '', confirm = '') =>
    service.changePassphrase(current, next, confirm),
  )
}
