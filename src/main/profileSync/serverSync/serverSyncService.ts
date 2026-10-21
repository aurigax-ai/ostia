import type {
  ServerSyncError,
  ServerSyncResult,
  ServerSyncState,
  ServerSyncStatus,
} from '../../../shared/profileSync/serverSync'
import type { ServerFailure } from '../../../shared/server/serverApi'
import { failureOf, type ServerAccount } from '../../server/serverAccount'
import { ServerError } from '../../server/serverClient'
import type { ServerDevices } from '../../server/serverDevices'
import type { SyncKeyring } from './syncKeyring'
import { joinRequestsFor, linkCodesFor, wrapFor } from './syncLink'
import { collectGarbage, rotateKey, verifySecrets } from './syncRotate'

export type ServiceAccount = Pick<
  ServerAccount,
  'signedIn' | 'identity' | 'baseUrl' | 'authed' | 'deviceKeys' | 'onChange'
>

export interface ServiceDeps {
  account: ServiceAccount
  keyring: SyncKeyring
  devices: Pick<ServerDevices, 'revoke'>
}

const SIGNED_OUT: ServerSyncStatus = {
  state: 'signed-out',
  host: null,
  linking: false,
  linkCodes: [],
  joins: [],
  recoveryStale: false,
}

const PASSED_THROUGH: readonly ServerFailure[] = [
  'unreachable',
  'not-signed-in',
  'elevation-required',
  'device-too-new',
  'requester-too-new',
  'no-second-device',
]

function syncErrorOf(failure: ServerFailure): ServerSyncError {
  return PASSED_THROUGH.includes(failure) ? (failure as ServerSyncError) : 'failed'
}

function stateOf(error: unknown): ServerSyncState {
  if (error instanceof ServerError && error.status === 404) return 'unsupported'
  return 'unreachable'
}

export class ServerSyncService {
  private linking = false

  constructor(private readonly deps: ServiceDeps) {
    deps.account.onChange(() => {
      if (!deps.account.signedIn()) {
        this.linking = false
        deps.keyring.forget()
      }
    })
  }

  private get ctx() {
    return { account: this.deps.account, keyring: this.deps.keyring }
  }

  async status(): Promise<ServerSyncStatus> {
    const { account, keyring } = this.deps
    const target = keyring.target()
    if (!account.signedIn() || !target) return SIGNED_OUT
    const base = { ...SIGNED_OUT, host: target.host }
    try {
      const [slots, rows] = await Promise.all([
        keyring.slots(),
        account.authed((token, routes) => routes.devices(token)),
      ])
      const devices = rows.devices
      if (keyring.key()) {
        return {
          ...base,
          state: 'ready',
          joins: joinRequestsFor(devices, slots),
          recoveryStale: slots.has('passphrase') && !slots.has('recovery'),
        }
      }
      if (this.linking && (await keyring.adoptOwnDeviceWrap())) {
        this.linking = false
        return this.status()
      }
      if (!slots.has('passphrase')) return { ...base, state: 'needs-setup' }
      return {
        ...base,
        state: 'locked',
        linking: this.linking,
        linkCodes: linkCodesFor(devices, slots),
      }
    } catch (error) {
      return { ...base, state: stateOf(error) }
    }
  }

  private async done(
    result: { ok: boolean; error?: ServerSyncError } & Partial<ServerSyncResult>,
  ): Promise<ServerSyncResult> {
    return { ...result, status: await this.status() }
  }

  async setup(passphrase: string, confirm: string): Promise<ServerSyncResult> {
    const res = await this.deps.keyring.setup(passphrase, confirm)
    return this.done(res)
  }

  async unlock(passphrase: string): Promise<ServerSyncResult> {
    const res = await this.deps.keyring.unlock(passphrase)
    if (res.ok) this.linking = false
    return this.done(res)
  }

  async recover(recoveryKey: string): Promise<ServerSyncResult> {
    const res = await this.deps.keyring.recover(recoveryKey)
    if (res.ok) this.linking = false
    return this.done(res)
  }

  linkStart(): Promise<ServerSyncResult> {
    this.linking = true
    return this.done({ ok: true })
  }

  linkStop(): Promise<ServerSyncResult> {
    this.linking = false
    return this.done({ ok: true })
  }

  async approveJoin(deviceId: string): Promise<ServerSyncResult> {
    const key = this.deps.keyring.key()
    if (!key) return this.done({ ok: false, error: 'locked' })
    try {
      await this.deps.account.authed(async (token, routes) => {
        const { devices } = await routes.devices(token)
        const row = devices.find((d) => d.id === deviceId && d.current !== true)
        if (!row) throw new ServerError(404, 'unknown-device')
        await routes.putWrap(token, `device:${row.id}`, wrapFor(row, key))
      })
      return this.done({ ok: true })
    } catch (error) {
      return this.done({ ok: false, error: this.errorOf(error) })
    }
  }

  private errorOf(error: unknown): ServerSyncError {
    return syncErrorOf(failureOf(error))
  }

  async rotate(passphrase: string, recoveryKey: string): Promise<ServerSyncResult> {
    const res = await rotateKey(this.ctx, passphrase, recoveryKey)
    return this.done(res.ok ? { ok: true, rotated: true } : { ok: false, error: res.error })
  }

  async removeDevice(
    deviceId: string,
    passphrase: string,
    recoveryKey: string,
  ): Promise<ServerSyncResult> {
    const { keyring, devices } = this.deps
    const syncing = keyring.key() !== null
    if (syncing) {
      const refused = await verifySecrets(this.ctx, passphrase, recoveryKey)
      if (refused) return this.done({ ok: false, error: refused })
    }
    const revoked = await devices.revoke(deviceId)
    if (!revoked.ok) return this.done({ ok: false, error: syncErrorOf(revoked.error) })
    if (!syncing) return this.done({ ok: true, removed: true, rotated: false })
    const res = await rotateKey(this.ctx, passphrase, recoveryKey)
    return this.done(
      res.ok
        ? { ok: true, removed: true, rotated: true }
        : { ok: false, removed: true, error: 'rotation-failed' },
    )
  }

  async newRecoveryKey(): Promise<ServerSyncResult> {
    const res = await this.deps.keyring.newRecovery()
    return this.done(res)
  }

  async collectGarbage(): Promise<ServerSyncResult> {
    const res = await collectGarbage(this.ctx)
    return this.done(
      res.ok
        ? { ok: true, deleted: res.deleted }
        : { ok: false, error: res.error as ServerSyncError },
    )
  }
}
