import { afterEach, describe, expect, it } from 'vitest'
import { LINK_MODIFIER_CLASS, attachLinkModifier } from './linkModifier'

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
