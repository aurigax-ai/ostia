import type { ServerSyncResult, ServerSyncStatus } from '../../../shared/profileSync/serverSync'
import type { ServerAccount } from '../../server/serverAccount'
import type { SyncKeyring } from './syncKeyring'
import { changePassphrase, type Rekey, recoverWithKey, setupKey } from './syncPassphrase'

type ServiceAccount = Pick<
  ServerAccount,
  'signedIn' | 'identity' | 'baseUrl' | 'authed' | 'signer' | 'beforeSignOut'
>

export interface ServiceDeps {
  account: ServiceAccount
  keyring: SyncKeyring
  rekey: Rekey
}

const SIGNED_OUT: ServerSyncStatus = { state: 'signed-out', host: null }

export class ServerSyncService {
  constructor(private readonly deps: ServiceDeps) {
    deps.account.beforeSignOut(() => deps.keyring.forget())
  }

  private get ctx() {
    return { account: this.deps.account, keyring: this.deps.keyring }
  }

  async status(): Promise<ServerSyncStatus> {
    const { account, keyring } = this.deps
    const target = keyring.target()
    if (!account.signedIn() || !target) return SIGNED_OUT
    const host = target.host
    if (keyring.key()) return { state: 'ready', host }
    try {
      const served = await keyring.served()
      if (served === 'unsupported') return { state: 'unsupported', host }
      return { state: served === 'set' ? 'locked' : 'needs-setup', host }
    } catch {
      return { state: 'unreachable', host }
    }
  }

  private async done(result: Omit<ServerSyncResult, 'status'>): Promise<ServerSyncResult> {
    return { ...result, status: await this.status() }
  }

  async setup(passphrase: string, confirm: string): Promise<ServerSyncResult> {
    return this.done(await setupKey(this.ctx, passphrase, confirm))
  }

  async unlock(passphrase: string): Promise<ServerSyncResult> {
    return this.done(await this.deps.keyring.unlock(passphrase))
  }

  async recover(
    recoveryKey: string,
    passphrase: string,
    confirm: string,
  ): Promise<ServerSyncResult> {
    const { rekey } = this.deps
    return this.done(await recoverWithKey(this.ctx, recoveryKey, passphrase, confirm, rekey))
  }

  async changePassphrase(
    current: string,
    next: string,
    confirm: string,
  ): Promise<ServerSyncResult> {
    const { rekey } = this.deps
    return this.done(await changePassphrase(this.ctx, current, next, confirm, rekey))
  }
}
