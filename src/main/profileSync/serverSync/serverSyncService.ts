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
import type { ManifestDevice } from './syncCrypto'
import type { SyncKeyring } from './syncKeyring'
import {
  approverForCode,
  joinRequestsFor,
  linkCode,
  linkCodesFor,
  localPublicKeys,
  serverAgreesWith,
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
  wrapRefused: false,
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
    const base = { ...SIGNED_OUT, host: target.host, wrapRefused: keyring.wrapRefused }
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
    if (res.ok) await this.registerSelf()
    return this.done(res)
  }

  private async selfEntry(): Promise<ManifestDevice | null> {
    const keys = this.deps.account.deviceKeys()
    if (!keys) return null
    const me = localPublicKeys(keys)
    try {
      const { devices } = await this.deps.account.authed((token, routes) => routes.devices(token))
      const row = devices.find((d) => d.current === true)
      if (!row || !serverAgreesWith(devices, me)) return null
      return { id: row.id, name: row.name, ...me, createdAt: this.deps.keyring.now() }
    } catch {
      return null
    }
  }

  private async registerSelf(): Promise<void> {
    this.linking = false
    await registerInManifest(this.ctx, await this.selfEntry())
  }

  async unlock(passphrase: string): Promise<ServerSyncResult> {
    const res = await this.deps.keyring.unlock(passphrase)
    if (res.ok) await this.registerSelf()
    return this.done(res)
  }

  async recover(recoveryKey: string): Promise<ServerSyncResult> {
    const res = await this.deps.keyring.recover(recoveryKey)
    if (res.ok) await this.registerSelf()
    return this.done(res)
  }

  linkStart(): Promise<ServerSyncResult> {
    this.linking = true
    return this.done({ ok: true })
  }

  async linkConfirm(code: string): Promise<ServerSyncResult> {
    const keys = this.deps.account.deviceKeys()
    if (!this.linking || !keys) return this.done({ ok: false, error: 'locked' })
    try {
      const { devices } = await this.deps.account.authed((token, routes) => routes.devices(token))
      const me = localPublicKeys(keys)
      const approver = serverAgreesWith(devices, me)
        ? approverForCode(devices, me, code)
        : undefined
      if (!approver) return this.done({ ok: false, error: 'untrusted' })
      if (!(await this.deps.keyring.adoptLinkWrap(approver))) {
        return this.done({ ok: false, error: 'no-wrap' })
      }
      this.linking = false
      return this.done({ ok: true })
    } catch (error) {
      return this.done({ ok: false, error: this.errorOf(error) })
    }
  }

  linkStop(): Promise<ServerSyncResult> {
    this.linking = false
    return this.done({ ok: true })
  }

  async approveJoin(deviceId: string, code: string): Promise<ServerSyncResult> {
    const key = this.deps.keyring.key()
    const keys = this.deps.account.deviceKeys()
    if (!key || !keys) return this.done({ ok: false, error: 'locked' })
    try {
      const me = localPublicKeys(keys)
      const row = await this.deps.account.authed(async (token, routes) => {
        const { devices } = await routes.devices(token)
        if (!serverAgreesWith(devices, me)) throw new UntrustedServer()
        const found = devices.find((d) => d.id === deviceId && d.current !== true)
        if (!found) throw new ServerError(404, 'unknown-device')
        if (linkCode(found, me.signPub) !== code) throw new UntrustedServer()
        return found
      })
      const joiner: ManifestDevice = {
        id: row.id,
        name: row.name,
        signPub: row.signPub,
        boxPub: row.boxPub,
        createdAt: this.deps.keyring.now(),
      }
      const counter = await registerInManifest(this.ctx, joiner)
      if (counter === null) return this.done({ ok: false, error: 'failed' })
      const blob = this.deps.keyring.wrapFor(row.boxPub, row.id, key, counter)
      if (!blob) return this.done({ ok: false, error: 'failed' })
      await this.deps.account.authed((token, routes) =>
        routes.putWrap(token, `device:${row.id}`, blob),
      )
      this.deps.keyring.approve(joiner)
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
    if (revoked.ok) keyring.unapprove(deviceId)
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
