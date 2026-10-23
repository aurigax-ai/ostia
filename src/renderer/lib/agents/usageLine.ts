import { fmt } from '@shared/app/dict'
import {
  type AccountUsage,
  percentNow,
  type UsageWindow,
} from '@shared/claudeAccounts/claudeAccounts'

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const STALE_AFTER_MS = 30 * 60 * 1000

export interface UsageLineStrings {
  usageSession: string
  usageWeekly: string
  usagePace: string
  usageResets: string
}

export function weeklyPace(weekly: UsageWindow, now: number): number {
  if (weekly.resetsAt <= now) return 0
  const elapsed = WEEK_MS - (weekly.resetsAt - now)
  return Math.min(100, Math.max(0, Math.round((elapsed / WEEK_MS) * 100)))
}

function resetWhen(resetsAt: number, now: number, locale: string): string {
  const options: Intl.DateTimeFormatOptions =
    resetsAt - now < DAY_MS ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short' }
  return new Intl.DateTimeFormat(locale, options).format(resetsAt)
}

export function usageLineParts(
  usage: AccountUsage,
  now: number,
  locale: string,
  strings: UsageLineStrings,
): string[] {
  const parts: string[] = []
  if (usage.session) {
    parts.push(fmt(strings.usageSession, { percent: String(percentNow(usage.session, now)) }))
  }
  const { weekly } = usage
  if (weekly) {
    parts.push(fmt(strings.usageWeekly, { percent: String(percentNow(weekly, now)) }))
    if (weekly.resetsAt > now) {
      parts.push(fmt(strings.usagePace, { percent: String(weeklyPace(weekly, now)) }))
      parts.push(fmt(strings.usageResets, { when: resetWhen(weekly.resetsAt, now, locale) }))
    }
  }
  return parts
}

export function isStale(usage: AccountUsage, now: number): boolean {
  return now - usage.checkedAt > STALE_AFTER_MS
}
