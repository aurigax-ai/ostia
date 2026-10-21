import { publicBytes } from '../../server/deviceKeys'
import type { ServerAccount } from '../../server/serverAccount'
import { ServerError } from '../../server/serverClient'
import { hostOf } from '../../server/serverUrl'
import type { Argon2Cost } from '../argon2'
import { newRecoveryKey, normalizeRecoveryKey } from '../secretCrypto'
import {
  newProfileKey,
  PRODUCTION_ARGON,
  unwrapForDevice,
  unwrapWithSecret,
  wrapForDevice,
  wrapWithSecret,
} from './syncCrypto'
import type { SyncKeyStore } from './syncKeyStore'

const PASSPHRASE_MIN = 12
const PASSPHRASE_SLOT = 'passphrase'
const RECOVERY_SLOT = 'recovery'

export type KeyringAccount = Pick<
  ServerAccount,
  'signedIn' | 'identity' | 'baseUrl' | 'authed' | 'deviceKeys'
>

export type KeyringError =
  | 'too-short'
  | 'mismatch'
  | 'wrong-password'
  | 'wrong-recovery-key'
  | 'exists'
  | 'no-wrap'
  | 'unavailable'
  | 'elevation-required'
  | 'not-signed-in'
  | 'unreachable'
  | 'failed'

export type SetupResult = { ok: true; recoveryKey: string } | { ok: false; error: KeyringError }
export type UnlockResult = { ok: true } | { ok: false; error: KeyringError }

export interface SyncTarget {
  id: string
  host: string
  accountId: string
}

export const deviceSlot = (deviceId: string): string => `device:${deviceId}`

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
  ) {}

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
    return target !== null && this.store.setKey(target.id, key)
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

  private async writeOwnDeviceWrap(key: Buffer): Promise<void> {
    const identity = this.account.identity()
    const keys = this.account.deviceKeys()
    if (!identity || !keys) return
    const blob = wrapForDevice(key, publicBytes(keys.boxPrivate)).toString('base64url')
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

  private async openWith(slot: string, secret: string, wrong: KeyringError): Promise<UnlockResult> {
    if (!this.account.signedIn()) return { ok: false, error: 'not-signed-in' }
    try {
      const wrap = await this.account
        .authed((token, routes) => routes.wrap(token, slot))
        .catch((error: unknown) => {
          if (error instanceof ServerError && error.status === 404) return null
          throw error
        })
      if (!wrap) return { ok: false, error: 'no-wrap' }
      const key = await unwrapWithSecret(fromB64(wrap.blob), secret)
      if (!key) return { ok: false, error: wrong }
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

  async adoptOwnDeviceWrap(): Promise<boolean> {
    const identity = this.account.identity()
    const keys = this.account.deviceKeys()
    if (!identity || !keys) return false
    try {
      const wrap = await this.account.authed((token, routes) =>
        routes.wrap(token, deviceSlot(identity.deviceId)),
      )
      const key = unwrapForDevice(fromB64(wrap.blob), keys.boxPrivate)
      return key !== null && this.keep(key)
    } catch {
      return false
    }
  }

  async verifySecret(
    slot: 'passphrase' | 'recovery',
    secret: string,
    key: Buffer,
  ): Promise<boolean> {
    try {
      const wrap = await this.account.authed((token, routes) => routes.wrap(token, slot))
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
