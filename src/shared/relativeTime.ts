export type RelativeStep = readonly [unit: Intl.RelativeTimeFormatUnit, size: number]

export function formatRelative(
  diff: number,
  steps: readonly RelativeStep[],
  format: Intl.RelativeTimeFormat,
): string {
  const [unit, size] = steps.find((step) => Math.abs(diff) >= step[1]) ?? steps[steps.length - 1]
  return format.format(Math.round(diff / size), unit)
}
