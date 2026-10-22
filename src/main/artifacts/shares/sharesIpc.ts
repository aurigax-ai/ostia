import { type IpcMainInvokeEvent, ipcMain } from 'electron'
import type {
  ShareActionResult,
  ShareAvailability,
  SharesListResult,
} from '../../../shared/artifacts/shares'
import type { ShareService } from './shareService'

const ID_MAX = 128

const NOT_A_WINDOW: { ok: false; error: 'not-a-window' } = { ok: false, error: 'not-a-window' }

function fromWindow(e: IpcMainInvokeEvent): boolean {
  return e.sender.getType() === 'window'
}

const validId = (value: unknown): value is string =>
  typeof value === 'string' && value !== '' && value.length <= ID_MAX

export function registerSharesIpc(shares: ShareService): void {
  ipcMain.handle(
    'shares:status',
    (e): Promise<ShareAvailability> =>
      fromWindow(e) ? shares.availability() : Promise.resolve({ state: 'unavailable' }),
  )
  ipcMain.handle(
    'shares:list',
    (e): Promise<SharesListResult> =>
      fromWindow(e) ? shares.list() : Promise.resolve(NOT_A_WINDOW),
  )
  ipcMain.handle('shares:copy-link', async (e, id: unknown): Promise<ShareActionResult> => {
    if (!fromWindow(e)) return NOT_A_WINDOW
    return validId(id) ? await shares.copyLink(id) : { ok: false, error: 'unknown' }
  })
  ipcMain.handle('shares:delete', (e, id: unknown): Promise<ShareActionResult> => {
    if (!fromWindow(e)) return Promise.resolve(NOT_A_WINDOW)
    return validId(id) ? shares.remove(id) : Promise.resolve({ ok: false, error: 'unknown' })
  })
}
