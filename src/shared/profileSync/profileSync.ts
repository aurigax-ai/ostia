export interface SyncStatus {
  dir: string | null
  state: 'off' | 'ok' | 'error'
  error?: string
  lastSync: string | null
  skipped: string[]
  heldBack: string[]
  secrets: SecretSyncStatus
}

export interface SecretSyncStatus {
  state: 'off' | 'needs-setup' | 'locked' | 'unlocked' | 'damaged'
  mode: 'password' | 'sync-key'
  logins: boolean
}

export interface SecretActionResult {
  ok: boolean
  error?: string
  recoveryKey?: string
  status: SyncStatus
}

interface SecretSyncApi {
  enable: () => Promise<SecretActionResult>
  disable: () => Promise<SecretActionResult>
  useSyncKey: () => Promise<SecretActionResult>
  setLogins: (on: boolean) => Promise<SecretActionResult>
  setup: (password: string, confirm: string) => Promise<SecretActionResult>
  reset: (password: string, confirm: string) => Promise<SecretActionResult>
  unlock: (password: string) => Promise<SecretActionResult>
  changePassword: (password: string, confirm: string) => Promise<SecretActionResult>
  recover: (recoveryKey: string, password: string, confirm: string) => Promise<SecretActionResult>
}

interface SyncApi {
  status: () => Promise<SyncStatus>
  run: () => Promise<SyncStatus>
  secrets: SecretSyncApi
  pickFolder: () => Promise<string | null>
  onStatus: (cb: (status: SyncStatus) => void) => () => void
}

export interface ProfileSyncBridge {
  sync: SyncApi
}
