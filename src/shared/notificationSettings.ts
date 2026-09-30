export interface NotificationSettings {
  desktop: boolean
  sound: boolean
  whenFocused: boolean
  agentWaiting: boolean
  agentDone: boolean
  commandFinished: boolean
  command: string
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  desktop: true,
  sound: true,
  whenFocused: false,
  agentWaiting: true,
  agentDone: true,
  commandFinished: true,
  command: '',
}

export function parseNotificationSettings(raw: unknown): NotificationSettings {
  const out = { ...DEFAULT_NOTIFICATION_SETTINGS }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out
  const source = raw as Record<string, unknown>
  for (const key of Object.keys(out) as (keyof NotificationSettings)[]) {
    if (key === 'command') {
      if (typeof source.command === 'string') out.command = source.command
    } else if (typeof source[key] === 'boolean') out[key] = source[key]
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
