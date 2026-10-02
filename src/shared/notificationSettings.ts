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
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out
  const source = raw as Record<string, unknown>
  for (const key of Object.keys(out) as (keyof NotificationSettings)[]) {
    if (key === 'command') {
      if (typeof source.command === 'string') out.command = source.command
    } else if (key === 'longCommandSeconds') {
      out.longCommandSeconds = clampLongCommandSeconds(source.longCommandSeconds)
    } else if (key === 'bell') {
      if (BELL_MODES.includes(source.bell as BellMode)) out.bell = source.bell as BellMode
    } else if (typeof source[key] === 'boolean') out[key] = source[key]
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
