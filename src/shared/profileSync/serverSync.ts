export type ServerSyncState =
  | 'signed-out'
  | 'unsupported'
  | 'unreachable'
  | 'untrusted'
  | 'needs-setup'
  | 'locked'
  | 'ready'

export interface ServerLinkCode {
  deviceName: string
  code: string
}

export interface ServerJoinRequest {
  deviceId: string
  name: string
  code: string
  createdAt: number
}

export interface ServerSyncStatus {
  state: ServerSyncState
  host: string | null
  linking: boolean
  linkApproved: boolean
  linkCodes: ServerLinkCode[]
  joins: ServerJoinRequest[]
  recoveryStale: boolean
}

export type ServerSyncError =
  | 'too-short'
  | 'mismatch'
  | 'wrong-password'
  | 'wrong-recovery-key'
  | 'exists'
  | 'no-wrap'
  | 'unavailable'
  | 'elevation-required'
  | 'not-signed-in'
  | 'not-a-window'
  | 'invalid-input'
  | 'locked'
  | 'unreachable'
  | 'rotation-failed'
  | 'untrusted'
  | 'device-too-new'
  | 'requester-too-new'
  | 'no-second-device'
  | 'failed'

export interface ServerSyncResult {
  ok: boolean
  error?: ServerSyncError
  recoveryKey?: string
  deleted?: number
  removed?: boolean
  rotated?: boolean
  unwrapped?: string[]
  status: ServerSyncStatus
}

interface ServerSyncApi {
  status: () => Promise<ServerSyncStatus>
  setup: (passphrase: string, confirm: string) => Promise<ServerSyncResult>
  unlock: (passphrase: string) => Promise<ServerSyncResult>
  recover: (recoveryKey: string) => Promise<ServerSyncResult>
  linkStart: () => Promise<ServerSyncResult>
  linkStop: () => Promise<ServerSyncResult>
  linkConfirm: () => Promise<ServerSyncResult>
  approveJoin: (deviceId: string) => Promise<ServerSyncResult>
  removeDevice: (
    deviceId: string,
    passphrase: string,
    recoveryKey: string,
  ) => Promise<ServerSyncResult>
  rotate: (passphrase: string, recoveryKey: string) => Promise<ServerSyncResult>
  newRecoveryKey: () => Promise<ServerSyncResult>
  collectGarbage: () => Promise<ServerSyncResult>
  onStatus: (cb: (status: ServerSyncStatus) => void) => () => void
}

export interface ServerSyncBridge {
  syncServer: ServerSyncApi
}
