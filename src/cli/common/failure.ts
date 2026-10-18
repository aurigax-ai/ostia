import { usageOf } from './usageTable'

export function failureHint(err: unknown): string | undefined {
  const data = (err as { data?: unknown } | null)?.data
  const hint = (data as { hint?: unknown } | null | undefined)?.hint
  return typeof hint === 'string' ? hint : undefined
}

export function describeFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  const hint = failureHint(err)
  return hint ? `${message}. ${hint}` : message
}

export interface ErrResult {
  ok: false
  error: string
  message?: string
}

export function isErrResult(res: unknown): res is ErrResult {
  return typeof res === 'object' && res !== null && (res as { ok?: unknown }).ok === false
}

export function describeErrResult(res: ErrResult): string {
  return res.message ? `${res.error}: ${res.message}` : res.error
}

export function fail(message: string): void {
  console.error(message)
  process.exitCode = 1
}

export function failUsage(noun: string): void {
  fail(usageOf(noun))
}
