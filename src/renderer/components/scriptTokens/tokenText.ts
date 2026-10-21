import type { Dict } from '@shared/app/dict'
import type { ScriptTokenInfo, ScriptTokenSaveResult } from '@shared/permissions/scriptTokens'
import { relativeTimeText } from '@/lib/app/localeFormat'
import { fmt } from '@/lib/app/useDict'

export const ENV = 'OSTIA_TOKEN'

export const DAY_MS = 86_400_000

const SOON_DAYS = 7

export const EXAMPLE = 'ostia pane list'

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

export function localDate(iso: string): string {
  const at = new Date(iso)
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

export function localTime(iso: string): string {
  const at = new Date(iso)
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
}

export function daysUntil(iso: string, now: number): number {
  return Math.ceil((Date.parse(iso) - now) / DAY_MS)
}

export function expiryState(
  t: ScriptTokenInfo,
  now: number,
): 'never' | 'expired' | 'soon' | 'later' {
  if (t.expiresAt === null) return 'never'
  const left = Date.parse(t.expiresAt) - now
  if (left <= 0) return 'expired'
  return left <= SOON_DAYS * DAY_MS ? 'soon' : 'later'
}

export function expiryText(d: Dict, t: ScriptTokenInfo, now: number): string {
  const state = expiryState(t, now)
  if (state === 'never' || t.expiresAt === null) return d.scriptTokens.neverExpires
  if (state === 'expired') return d.scriptTokens.expired
  if (state === 'soon') return fmt(d.scriptTokens.expiresIn, { n: daysUntil(t.expiresAt, now) })
  return fmt(d.scriptTokens.expiresOn, { date: localDate(t.expiresAt) })
}

export function lastUsedText(d: Dict, iso: string | null, now: number, locale: string): string {
  if (!iso) return d.scriptTokens.neverUsed
  return relativeTimeText(Date.parse(iso), now, locale)
}

export function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export function masked(value: string): string {
  return value.length > 16 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value
}

export function failureText(d: Dict, res: Extract<ScriptTokenSaveResult, { ok: false }>): string {
  if (res.presence === 'cancelled') return d.scriptTokens.authCancelled
  if (res.presence === 'polkit-agent') return d.scriptTokens.authNoAgent
  if (res.presence === 'refused') {
    return fmt(d.scriptTokens.authFailed, { detail: res.error.replace(/^presence-\w+: /, '') })
  }
  return fmt(d.scriptTokens.saveFailed, { error: res.error })
}
