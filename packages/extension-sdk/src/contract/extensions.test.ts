import { describe, expect, it } from 'vitest'
import {
  PANE_CHIP_ITEM_TEXT_MAX,
  paneChipItems,
  SIDEBAR_URL_MAX,
  sidebarItemUrl,
} from './extensions'

describe('sidebarItemUrl', () => {
  it('accepts http and https URLs, normalized', () => {
    expect(sidebarItemUrl('http://localhost:3000')).toBe('http://localhost:3000/')
    expect(sidebarItemUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
  })

  it('refuses other schemes, junk and oversized values', () => {
    expect(sidebarItemUrl('file:///etc/passwd')).toBeNull()
    expect(sidebarItemUrl('javascript:alert(1)')).toBeNull()
    expect(sidebarItemUrl('not a url')).toBeNull()
    expect(sidebarItemUrl(42)).toBeNull()
    expect(sidebarItemUrl(`http://x/${'a'.repeat(SIDEBAR_URL_MAX)}`)).toBeNull()
  })
})

describe('paneChipItems ports', () => {
  it('RPF-C10 keeps the port of an item and refuses a bad one', () => {
    expect(paneChipItems([{ text: ':3000', port: { remote: 3000, local: 3000 } }])).toEqual([
      { text: ':3000', port: { remote: 3000, local: 3000 } },
    ])
    expect(paneChipItems([{ text: ':8080', port: { remote: 8080 } }])).toEqual([
      { text: ':8080', port: { remote: 8080 } },
    ])
    expect(paneChipItems([{ text: ':0', port: { remote: 0 } }])).toBeNull()
    expect(paneChipItems([{ text: ':1', port: { remote: 1, local: 70000 } }])).toBeNull()
  })
})

describe('paneChipItems', () => {
  it('keeps an item detail, trimmed and capped, and drops an empty or non-text one', () => {
    expect(
      paneChipItems([
        { text: ':5173', detail: ' node ', url: 'http://localhost:5173' },
        { text: ':8000', detail: 'x'.repeat(PANE_CHIP_ITEM_TEXT_MAX + 5) },
        { text: ':9000', detail: ' ' },
        { text: ':9001', detail: 42 },
      ]),
    ).toEqual([
      { text: ':5173', detail: 'node', url: 'http://localhost:5173/' },
      { text: ':8000', detail: 'x'.repeat(PANE_CHIP_ITEM_TEXT_MAX) },
      { text: ':9000' },
      { text: ':9001' },
    ])
  })
})
