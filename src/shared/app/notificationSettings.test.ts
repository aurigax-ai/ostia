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

describe('parseNotificationSettings command', () => {
  it('keeps a string command and ignores any other type', () => {
    expect(parseNotificationSettings({ command: 'say {title}' }).command).toBe('say {title}')
    expect(parseNotificationSettings({ command: true }).command).toBe('')
    expect(parseNotificationSettings(undefined).command).toBe('')
  })
})

describe('parseNotificationSettings tuning', () => {
  it('clamps the long-command threshold to whole seconds between 1 and 3600', () => {
    expect(parseNotificationSettings({ longCommandSeconds: 30 }).longCommandSeconds).toBe(30)
    expect(parseNotificationSettings({ longCommandSeconds: 0 }).longCommandSeconds).toBe(1)
    expect(parseNotificationSettings({ longCommandSeconds: 1e9 }).longCommandSeconds).toBe(3600)
    expect(parseNotificationSettings({ longCommandSeconds: 2.6 }).longCommandSeconds).toBe(3)
    expect(parseNotificationSettings({ longCommandSeconds: '5' }).longCommandSeconds).toBe(10)
  })

  it('keeps a known bell mode and falls back to attention', () => {
    expect(parseNotificationSettings({ bell: 'off' }).bell).toBe('off')
    expect(parseNotificationSettings({ bell: 'sound' }).bell).toBe('sound')
    expect(parseNotificationSettings({ bell: 'loud' }).bell).toBe('attention')
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
