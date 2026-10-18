export interface CredentialSummary {
  id: string
  origin: string
  username: string
  updatedAt: number
}

export interface CredentialInput {
  origin: string
  username: string
  password: string
}

export type CredentialSaveResult =
  | { ok: true; id: string; updated: boolean }
  | { ok: false; error: 'invalid-origin' | 'empty' | 'encryption-unavailable' }

export type CredentialImportResult =
  | { ok: true; imported: number; updated: number; skipped: number }
  | { ok: false; error: 'cancelled' | 'unreadable' | 'no-columns' | 'encryption-unavailable' }

export const CREDENTIAL_FIELD_MAX = 1024

export function normalizeOrigin(raw: string): string | null {
  try {
    const url = new URL(raw.trim())
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return url.origin
  } catch {
    return null
  }
}
