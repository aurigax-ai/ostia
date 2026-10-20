export const APPLIED_RETENTION_MS = 90 * 24 * 60 * 60 * 1000
export const APPLIED_MAX_BYTES = 1024 * 1024

export interface Applied {
  at: number
  session: string
  workspace: string
  rules: string[]
  held: string[]
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
}

export function parseAppliedLine(line: string): Applied | null {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  const a = raw as Partial<Applied> | null
  const valid =
    typeof a?.at === 'number' &&
    typeof a.session === 'string' &&
    typeof a.workspace === 'string' &&
    isStrings(a.rules) &&
    isStrings(a.held)
  return valid ? (a as Applied) : null
}
