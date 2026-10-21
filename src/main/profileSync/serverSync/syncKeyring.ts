import type { ChangedDevice, WrapRefusal } from '../../../shared/profileSync/serverSync'
import { publicBytes } from '../../server/deviceKeys'
import type { ServerAccount } from '../../server/serverAccount'
import { ServerError } from '../../server/serverClient'
import { hostOf } from '../../server/serverUrl'
import type { Argon2Cost } from '../argon2'
import { newRecoveryKey, normalizeRecoveryKey } from '../secretCrypto'
import {
  type Manifest,
  type ManifestDevice,
  newProfileKey,
  openDeviceWrap,
  openManifest,
  PRODUCTION_ARGON,
  parseDeviceWrap,
  unwrapWithSecret,
  wrapForDevice,
  wrapSignedBy,
  wrapWithSecret,
} from './syncCrypto'
import type { SyncKeyStore } from './syncKeyStore'

const PASSPHRASE_MIN = 12
const PASSPHRASE_SLOT = 'passphrase'
const RECOVERY_SLOT = 'recovery'
const MIN_APPROVER_AGE_MS = 24 * 60 * 60 * 1000

export type KeyringAccount = Pick<
  ServerAccount,
  'signedIn' | 'identity' | 'baseUrl' | 'authed' | 'deviceKeys' | 'signer'
>

export type KeyringError =
  | 'too-short'
  | 'mismatch'
  | 'wrong-password'
  | 'wrong-recovery-key'
  | 'exists'
  | 'no-wrap'
  | 'key-differs'
  | 'unavailable'
  | 'elevation-required'
  | 'not-signed-in'
  | 'unreachable'
  | 'failed'

export type LinkAdoption = 'adopted' | 'stale' | 'refused'

export type SetupResult = { ok: true; recoveryKey: string } | { ok: false; error: KeyringError }
export type UnlockResult = { ok: true } | { ok: false; error: KeyringError }

export interface SyncTarget {
  id: string
  host: string
  accountId: string
}

export const deviceSlot = (deviceId: string): `device:${string}` => `device:${deviceId}`

const fromB64 = (text: string): Buffer => Buffer.from(text, 'base64url')

function errorOf(error: unknown): KeyringError {
  if (!(error instanceof ServerError)) return 'failed'
  if (error.code === 'not-signed-in') return 'not-signed-in'
  if (error.code === 'elevation-required') return 'elevation-required'
  return error.status === 0 ? 'unreachable' : 'failed'
}

export class SyncKeyring {
  constructor(
    private readonly account: KeyringAccount,
    private readonly store: SyncKeyStore,
    readonly cost: Argon2Cost = PRODUCTION_ARGON,
    readonly now: () => number = Date.now,
  ) {}

  wrapRefused: WrapRefusal | null = null
  private held: Buffer | null = null

  clearRefusal(): void {
    this.wrapRefused = null
    this.held = null
  }

  target(): SyncTarget | null {
    const identity = this.account.identity()
    const url = this.account.baseUrl()
    if (!identity || !url) return null
    const host = hostOf(url)
    return { id: `${host}:${identity.accountId}`, host, accountId: identity.accountId }
  }

  key(): Buffer | null {
    const target = this.target()
    return target ? this.store.key(target.id) : null
  }

  highest(): number {
    const target = this.target()
    return target ? this.store.highest(target.id) : 0
  }

  raise(counter: number): void {
    const target = this.target()
    if (target) this.store.raise(target.id, counter)
  }

  keep(key: Buffer): boolean {
    const target = this.target()
    if (target === null || !this.store.setKey(target.id, key)) return false
    this.clearRefusal()
    return true
  }

  forget(): void {
    const target = this.target()
    if (target) this.store.forgetKey(target.id)
  }

  slots(): Promise<Set<string>> {
    return this.account.authed(async (token, routes) => {
      const { wraps } = await routes.wraps(token)
      return new Set(wraps.map((w) => w.slot))
    })
  }

  wrapFor(boxPub: string, deviceId: string, key: Buffer, counter: number): string | null {
    const keys = this.account.deviceKeys()
    const identity = this.account.identity()
    if (!keys || !identity) return null
    return wrapForDevice(
      key,
      fromB64(boxPub),
      deviceSlot(deviceId),
      { id: identity.deviceId, signPrivate: keys.signPrivate },
      counter,
    ).toString('base64url')
  }

  private async writeOwnDeviceWrap(key: Buffer): Promise<void> {
    const identity = this.account.identity()
    const keys = this.account.deviceKeys()
    if (!identity || !keys) return
    const blob = this.wrapFor(
      publicBytes(keys.boxPrivate).toString('base64url'),
      identity.deviceId,
      key,
      this.highest(),
    )
    if (!blob) return
    await this.account.authed((token, routes) =>
      routes.putWrap(token, deviceSlot(identity.deviceId), blob),
    )
  }

  async setup(passphrase: string, confirm: string): Promise<SetupResult> {
    if (!this.account.signedIn()) return { ok: false, error: 'not-signed-in' }
    if (passphrase.length < PASSPHRASE_MIN) return { ok: false, error: 'too-short' }
    if (passphrase !== confirm) return { ok: false, error: 'mismatch' }
    try {
      if ((await this.slots()).has(PASSPHRASE_SLOT)) return { ok: false, error: 'exists' }
      const key = newProfileKey()
      const recoveryKey = newRecoveryKey()
      const passphraseWrap = await wrapWithSecret(key, passphrase, this.cost)
      const recoveryWrap = await wrapWithSecret(key, normalizeRecoveryKey(recoveryKey), this.cost)
      await this.account.authed(async (token, routes) => {
        await routes.putWrap(token, PASSPHRASE_SLOT, passphraseWrap.toString('base64url'))
        await routes.putWrap(token, RECOVERY_SLOT, recoveryWrap.toString('base64url'))
      })
      if (!this.keep(key)) return { ok: false, error: 'unavailable' }
      await this.writeOwnDeviceWrap(key)
      return { ok: true, recoveryKey }
    } catch (error) {
      return { ok: false, error: errorOf(error) }
    }
  }

  private secretWrap(slot: 'passphrase' | 'recovery') {
    return this.account.authed((token, routes) =>
      this.account
        .signer()
        .signed('wrapRead', (headers) => routes.secretWrap(token, slot, headers), [slot]),
    )
  }

  private async openWith(
    slot: 'passphrase' | 'recovery',
    secret: string,
    wrong: KeyringError,
  ): Promise<UnlockResult> {
    if (!this.account.signedIn()) return { ok: false, error: 'not-signed-in' }
    try {
      const wrap = await this.secretWrap(slot).catch((error: unknown) => {
        if (error instanceof ServerError && error.status === 404) return null
        throw error
      })
      if (!wrap) return { ok: false, error: 'no-wrap' }
      const key = await unwrapWithSecret(fromB64(wrap.blob), secret)
      if (!key) return { ok: false, error: wrong }
      if (this.key() !== null && !(this.held && key.equals(this.held))) {
        return { ok: false, error: 'key-differs' }
      }
      if (!this.keep(key)) return { ok: false, error: 'unavailable' }
      if (!(await this.slots()).has(deviceSlot(this.account.identity()?.deviceId ?? ''))) {
        await this.writeOwnDeviceWrap(key)
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, error: errorOf(error) }
    }
  }

  unlock(passphrase: string): Promise<UnlockResult> {
    return this.openWith(PASSPHRASE_SLOT, passphrase, 'wrong-password')
  }

  recover(recoveryKey: string): Promise<UnlockResult> {
    return this.openWith(RECOVERY_SLOT, normalizeRecoveryKey(recoveryKey), 'wrong-recovery-key')
  }

  private async ownWrap(): Promise<{ slot: string; wrap: Buffer } | null> {
    const identity = this.account.identity()
    if (!identity) return null
    const slot = deviceSlot(identity.deviceId)
    try {
      const found = await this.account.authed((token, routes) => routes.deviceWrap(token, slot))
      return { slot, wrap: fromB64(found.blob) }
    } catch {
      return null
    }
  }

  async adoptLinkWrap(approver: { id: string; signPub: string }): Promise<LinkAdoption> {
    const keys = this.account.deviceKeys()
    const own = await this.ownWrap()
    if (!keys || !own) return 'refused'
    const parsed = parseDeviceWrap(own.wrap)
    if (
      !parsed ||
      parsed.signerId !== approver.id ||
      parsed.counter < 1 ||
      !wrapSignedBy(parsed, own.slot, approver.signPub)
    ) {
      return 'refused'
    }
    const key = openDeviceWrap(parsed, own.slot, keys.boxPrivate)
    if (!key) return 'refused'
    try {
      const view = await this.account.authed((token, routes) => routes.manifest(token))
      const manifest = openManifest(key, fromB64(view.blob))
      if (!manifest) return 'refused'
      if (parsed.counter < manifest.counter) return 'stale'
      if (!this.keep(key)) return 'refused'
      this.raise(manifest.counter)
      this.pin(manifest.devices)
      return 'adopted'
    } catch {
      return 'refused'
    }
  }

  private async approverReadyAt(
    signer: ManifestDevice,
  ): Promise<number | 'untrusted' | 'unverified'> {
    const target = this.target()
    if (!target) return 'untrusted'
    const seenAt = this.store.firstSeen(target.id, signer)
    if (seenAt === null) return 'untrusted'
    try {
      const [info, listing] = await this.account.authed(async (token, routes) =>
        Promise.all([routes.info(), routes.devices(token)]),
      )
      const listed = listing.devices.find((d) => d.id === signer.id)
      if (!listed) return 'unverified'
      const row = listed.signPub === signer.signPub ? listed : null
      if (!row) return 'untrusted'
      const served = info.approverMinAgeSeconds
      const seconds = typeof served === 'number' && Number.isFinite(served) ? served : 0
      const since = Math.max(signer.createdAt, seenAt, row.createdAt)
      return since + Math.max(MIN_APPROVER_AGE_MS, seconds * 1000)
    } catch {
      return 'unverified'
    }
  }

  async adoptRotation(sealed: Buffer): Promise<{ key: Buffer; manifest: Manifest } | null> {
    const keys = this.account.deviceKeys()
    const own = await this.ownWrap()
    if (!keys || !own) return null
    const refuse = (
      reason: WrapRefusal['reason'],
      after: number | null = null,
      held: Buffer | null = null,
    ): null => {
      this.wrapRefused = { reason, after }
      this.held = held
      return null
    }
    const parsed = parseDeviceWrap(own.wrap)
    const signer = parsed ? this.trusted().find((d) => d.id === parsed.signerId) : undefined
    if (
      !parsed ||
      !signer ||
      !wrapSignedBy(parsed, own.slot, signer.signPub) ||
      parsed.counter <= this.highest()
    ) {
      return refuse('untrusted')
    }
    const readyAt = await this.approverReadyAt(signer)
    if (typeof readyAt === 'string') return refuse(readyAt)
    const key = openDeviceWrap(parsed, own.slot, keys.boxPrivate)
    const manifest = key ? openManifest(key, sealed) : null
    if (!key || !manifest || manifest.counter < parsed.counter) return refuse('untrusted')
    if (readyAt > this.now()) return refuse('too-new', readyAt, key)
    if (!this.keep(key)) return refuse('untrusted')
    return { key, manifest }
  }

  trusted(): ManifestDevice[] {
    const target = this.target()
    return target ? this.store.pinned(target.id) : []
  }

  changedDevices(): ChangedDevice[] {
    const target = this.target()
    if (!target) return []
    return this.store
      .changedSince(target.id, this.now() - MIN_APPROVER_AGE_MS)
      .map(({ id, name, at }) => ({ id, name, until: at + MIN_APPROVER_AGE_MS }))
  }

  pin(devices: ManifestDevice[]): void {
    const target = this.target()
    if (target) this.store.pin(target.id, devices, this.now())
  }

  async verifySecret(
    slot: 'passphrase' | 'recovery',
    secret: string,
    key: Buffer,
  ): Promise<boolean> {
    try {
      const wrap = await this.secretWrap(slot)
      const opened = await unwrapWithSecret(fromB64(wrap.blob), secret)
      return opened?.equals(key) === true
    } catch {
      return false
    }
  }

  async newRecovery(): Promise<
    { ok: true; recoveryKey: string } | { ok: false; error: KeyringError }
  > {
    const key = this.key()
    if (!key) return { ok: false, error: 'wrong-password' }
    try {
      const recoveryKey = newRecoveryKey()
      const wrap = await wrapWithSecret(key, normalizeRecoveryKey(recoveryKey), this.cost)
      await this.account.authed((token, routes) =>
        routes.putWrap(token, RECOVERY_SLOT, wrap.toString('base64url')),
      )
      return { ok: true, recoveryKey }
    } catch (error) {
      return { ok: false, error: errorOf(error) }
    }
  }
}
