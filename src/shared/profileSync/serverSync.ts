type ServerSyncState =
  | 'signed-out'
  | 'unsupported'
  | 'unreachable'
  | 'needs-setup'
  | 'locked'
  | 'ready'

export interface ServerSyncStatus {
  state: ServerSyncState
  host: string | null
}

export type ServerSyncError =
  | 'too-short'
  | 'mismatch'
  | 'wrong-password'
  | 'wrong-recovery-key'
  | 'exists'
  | 'no-wrap'
  | 'key-differs'
  | 'unavailable'
  | 'not-signed-in'
  | 'not-a-window'
  | 'invalid-input'
  | 'locked'
  | 'unreachable'
  | 'changed-elsewhere'
  | 'failed'

export interface ServerSyncResult {
  ok: boolean
  error?: ServerSyncError
  recoveryKey?: string
  status: ServerSyncStatus
}

interface ServerSyncApi {
  status: () => Promise<ServerSyncStatus>
  setup: (passphrase: string, confirm: string) => Promise<ServerSyncResult>
  unlock: (passphrase: string) => Promise<ServerSyncResult>
  recover: (recoveryKey: string, passphrase: string, confirm: string) => Promise<ServerSyncResult>
  changePassphrase: (current: string, next: string, confirm: string) => Promise<ServerSyncResult>
  onStatus: (cb: (status: ServerSyncStatus) => void) => () => void
}

export interface ServerSyncBridge {
  syncServer: ServerSyncApi
}
