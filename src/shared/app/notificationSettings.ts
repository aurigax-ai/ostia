import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'
export const BELL_MODES = ['attention', 'sound', 'off'] as const

export type BellMode = (typeof BELL_MODES)[number]

export const LONG_COMMAND_MIN_SECONDS = 1
export const LONG_COMMAND_MAX_SECONDS = 3600

export interface NotificationSettings {
  desktop: boolean
  sound: boolean
  whenFocused: boolean
  agentWaiting: boolean
  agentDone: boolean
  commandFinished: boolean
  command: string
  longCommandSeconds: number
  bell: BellMode
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  desktop: true,
  sound: true,
  whenFocused: false,
  agentWaiting: true,
  agentDone: true,
  commandFinished: true,
  command: '',
  longCommandSeconds: 10,
  bell: 'attention',
}

export function parseNotificationSettings(raw: unknown): NotificationSettings {
  const out = { ...DEFAULT_NOTIFICATION_SETTINGS }
  if (!isRecord(raw)) return out
  for (const key of Object.keys(out) as (keyof NotificationSettings)[]) {
    if (key === 'command') {
      if (typeof raw.command === 'string') out.command = raw.command
    } else if (key === 'longCommandSeconds') {
      out.longCommandSeconds = clampLongCommandSeconds(raw.longCommandSeconds)
    } else if (key === 'bell') {
      if (BELL_MODES.includes(raw.bell as BellMode)) out.bell = raw.bell as BellMode
    } else if (typeof raw[key] === 'boolean') out[key] = raw[key]
  }
  return out
}

export function clampLongCommandSeconds(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number.NaN
  if (!Number.isFinite(n)) return DEFAULT_NOTIFICATION_SETTINGS.longCommandSeconds
  return Math.min(LONG_COMMAND_MAX_SECONDS, Math.max(LONG_COMMAND_MIN_SECONDS, Math.round(n)))
}

export type NotificationKind = 'message' | 'agentWaiting' | 'agentDone' | 'commandFinished'

export function wantsDesktopBanner(
  settings: NotificationSettings,
  kind: NotificationKind,
  seen: boolean,
): boolean {
  if (!settings.desktop) return false
  if (kind !== 'message' && !settings[kind]) return false
  return !seen || settings.whenFocused
}
