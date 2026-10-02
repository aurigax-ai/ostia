export type RelativeTimeUnit = Intl.RelativeTimeFormatUnit

export const DEFAULT_UNITS: [RelativeTimeUnit, number][] = [
  ['year', 31_536_000_000],
  ['month', 2_592_000_000],
  ['week', 604_800_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
  ['second', 1000],
]

export function formatRelativeTime(
  absMsTimestamp: number,
  now: number,
  locale: string,
  units: [RelativeTimeUnit, number][] = DEFAULT_UNITS,
): string {
  const diff = absMsTimestamp - now
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  for (const [unit, size] of units) {
    if (Math.abs(diff) >= size) return rtf.format(Math.round(diff / size), unit)
  }
  return rtf.format(0, 'second')
}
