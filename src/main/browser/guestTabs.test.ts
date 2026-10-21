import type { Referrer, WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { openGuestTab, TAB_REFERRER_MS, tabReferrer, tabReferrerOf } from './guestTabs'

const PAGE = 'https://site.example/docs/page?q=1'
const SAME = 'https://site.example/other'
const CROSS = 'https://docs.example.com/'

const from = (policy: Referrer['policy'], url = PAGE): Referrer => ({ url, policy })

describe('tabReferrer', () => {
  it('passes the page address for the default policies, leaving the trim to Chromium', () => {
    for (const policy of [
      'default',
      'strict-origin-when-cross-origin',
      'no-referrer-when-downgrade',
      'unsafe-url',
    ] as const) {
      expect(tabReferrer(from(policy), CROSS)).toBe(PAGE)
    }
  })

  it('sends nothing for no-referrer, an empty or opaque referrer, or a cross-origin same-origin policy', () => {
    expect(tabReferrer(from('no-referrer'), SAME)).toBe('')
    expect(tabReferrer(from('default', ''), CROSS)).toBe('')
    expect(tabReferrer(from('default', 'about:blank'), CROSS)).toBe('')
    expect(tabReferrer(from('same-origin'), CROSS)).toBe('')
    expect(tabReferrer(from('same-origin'), SAME)).toBe(PAGE)
  })

  it('sends only the origin for the origin policies, also to the same origin', () => {
    expect(tabReferrer(from('origin'), SAME)).toBe('https://site.example/')
    expect(tabReferrer(from('strict-origin'), CROSS)).toBe('https://site.example/')
  })
})

describe('openGuestTab', () => {
  let nextHost = 1
  function guest(alive = true) {
    const host = { id: nextHost++, send: vi.fn(), isDestroyed: () => !alive }
    return { guest: { id: 7, hostWebContents: host } as unknown as WebContents, host }
  }

  it('asks the pane’s window for a tab and keeps the referrer the page’s policy allows for its first load', () => {
    const { guest: opener, host } = guest()
    openGuestTab(opener, CROSS, true, from('default'), 1000)
    expect(host.send).toHaveBeenCalledWith('browser:open-tab', {
      guestId: 7,
      url: CROSS,
      background: true,
    })
    expect(tabReferrerOf(host.id, CROSS, 1000 + TAB_REFERRER_MS)).toBe(PAGE)
    expect(tabReferrerOf(host.id, CROSS, 1001 + TAB_REFERRER_MS)).toBeUndefined()
    expect(tabReferrerOf(host.id, SAME, 1000)).toBeUndefined()
    expect(tabReferrerOf(host.id + 1, CROSS, 1000)).toBeUndefined()
  })

  it('keeps no referrer the policy withholds', () => {
    const { guest: opener, host } = guest()
    openGuestTab(opener, CROSS, false, from('same-origin'), 1000)
    expect(host.send).toHaveBeenCalled()
    expect(tabReferrerOf(host.id, CROSS, 1000)).toBeUndefined()
  })

  it('sends nothing for a non-web address or without a live window', () => {
    const live = guest()
    openGuestTab(live.guest, 'file:///etc/passwd', false, from('default'))
    const gone = guest(false)
    openGuestTab(gone.guest, CROSS, false, from('default'))
    const orphan = { id: 7, hostWebContents: null } as unknown as WebContents
    openGuestTab(orphan, CROSS, false, from('default'))
    expect(live.host.send).not.toHaveBeenCalled()
    expect(gone.host.send).not.toHaveBeenCalled()
  })
})
