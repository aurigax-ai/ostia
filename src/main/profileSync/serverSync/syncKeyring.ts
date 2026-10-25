import type { ServerAccount } from '../../server/serverAccount'
import { ServerError } from '../../server/serverClient'
import { hostOf } from '../../server/serverUrl'
import type { Argon2Cost } from '../argon2'
import { newRecoveryKey, normalizeRecoveryKey } from '../secretCrypto'
import {
  newProfileKey,
  openManifest,
  PRODUCTION_ARGON,
  unwrapWithSecret,
  wrapWithSecret,
} from './syncCrypto'
import type { SyncKeyStore } from './syncKeyStore'

const PASSPHRASE_MIN = 12
const PASSPHRASE_SLOT = 'passphrase'
const RECOVERY_SLOT = 'recovery'
const GC_INTERVAL_MS = 24 * 60 * 60 * 1000

export type KeyringAccount = Pick<
  ServerAccount,
  'signedIn' | 'identity' | 'baseUrl' | 'authed' | 'signer'
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

export interface SecretWraps {
  key: Buffer
  passphrase: string
  recovery: string
  recoveryKey: string
}

const fromB64 = (text: string): Buffer => Buffer.from(text, 'base64url')

export function keyringErrorOf(error: unknown): KeyringError {
  if (!(error instanceof ServerError)) return 'failed'
  if (error.code === 'not-signed-in') return 'not-signed-in'
  return error.status === 0 ? 'unreachable' : 'failed'
}

export function passphraseProblem(passphrase: string, confirm: string): KeyringError | null {
  if (passphrase.length < PASSPHRASE_MIN) return 'too-short'
  return passphrase === confirm ? null : 'mismatch'
}

export class SyncKeyring {
  constructor(
    private readonly account: KeyringAccount,
    private readonly store: SyncKeyStore,
    readonly cost: Argon2Cost = PRODUCTION_ARGON,
    readonly now: () => number = Date.now,
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

  async wraps(key: Buffer, passphrase: string): Promise<SecretWraps> {
    const recoveryKey = newRecoveryKey()
    const [forPassphrase, forRecovery] = await Promise.all([
      wrapWithSecret(key, passphrase, this.cost),
      wrapWithSecret(key, normalizeRecoveryKey(recoveryKey), this.cost),
    ])
    return {
      key,
      passphrase: forPassphrase.toString('base64url'),
      recovery: forRecovery.toString('base64url'),
      recoveryKey,
    }
  }

  async setup(passphrase: string, confirm: string): Promise<SetupResult> {
    if (!this.account.signedIn()) return { ok: false, error: 'not-signed-in' }
    const problem = passphraseProblem(passphrase, confirm)
    if (problem) return { ok: false, error: problem }
    try {
      if ((await this.slots()).has(PASSPHRASE_SLOT)) return { ok: false, error: 'exists' }
      const made = await this.wraps(newProfileKey(), passphrase)
      await this.account.authed(async (token, routes) => {
        await routes.putWrap(token, PASSPHRASE_SLOT, made.passphrase)
        await routes.putWrap(token, RECOVERY_SLOT, made.recovery)
      })
      if (!this.keep(made.key)) return { ok: false, error: 'unavailable' }
      return { ok: true, recoveryKey: made.recoveryKey }
    } catch (error) {
      return { ok: false, error: keyringErrorOf(error) }
    }
  }

  private secretWrap(slot: 'passphrase' | 'recovery') {
    return this.account.authed((token, routes) =>
      this.account
        .signer()
        .signed('wrapRead', (headers) => routes.secretWrap(token, slot, headers), [slot]),
    )
  }

  async openWrap(slot: 'passphrase' | 'recovery', secret: string): Promise<Buffer | null> {
    const wrap = await this.secretWrap(slot)
    return unwrapWithSecret(fromB64(wrap.blob), secret)
  }

  private async opensServedManifest(key: Buffer): Promise<boolean> {
    try {
      const view = await this.account.authed((token, routes) => routes.manifest(token))
      return openManifest(key, fromB64(view.blob)) !== null
    } catch (error) {
      if (error instanceof ServerError && error.status === 404) return true
      throw error
    }
  }

  private async openWith(
    slot: 'passphrase' | 'recovery',
    secret: string,
    wrong: KeyringError,
    newPassphrase: string | null,
  ): Promise<UnlockResult> {
    if (!this.account.signedIn()) return { ok: false, error: 'not-signed-in' }
    try {
      const key = await this.openWrap(slot, secret).catch((error: unknown) => {
        if (error instanceof ServerError && error.status === 404) return undefined
        throw error
      })
      if (key === undefined) return { ok: false, error: 'no-wrap' }
      if (!key) return { ok: false, error: wrong }
      if (!(await this.opensServedManifest(key))) return { ok: false, error: 'key-differs' }
      if (newPassphrase !== null) {
        const wrap = await wrapWithSecret(key, newPassphrase, this.cost)
        await this.account.authed((token, routes) =>
          routes.putWrap(token, PASSPHRASE_SLOT, wrap.toString('base64url')),
        )
      }
      if (!this.keep(key)) return { ok: false, error: 'unavailable' }
      return { ok: true }
    } catch (error) {
      return { ok: false, error: keyringErrorOf(error) }
    }
  }

  unlock(passphrase: string): Promise<UnlockResult> {
    return this.openWith(PASSPHRASE_SLOT, passphrase, 'wrong-password', null)
  }

  recover(recoveryKey: string, passphrase: string, confirm: string): Promise<UnlockResult> {
    const problem = passphraseProblem(passphrase, confirm)
    if (problem) return Promise.resolve({ ok: false, error: problem })
    return this.openWith(
      RECOVERY_SLOT,
      normalizeRecoveryKey(recoveryKey),
      'wrong-recovery-key',
      passphrase,
    )
  }

  gcDue(): boolean {
    const target = this.target()
    return target !== null && this.now() - this.store.lastGc(target.id) >= GC_INTERVAL_MS
  }

  gcDone(): void {
    const target = this.target()
    if (target) this.store.setLastGc(target.id, this.now())
  }
}
