export type ShareMode = 'link' | 'password' | 'public'

export const SHARE_EXPIRIES_SECONDS = [86_400, 604_800, 2_592_000, 31_536_000] as const
export const SHARE_DEFAULT_EXPIRY_SECONDS = 2_592_000
export const SHARE_NEVER_EXPIRES = 0
export const SHARE_PASSWORD_MIN = 8
export const SHARE_PASSWORD_MAX = 256

export interface PublishOptions {
  mode: ShareMode
  password: string
  withLinkKey: boolean
  expiresInSeconds: number
  acceptFindings: boolean
}

export interface ShareFinding {
  kind: string
  line: number
  masked: string
}

export interface ShareView {
  id: string
  url: string
  mode: ShareMode
  size: number
  views: number
  expiresAt: number
  uploaded: boolean
  expired: boolean
  name: string | null
  source: string | null
  linkable: boolean
}

export type ShareAvailability =
  | { state: 'ready'; allowNever: boolean; allowPublic: boolean; maxBytes: number }
  | { state: 'signed-out' | 'off' | 'unreachable' | 'unavailable' }

export type ShareFailure = 'not-a-window' | 'signed-out' | 'unreachable' | 'unknown' | 'failed'

export type SharesListResult =
  | { ok: true; shares: ShareView[] }
  | { ok: false; error: ShareFailure }

export type ShareActionResult = { ok: true } | { ok: false; error: ShareFailure }
