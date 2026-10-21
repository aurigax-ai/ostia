import { type IpcMainInvokeEvent, ipcMain } from 'electron'
import type { ServerSyncResult, ServerSyncStatus } from '../../../shared/profileSync/serverSync'
import type { ServerSyncService } from './serverSyncService'

export interface ServerSyncIpcDeps {
  service: ServerSyncService
  run: () => Promise<unknown>
  broadcast: (channel: string, payload?: unknown) => void
}

const SECRET_INPUT_MAX = 1024
const ID_MAX = 128

const REFUSED_STATUS: ServerSyncStatus = {
  state: 'signed-out',
  host: null,
  linking: false,
  linkCodes: [],
  joins: [],
  recoveryStale: false,
}

const refused = (error: 'not-a-window' | 'invalid-input'): ServerSyncResult => ({
  ok: false,
  error,
  status: REFUSED_STATUS,
})

const text = (value: unknown, max = SECRET_INPUT_MAX): string | null =>
  typeof value === 'string' && value.length <= max ? value : null

const id = (value: unknown): string | null => {
  const checked = text(value, ID_MAX)
  return checked ? checked : null
}

function fromWindow(e: IpcMainInvokeEvent): boolean {
  return e.sender.getType() === 'window'
}

export function registerServerSyncIpc({ service, run, broadcast }: ServerSyncIpcDeps): void {
  const act = (
    channel: string,
    arity: number,
    perform: (...args: string[]) => Promise<ServerSyncResult>,
    syncAfter = true,
  ): void => {
    ipcMain.handle(channel, async (e, ...raw: unknown[]): Promise<ServerSyncResult> => {
      if (!fromWindow(e)) return refused('not-a-window')
      const args = raw.slice(0, arity).map((value) => text(value))
      if (args.length < arity || args.some((a) => a === null)) return refused('invalid-input')
      const result = await perform(...(args as string[]))
      if (result.ok && syncAfter) void run()
      broadcast('syncServer:status', result.status)
      return result
    })
  }

  ipcMain.handle('syncServer:status', (e) =>
    fromWindow(e) ? service.status() : Promise.resolve(REFUSED_STATUS),
  )
  act('syncServer:setup', 2, (pw, confirm) => service.setup(pw ?? '', confirm ?? ''))
  act('syncServer:unlock', 1, (pw) => service.unlock(pw ?? ''))
  act('syncServer:recover', 1, (key) => service.recover(key ?? ''))
  act('syncServer:link-start', 0, () => service.linkStart(), false)
  act('syncServer:link-stop', 0, () => service.linkStop(), false)
  act('syncServer:new-recovery-key', 0, () => service.newRecoveryKey(), false)
  act('syncServer:gc', 0, () => service.collectGarbage(), false)
  act('syncServer:rotate', 2, (pw, key) => service.rotate(pw ?? '', key ?? ''))
  act(
    'syncServer:approve-join',
    1,
    (deviceId) => {
      const checked = id(deviceId)
      return checked ? service.approveJoin(checked) : Promise.resolve(refused('invalid-input'))
    },
    false,
  )
  act('syncServer:remove-device', 3, (deviceId, pw, key) => {
    const checked = id(deviceId)
    return checked
      ? service.removeDevice(checked, pw ?? '', key ?? '')
      : Promise.resolve(refused('invalid-input'))
  })
}
