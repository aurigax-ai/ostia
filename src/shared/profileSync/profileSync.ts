export interface SyncConflict {
  id: string
  kind: 'setting' | 'file' | 'secret'
  key: string
  local: string | null
  remote: string | null
  winner: 'local' | 'remote'
  localAt?: number
  remoteAt?: number
}

export interface SyncOffer {
  id: string
  marketplace: string
}

export interface SyncStatus {
  dir: string | null
  state: 'off' | 'ok' | 'error'
  error?: string
  lastSync: string | null
  conflicts: SyncConflict[]
  skipped: string[]
  heldBack: string[]
  offers: SyncOffer[]
  secrets: SecretSyncStatus
}

export interface SecretSyncStatus {
  state: 'off' | 'needs-setup' | 'locked' | 'unlocked' | 'damaged'
  logins: boolean
}

export interface SecretActionResult {
  ok: boolean
  error?: string
  recoveryKey?: string
  status: SyncStatus
}

export type SecretReveal =
  | { ok: true; local: string | null; remote: string | null; winner: 'local' | 'remote' }
  | { ok: false }

interface SecretSyncApi {
  reveal: (conflictId: string) => Promise<SecretReveal>
  enable: () => Promise<SecretActionResult>
  disable: () => Promise<SecretActionResult>
  remove: () => Promise<SecretActionResult>
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
  resolve: (conflictId: string) => Promise<SyncStatus>
  install: (extId: string) => Promise<SyncStatus>
  secrets: SecretSyncApi
  pickFolder: () => Promise<string | null>
  onStatus: (cb: (status: SyncStatus) => void) => () => void
}

export interface ProfileSyncBridge {
  sync: SyncApi
}
