import { describe, expect, it } from 'vitest'
import { SHARED_TAB_TEXT, formatText, toResponse } from './browse'

describe('toResponse', () => {
  it('wraps a successful result as {success, data, error}', () => {
    expect(toResponse({ ok: true, snapshot: '- button [ref=e1]', refs: {} })).toEqual({
      success: true,
      data: { snapshot: '- button [ref=e1]', refs: {} },
      error: null,
    })
  })

  it('uses null data when the command returns nothing', () => {
    expect(toResponse({ ok: true })).toEqual({ success: true, data: null, error: null })
  })

  it('joins the error code and message', () => {
    expect(toResponse({ ok: false, error: 'covered', message: 'covered by <div#banner>' })).toEqual(
      { success: false, data: null, error: 'covered: covered by <div#banner>' },
    )
    expect(toResponse({ ok: false, error: 'needs-elevation' }).error).toBe('needs-elevation')
  })
})

describe('formatText', () => {
  it('prints the snapshot tree and page text as is', () => {
    expect(formatText('snapshot', { snapshot: '- link "Home" [ref=e1]', refs: {} })).toBe(
      '- link "Home" [ref=e1]',
    )
    expect(formatText('read', { text: 'Hello' })).toBe('Hello')
  })

  it('prints string values raw and other values as JSON', () => {
    expect(formatText('get', { value: 'Title' })).toBe('Title')
    expect(formatText('get', { value: 3 })).toBe('3')
    expect(formatText('eval', { result: { a: 1 } })).toBe('{\n  "a": 1\n}')
    expect(formatText('is', { value: false })).toBe('false')
  })

  it('prints ok for commands without data', () => {
    expect(formatText('click', null)).toBe('ok')
  })

  it('lists tabs with the active one starred', () => {
    expect(
      formatText('tab', {
        tabs: [
          { tabId: 'p1', title: 'A', url: 'https://a.test/', active: true },
          { tabId: 'p2', title: 'B', url: 'https://b.test/', active: false },
        ],
      }),
    ).toBe('* p1\tA\thttps://a.test/\n  p2\tB\thttps://b.test/')
  })

  it('lists a tab on the human’s profile without its page, saying driving it asks them', () => {
    expect(formatText('tab', { tabs: [{ tabId: 'p3', profile: 'shared', active: false }] })).toBe(
      `  p3\t${SHARED_TAB_TEXT}`,
    )
  })

  it('lists console entries and network requests one per line', () => {
    expect(formatText('console', { entries: [{ level: 'error', text: 'boom', ts: 1 }] })).toBe(
      '[error] boom',
    )
    expect(
      formatText('network', {
        requests: [
          { requestId: '7', method: 'GET', status: 200, type: 'XHR', url: 'https://x.test/a' },
        ],
      }),
    ).toBe('7\tGET\t200\tXHR\thttps://x.test/a')
  })

  it('prints one storage value raw and a whole area as JSON', () => {
    expect(formatText('storage', { key: 'k', value: 'v' })).toBe('v')
    expect(formatText('storage', { key: 'k', value: null })).toBe('')
    expect(formatText('storage', { origin: 'https://x.test', values: { k: 'v' } })).toBe(
      '{\n  "k": "v"\n}',
    )
  })
})
