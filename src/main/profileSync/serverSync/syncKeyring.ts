import type { ServerAccount } from '../../server/serverAccount'
import { ServerError } from '../../server/serverClient'
import { hostOf } from '../../server/serverUrl'
import type { Argon2Cost } from '../argon2'
import { newRecoveryKey, normalizeRecoveryKey } from '../secretCrypto'
import { openManifest, PRODUCTION_ARGON, unwrapWithSecret, wrapWithSecret } from './syncCrypto'
import type { SyncKeyStore } from './syncKeyStore'

const PASSPHRASE_MIN = 12
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

export type UnlockResult = { ok: true } | { ok: false; error: KeyringError }

export type ServedKey = 'none' | 'set' | 'unsupported'

export interface SyncTarget {
  id: string
  host: string
  accountId: string
}

export interface SealedWraps {
  primary: string
  backup: string
  backupSecret: string
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

  async served(): Promise<ServedKey> {
    try {
      await this.account.authed((token, routes) => routes.manifest(token))
      return 'set'
    } catch (error) {
      if (!(error instanceof ServerError) || error.status !== 404) throw error
      return error.code === 'no-manifest' ? 'none' : 'unsupported'
    }
  }

  async wraps(key: Buffer, secret: string): Promise<SealedWraps> {
    const backupSecret = newRecoveryKey()
    const [primary, backup] = await Promise.all([
      wrapWithSecret(key, secret, this.cost),
      wrapWithSecret(key, normalizeRecoveryKey(backupSecret), this.cost),
    ])
    return {
      primary: primary.toString('base64url'),
      backup: backup.toString('base64url'),
      backupSecret,
    }
  }

  async openWrap(slot: 'passphrase' | 'recovery', secret: string): Promise<Buffer | null> {
    const wrap = await this.account.authed((token, routes) =>
      this.account
        .signer()
        .signed('wrapRead', (headers) => routes.secretWrap(token, slot, headers), [slot]),
    )
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

  async opened(
    slot: 'passphrase' | 'recovery',
    secret: string,
    wrong: KeyringError,
  ): Promise<{ ok: true; key: Buffer } | { ok: false; error: KeyringError }> {
    if (!this.account.signedIn()) return { ok: false, error: 'not-signed-in' }
    try {
      const key = await this.openWrap(slot, secret).catch((error: unknown) => {
        if (error instanceof ServerError && error.status === 404) return undefined
        throw error
      })
      if (key === undefined) return { ok: false, error: 'no-wrap' }
      if (!key) return { ok: false, error: wrong }
      if (!(await this.opensServedManifest(key))) return { ok: false, error: 'key-differs' }
      return { ok: true, key }
    } catch (error) {
      return { ok: false, error: keyringErrorOf(error) }
    }
  }

  async unlock(passphrase: string): Promise<UnlockResult> {
    const res = await this.opened('passphrase', passphrase, 'wrong-password')
    if (!res.ok) return res
    return this.keep(res.key) ? { ok: true } : { ok: false, error: 'unavailable' }
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
