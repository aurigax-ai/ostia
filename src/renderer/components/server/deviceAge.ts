const MINUTE_MS = 60_000
const HOURS_PER_DAY = 24
const MINUTES_PER_HOUR = 60

export function ageText(locale: string, since: number, now = Date.now()): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const minutes = Math.max(0, Math.round((now - since) / MINUTE_MS))
  if (minutes < MINUTES_PER_HOUR) return rtf.format(-minutes, 'minute')
  const hours = Math.round(minutes / MINUTES_PER_HOUR)
  if (hours < HOURS_PER_DAY * 2) return rtf.format(-hours, 'hour')
  return rtf.format(-Math.round(hours / HOURS_PER_DAY), 'day')
}
