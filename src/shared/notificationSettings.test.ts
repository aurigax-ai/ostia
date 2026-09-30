import { describe, expect, it } from 'vitest'
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  parseNotificationSettings,
  wantsDesktopBanner,
} from './notificationSettings'

describe('parseNotificationSettings', () => {
  it('fills defaults and keeps only boolean overrides', () => {
    expect(parseNotificationSettings(undefined)).toEqual(DEFAULT_NOTIFICATION_SETTINGS)
    expect(parseNotificationSettings({ sound: false, agentDone: 'no', extra: true })).toEqual({
      ...DEFAULT_NOTIFICATION_SETTINGS,
      sound: false,
    })
  })
})

describe('wantsDesktopBanner', () => {
  const on = DEFAULT_NOTIFICATION_SETTINGS

  it('shows a banner for an unseen pane and not for the one being looked at', () => {
    expect(wantsDesktopBanner(on, 'agentWaiting', false)).toBe(true)
    expect(wantsDesktopBanner(on, 'agentWaiting', true)).toBe(false)
  })

  it('shows banners for the seen pane too when whenFocused is on', () => {
    expect(wantsDesktopBanner({ ...on, whenFocused: true }, 'agentDone', true)).toBe(true)
  })

  it('drops a kind that is switched off, but never a plain message', () => {
    const off = { ...on, agentDone: false, commandFinished: false, agentWaiting: false }
    expect(wantsDesktopBanner(off, 'agentDone', false)).toBe(false)
    expect(wantsDesktopBanner(off, 'commandFinished', false)).toBe(false)
    expect(wantsDesktopBanner(off, 'message', false)).toBe(true)
  })

  it('shows nothing when desktop notifications are off', () => {
    expect(wantsDesktopBanner({ ...on, desktop: false }, 'message', false)).toBe(false)
  })
})
