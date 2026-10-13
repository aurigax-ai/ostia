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
