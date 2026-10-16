const WAKE_REASON_MAX = 200

export function wakeReason(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const text = [...raw]
    .filter((ch) => {
      const code = ch.charCodeAt(0)
      return code >= 0x20 && !(code >= 0x7f && code <= 0x9f)
    })
    .join('')
    .trim()
  return text ? text.slice(0, WAKE_REASON_MAX) : undefined
}
