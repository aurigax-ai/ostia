import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LINK_MODIFIER_CLASS,
  attachLinkClaim,
  attachLinkModifier,
  linkSpan,
  webLinkTarget,
} from './linkModifier'

describe('attachLinkModifier', () => {
  let detach: (() => void) | null = null
  afterEach(() => {
    detach?.()
    detach = null
  })

  it('marks the host while Ctrl is held and clears it on release', () => {
    const host = document.createElement('div')
    detach = attachLinkModifier(host, false)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true }))
    expect(host.classList.contains(LINK_MODIFIER_CLASS)).toBe(true)
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', ctrlKey: false }))
    expect(host.classList.contains(LINK_MODIFIER_CLASS)).toBe(false)
  })

  it('uses Cmd instead of Ctrl on macOS', () => {
    const host = document.createElement('div')
    detach = attachLinkModifier(host, true)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true }))
    expect(host.classList.contains(LINK_MODIFIER_CLASS)).toBe(false)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta', metaKey: true }))
    expect(host.classList.contains(LINK_MODIFIER_CLASS)).toBe(true)
  })

  it('follows the modifier state of mouse moves and clears on window blur', () => {
    const host = document.createElement('div')
    detach = attachLinkModifier(host, false)
    host.dispatchEvent(new MouseEvent('mousemove', { ctrlKey: true }))
    expect(host.classList.contains(LINK_MODIFIER_CLASS)).toBe(true)
    window.dispatchEvent(new Event('blur'))
    expect(host.classList.contains(LINK_MODIFIER_CLASS)).toBe(false)
  })
})

describe('webLinkTarget', () => {
  const plain = { ctrlKey: false, metaKey: false, shiftKey: false, detail: 1 }
  const idle = { mac: false, hasSelection: false, mouseReporting: false }

  it('opens a plain click in the same browser tab', () => {
    expect(webLinkTarget(plain, idle)).toBe('same-tab')
  })

  it('opens a Ctrl+click in a new browser tab and Ctrl+Shift+click in the system browser', () => {
    expect(webLinkTarget({ ...plain, ctrlKey: true }, idle)).toBe('new-tab')
    expect(webLinkTarget({ ...plain, ctrlKey: true, shiftKey: true }, idle)).toBe('system')
  })

  it('uses Cmd instead of Ctrl on macOS', () => {
    const mac = { ...idle, mac: true }
    expect(webLinkTarget({ ...plain, metaKey: true }, mac)).toBe('new-tab')
    expect(webLinkTarget({ ...plain, metaKey: true, shiftKey: true }, mac)).toBe('system')
    expect(webLinkTarget({ ...plain, ctrlKey: true }, mac)).toBe(null)
    expect(webLinkTarget({ ...plain, ctrlKey: true }, idle)).toBe('new-tab')
    expect(webLinkTarget({ ...plain, metaKey: true }, idle)).toBe(null)
  })

  it('ignores a plain click that ends a selection or drag, or is a double click', () => {
    expect(webLinkTarget(plain, { ...idle, hasSelection: true })).toBe(null)
    expect(webLinkTarget({ ...plain, detail: 2 }, idle)).toBe(null)
    expect(webLinkTarget({ ...plain, shiftKey: true }, idle)).toBe(null)
  })

  it('leaves a plain click to a program that reports the mouse but keeps modifier clicks', () => {
    const tui = { ...idle, mouseReporting: true }
    expect(webLinkTarget(plain, tui)).toBe(null)
    expect(webLinkTarget({ ...plain, ctrlKey: true }, tui)).toBe('new-tab')
    expect(webLinkTarget({ ...plain, ctrlKey: true, shiftKey: true }, tui)).toBe('system')
  })

  it('keeps modifier clicks working over a selection', () => {
    const selected = { ...idle, hasSelection: true }
    expect(webLinkTarget({ ...plain, ctrlKey: true }, selected)).toBe('new-tab')
  })
})

describe('linkSpan', () => {
  it('maps a one-row link to zero-based viewport cells, end exclusive', () => {
    const range = { start: { x: 5, y: 12 }, end: { x: 14, y: 12 } }
    expect(linkSpan(range, 10, 80)).toEqual({ row: 1, start: 4, end: 14 })
  })

  it('runs a wrapped link to the end of its first row', () => {
    const range = { start: { x: 70, y: 3 }, end: { x: 9, y: 4 } }
    expect(linkSpan(range, 0, 80)).toEqual({ row: 2, start: 69, end: 80 })
  })
})

describe('attachLinkClaim', () => {
  const setup = (claims: boolean) => {
    const parent = document.createElement('div')
    const screen = document.createElement('div')
    parent.append(screen)
    const own = vi.fn()
    const reported = vi.fn()
    screen.addEventListener('mousedown', own)
    parent.addEventListener('mousedown', reported)
    const detach = attachLinkClaim(screen, () => claims)
    return { screen, own, reported, detach }
  }

  it('keeps a claimed press from reaching the terminal behind the link layer', () => {
    const { screen, own, reported, detach } = setup(true)
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true, ctrlKey: true })
    screen.dispatchEvent(press)
    expect(own).toHaveBeenCalledTimes(1)
    expect(reported).not.toHaveBeenCalled()
    expect(press.defaultPrevented).toBe(true)
    detach()
  })

  it('lets unclaimed presses and other buttons through', () => {
    const { screen, reported, detach } = setup(false)
    screen.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(reported).toHaveBeenCalledTimes(1)
    detach()
    const claimed = setup(true)
    claimed.screen.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 2 }))
    expect(claimed.reported).toHaveBeenCalledTimes(1)
    claimed.detach()
  })
})
