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
import {
  joinRequestsFor,
  linkCodesFor,
  localPublicKeys,
  serverAgreesWith,
  wrapFor,
} from './syncLink'
import { registerInManifest } from './syncRegister'
import { collectGarbage, rotateKey, verifySecrets } from './syncRotate'

type ServiceAccount = Pick<
  ServerAccount,
  'signedIn' | 'identity' | 'baseUrl' | 'authed' | 'deviceKeys' | 'beforeSignOut'
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
  linkApproved: false,
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

class UntrustedServer extends Error {}

export class ServerSyncService {
  private linking = false

  constructor(private readonly deps: ServiceDeps) {
    deps.account.beforeSignOut(() => {
      this.linking = false
      deps.keyring.forget()
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
    const keys = account.deviceKeys()
    if (!keys) return SIGNED_OUT
    const me = localPublicKeys(keys)
    try {
      const [slots, rows] = await Promise.all([
        keyring.slots(),
        account.authed((token, routes) => routes.devices(token)),
      ])
      const devices = rows.devices
      if (!serverAgreesWith(devices, me)) return { ...base, state: 'untrusted' }
      if (keyring.key()) {
        return {
          ...base,
          state: 'ready',
          joins: joinRequestsFor(devices, slots, me),
          recoveryStale: slots.has('passphrase') && !slots.has('recovery'),
        }
      }
      if (!slots.has('passphrase')) return { ...base, state: 'needs-setup' }
      const selfId = account.identity()?.deviceId ?? ''
      return {
        ...base,
        state: 'locked',
        linking: this.linking,
        linkApproved: this.linking && slots.has(`device:${selfId}`),
        linkCodes: linkCodesFor(devices, slots, me),
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

  private async joined(): Promise<void> {
    this.linking = false
    const identity = this.deps.account.identity()
    await registerInManifest(
      this.ctx,
      identity ? { id: identity.deviceId, name: identity.deviceName } : null,
    )
  }

  async unlock(passphrase: string): Promise<ServerSyncResult> {
    const res = await this.deps.keyring.unlock(passphrase)
    if (res.ok) await this.joined()
    return this.done(res)
  }

  async recover(recoveryKey: string): Promise<ServerSyncResult> {
    const res = await this.deps.keyring.recover(recoveryKey)
    if (res.ok) await this.joined()
    return this.done(res)
  }

  linkStart(): Promise<ServerSyncResult> {
    this.linking = true
    return this.done({ ok: true })
  }

  async linkConfirm(): Promise<ServerSyncResult> {
    if (!this.linking) return this.done({ ok: false, error: 'locked' })
    if (!(await this.deps.keyring.adoptOwnDeviceWrap()))
      return this.done({ ok: false, error: 'no-wrap' })
    await this.joined()
    return this.done({ ok: true })
  }

  linkStop(): Promise<ServerSyncResult> {
    this.linking = false
    return this.done({ ok: true })
  }

  async approveJoin(deviceId: string): Promise<ServerSyncResult> {
    const key = this.deps.keyring.key()
    const keys = this.deps.account.deviceKeys()
    if (!key || !keys) return this.done({ ok: false, error: 'locked' })
    try {
      await this.deps.account.authed(async (token, routes) => {
        const { devices } = await routes.devices(token)
        if (!serverAgreesWith(devices, localPublicKeys(keys))) throw new UntrustedServer()
        const row = devices.find((d) => d.id === deviceId && d.current !== true)
        if (!row) throw new ServerError(404, 'unknown-device')
        await routes.putWrap(token, `device:${row.id}`, wrapFor(row, key))
      })
      this.deps.keyring.approve(deviceId)
      return this.done({ ok: true })
    } catch (error) {
      return this.done({ ok: false, error: this.errorOf(error) })
    }
  }

  private errorOf(error: unknown): ServerSyncError {
    if (error instanceof UntrustedServer) return 'untrusted'
    return syncErrorOf(failureOf(error))
  }

  async rotate(passphrase: string, recoveryKey: string): Promise<ServerSyncResult> {
    const res = await rotateKey(this.ctx, passphrase, recoveryKey)
    return this.done(
      res.ok
        ? { ok: true, rotated: true, unwrapped: res.unwrapped }
        : { ok: false, error: res.error },
    )
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
        ? { ok: true, removed: true, rotated: true, unwrapped: res.unwrapped }
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
