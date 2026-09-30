export interface NotificationSettings {
  desktop: boolean
  sound: boolean
  whenFocused: boolean
  agentWaiting: boolean
  agentDone: boolean
  commandFinished: boolean
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  desktop: true,
  sound: true,
  whenFocused: false,
  agentWaiting: true,
  agentDone: true,
  commandFinished: true,
}

export function parseNotificationSettings(raw: unknown): NotificationSettings {
  const out = { ...DEFAULT_NOTIFICATION_SETTINGS }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out
  const source = raw as Record<string, unknown>
  for (const key of Object.keys(out) as (keyof NotificationSettings)[]) {
    if (typeof source[key] === 'boolean') out[key] = source[key]
  }
  return out
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
