import type {
  ServerSyncResult,
  ServerSyncState,
  ServerSyncStatus,
} from '../../../shared/profileSync/serverSync'
import type { ServerAccount } from '../../server/serverAccount'
import { ServerError } from '../../server/serverClient'
import type { SyncKeyring } from './syncKeyring'
import { changePassphrase, type Rekey } from './syncPassphrase'

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

function stateOf(error: unknown): ServerSyncState {
  if (error instanceof ServerError && error.status === 404) return 'unsupported'
  return 'unreachable'
}

export class ServerSyncService {
  constructor(private readonly deps: ServiceDeps) {
    deps.account.beforeSignOut(() => deps.keyring.forget())
  }

  async status(): Promise<ServerSyncStatus> {
    const { account, keyring } = this.deps
    const target = keyring.target()
    if (!account.signedIn() || !target) return SIGNED_OUT
    const host = target.host
    if (keyring.key()) return { state: 'ready', host }
    try {
      const slots = await keyring.slots()
      return { state: slots.has('passphrase') ? 'locked' : 'needs-setup', host }
    } catch (error) {
      return { state: stateOf(error), host }
    }
  }

  private async done(result: Omit<ServerSyncResult, 'status'>): Promise<ServerSyncResult> {
    return { ...result, status: await this.status() }
  }

  async setup(passphrase: string, confirm: string): Promise<ServerSyncResult> {
    return this.done(await this.deps.keyring.setup(passphrase, confirm))
  }

  async unlock(passphrase: string): Promise<ServerSyncResult> {
    return this.done(await this.deps.keyring.unlock(passphrase))
  }

  async recover(
    recoveryKey: string,
    passphrase: string,
    confirm: string,
  ): Promise<ServerSyncResult> {
    return this.done(await this.deps.keyring.recover(recoveryKey, passphrase, confirm))
  }

  async changePassphrase(
    current: string,
    next: string,
    confirm: string,
  ): Promise<ServerSyncResult> {
    const { account, keyring, rekey } = this.deps
    return this.done(await changePassphrase({ account, keyring }, current, next, confirm, rekey))
  }
}
