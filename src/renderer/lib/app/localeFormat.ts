import { formatRelative, type RelativeStep } from '@shared/common/relativeTime'
import { useMemo } from 'react'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { currentDict, useDict } from './useDict'

const DATE_TIME: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
}

export const DATE_ONLY: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
}

export const TIME_ONLY: Intl.DateTimeFormatOptions = { timeStyle: 'medium' }

export const TIME_24H: Intl.DateTimeFormatOptions = {
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
  hour12: false,
}

export function formatDate(
  at: number,
  locale: string,
  options: Intl.DateTimeFormatOptions = DATE_TIME,
): string {
  if (!Number.isFinite(at) || Number.isNaN(new Date(at).getTime())) {
    return currentDict().formats.unknownDate
  }
  return new Intl.DateTimeFormat(locale, options).format(at)
}

const BYTE_UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const

function fractionDigits(step: number): number {
  return step === 0 ? 0 : 1
}

function rounded(value: number, digits: number): number {
  return Math.round(value * 10 ** digits) / 10 ** digits
}

export function formatBytes(bytes: number, locale: string): string {
  let value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0
  let step = 0
  while (step < BYTE_UNITS.length - 1 && rounded(value, fractionDigits(step)) >= 1000) {
    value /= 1000
    step++
  }
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: BYTE_UNITS[step],
    unitDisplay: step === 0 ? 'long' : 'short',
    maximumFractionDigits: fractionDigits(step),
  }).format(value)
}

const MINUTE_STEPS: RelativeStep[] = [
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
]

export function relativeTimeText(at: number, now: number, locale: string): string {
  const seconds = Math.round((at - now) / 1000)
  const beyondMinute = Math.abs(seconds) >= 60 ? seconds : 0
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  return formatRelative(beyondMinute, MINUTE_STEPS, format)
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export function agoText(
  elapsedMs: number,
  justNow: string,
  format: Pick<Intl.RelativeTimeFormat, 'format'>,
): string {
  if (elapsedMs < MINUTE) return justNow
  if (elapsedMs < HOUR) return format.format(-Math.floor(elapsedMs / MINUTE), 'minute')
  if (elapsedMs < DAY) return format.format(-Math.floor(elapsedMs / HOUR), 'hour')
  return format.format(-Math.floor(elapsedMs / DAY), 'day')
}

export function useAgoText(): (elapsedMs: number) => string {
  const d = useDict()
  const locale = useSettingsStore((s) => s.locale)
  const relative = useMemo(
    () => new Intl.RelativeTimeFormat(locale, { numeric: 'always', style: 'short' }),
    [locale],
  )
  return (elapsedMs) => agoText(elapsedMs, d.dashboard.justNow, relative)
}
