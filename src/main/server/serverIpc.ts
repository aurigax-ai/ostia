import { type IpcMainInvokeEvent, ipcMain } from 'electron'
import type {
  ElevationStartResult,
  ServerActionResult,
  ServerFailure,
  ServerStatus,
} from '../../shared/server/serverApi'
import type { ServerAccount } from './serverAccount'
import type { ServerDevices } from './serverDevices'
import type { ServerElevation } from './serverElevation'
import { githubDeviceUri, parseServerUrl } from './serverUrl'

export interface ServerIpcDeps {
  account: ServerAccount
  devices: ServerDevices
  elevation: ServerElevation
  allowInsecure: boolean
  openExternal: (url: string) => boolean
}

const INVALID: { ok: false; error: ServerFailure } = { ok: false, error: 'failed' }
const NOT_A_WINDOW: { ok: false; error: ServerFailure } = { ok: false, error: 'not-a-window' }
const CODE_MAX = 128
const ID_MAX = 128

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

const validId = (value: unknown): value is string =>
  typeof value === 'string' && value !== '' && value.length <= ID_MAX

async function startElevation(deps: ServerIpcDeps, method: unknown): Promise<ElevationStartResult> {
  if (method !== 'approval' && method !== 'github') return { ok: false, error: 'failed' }
  const started = await deps.elevation.start(method)
  if (started.ok && started.kind === 'github') {
    const uri = githubDeviceUri(started.verificationUri)
    if (uri) deps.openExternal(uri)
  }
  return started
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
  ipcMain.handle(
    'server:devices',
    guarded(() => account.devices(), Promise.resolve(NOT_A_WINDOW)),
  )
  ipcMain.handle(
    'server:invite-create',
    guarded(() => deps.devices.createInvite(), Promise.resolve(NOT_A_WINDOW)),
  )
  ipcMain.handle(
    'server:elevation-start',
    guarded((method: unknown) => startElevation(deps, method), Promise.resolve(NOT_A_WINDOW)),
  )
  ipcMain.handle(
    'server:elevation-poll',
    guarded(
      () => deps.elevation.poll(),
      Promise.resolve({ state: 'error' as const, error: 'not-a-window' as const }),
    ),
  )
  ipcMain.handle(
    'server:elevation-cancel',
    guarded(() => deps.elevation.cancel(), Promise.resolve()),
  )
  ipcMain.handle(
    'server:approvals',
    guarded(() => deps.elevation.approvals(), Promise.resolve(NOT_A_WINDOW)),
  )
  ipcMain.handle(
    'server:approve',
    guarded(
      (id: unknown) =>
        validId(id) ? deps.elevation.approve(id) : Promise.resolve<ServerActionResult>(INVALID),
      Promise.resolve(NOT_A_WINDOW),
    ),
  )
}
