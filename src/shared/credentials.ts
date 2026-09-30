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

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (ch === '"') {
        quoted = false
      } else {
        field += ch
      }
    } else if (ch === '"') {
      quoted = true
    } else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += ch
    }
  }
  if (field || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((cell) => cell.trim()))
}

const URL_COLUMNS = ['url', 'login_uri', 'origin', 'website']
const USER_COLUMNS = ['username', 'login_username', 'login', 'user']
const PASSWORD_COLUMNS = ['password', 'login_password']

export function passwordRowsFromCsv(text: string): CredentialInput[] | null {
  const [header, ...rows] = parseCsv(text)
  if (!header) return null
  const names = header.map((h) => h.trim().toLowerCase())
  const col = (options: string[]) => names.findIndex((n) => options.includes(n))
  const urlAt = col(URL_COLUMNS)
  const userAt = col(USER_COLUMNS)
  const passwordAt = col(PASSWORD_COLUMNS)
  if (urlAt < 0 || passwordAt < 0) return null
  return rows.map((r) => ({
    origin: r[urlAt] ?? '',
    username: userAt >= 0 ? (r[userAt] ?? '') : '',
    password: r[passwordAt] ?? '',
  }))
}
