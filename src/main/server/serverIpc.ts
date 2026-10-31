import { type IpcMainInvokeEvent, ipcMain } from 'electron'
import type { ServerActionResult, ServerFailure, ServerStatus } from '../../shared/server/serverApi'
import type { ServerAccount } from './serverAccount'
import { parseServerUrl } from './serverUrl'

export interface ServerIpcDeps {
  account: ServerAccount
  allowInsecure: boolean
  openExternal: (url: string) => boolean
}

const NOT_A_WINDOW: { ok: false; error: ServerFailure } = { ok: false, error: 'not-a-window' }
const CODE_MAX = 128

function fromWindow(e: IpcMainInvokeEvent): boolean {
  return e.sender.getType() === 'window'
}

function guarded<A extends unknown[], R>(
  run: (...args: A) => R,
  refused: R,
): (e: IpcMainInvokeEvent, ...args: A) => R {
  return (e, ...args) => (fromWindow(e) ? run(...args) : refused)
}

const NO_STATUS: ServerStatus = {
  url: null,
  host: null,
  signedIn: false,
  provider: null,
  deviceName: null,
}

function setUrl(deps: ServerIpcDeps, value: unknown): ServerActionResult {
  if (typeof value !== 'string') return { ok: false, error: 'invalid-url' }
  if (value.trim() === '') return deps.account.setUrl(null)
  const url = parseServerUrl(value, deps.allowInsecure)
  return url ? deps.account.setUrl(url) : { ok: false, error: 'invalid-url' }
}

function openVerification(deps: ServerIpcDeps): void {
  const uri = deps.account.verificationUri()
  if (uri) deps.openExternal(uri)
}

export function registerServerIpc(deps: ServerIpcDeps): void {
  const { account } = deps
  ipcMain.handle(
    'server:status',
    guarded(() => account.status(), NO_STATUS),
  )
  ipcMain.handle(
    'server:set-url',
    guarded((value: unknown) => setUrl(deps, value), NOT_A_WINDOW),
  )
  ipcMain.handle(
    'server:info',
    guarded(() => account.info(), Promise.resolve(NOT_A_WINDOW)),
  )
  ipcMain.handle(
    'server:sign-in-invite',
    guarded(
      (code: unknown) =>
        typeof code === 'string' && code.trim() !== '' && code.length <= CODE_MAX
          ? account.signInWithInvite(code)
          : Promise.resolve<ServerActionResult>({ ok: false, error: 'invalid-invite' }),
      Promise.resolve(NOT_A_WINDOW),
    ),
  )
  ipcMain.handle(
    'server:github-start',
    guarded(() => account.githubStart(), Promise.resolve(NOT_A_WINDOW)),
  )
  ipcMain.handle(
    'server:github-poll',
    guarded(
      () => account.githubPoll(),
      Promise.resolve({ state: 'error' as const, error: 'not-a-window' as const }),
    ),
  )
  ipcMain.handle(
    'server:github-cancel',
    guarded(() => account.githubCancel(), undefined),
  )
  ipcMain.handle(
    'server:open-verification',
    guarded(() => openVerification(deps), undefined),
  )
  ipcMain.handle(
    'server:sign-out',
    guarded(() => account.signOut(), Promise.resolve(NOT_A_WINDOW)),
  )
}
