import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LINK_MODIFIER_CLASS,
  attachLinkClaim,
  attachLinkModifier,
  linkSpan,
  linkTarget,
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

describe('linkTarget', () => {
  it('follows the setting on a plain modifier click and flips it while Shift is held', () => {
    expect(linkTarget(true, { shiftKey: false })).toBe('pane')
    expect(linkTarget(true, { shiftKey: true })).toBe('system')
    expect(linkTarget(false, { shiftKey: false })).toBe('system')
    expect(linkTarget(false, { shiftKey: true })).toBe('pane')
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
