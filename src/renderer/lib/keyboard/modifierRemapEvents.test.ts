import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  installModifierRemap,
  isRemappedEvent,
  setActiveModifierRemap,
} from './modifierRemapEvents'

let uninstall: () => void

beforeEach(() => {
  uninstall = installModifierRemap()
})

afterEach(() => {
  uninstall()
})

function press(init: KeyboardEventInit & { code: string }): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, ...init })
  document.body.dispatchEvent(e)
  return e
}

function flags(e: KeyboardEvent): string {
  return [e.ctrlKey && 'ctrl', e.altKey && 'alt', e.metaKey && 'meta'].filter(Boolean).join('+')
}

describe('modifier remap on events', () => {
  it('reports the real modifiers with the default table', () => {
    setActiveModifierRemap({})
    press({ code: 'ControlRight', key: 'Control', ctrlKey: true })
    const e = press({ code: 'KeyC', key: 'c', ctrlKey: true })
    expect(flags(e)).toBe('ctrl')
    expect(isRemappedEvent(e)).toBe(false)
  })

  it('reads the key a physical modifier is mapped to, on that side only', () => {
    setActiveModifierRemap({ ControlRight: 'command' })
    press({ code: 'ControlLeft', key: 'Control', ctrlKey: true })
    expect(flags(press({ code: 'KeyC', key: 'c', ctrlKey: true }))).toBe('ctrl')
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ControlLeft', key: 'Control' }))
    press({ code: 'ControlRight', key: 'Control', ctrlKey: true })
    const e = press({ code: 'KeyC', key: 'c', ctrlKey: true })
    expect(flags(e)).toBe('meta')
    expect(e.getModifierState('Meta')).toBe(true)
    expect(e.getModifierState('Control')).toBe(false)
    expect(isRemappedEvent(e)).toBe(true)
  })

  it('maps two held keys to two modifiers and leaves Shift alone', () => {
    setActiveModifierRemap({ AltLeft: 'control', MetaLeft: 'option' })
    press({ code: 'AltLeft', key: 'Alt', altKey: true })
    press({ code: 'MetaLeft', key: 'Meta', altKey: true, metaKey: true })
    const e = press({ code: 'KeyA', key: 'a', altKey: true, metaKey: true, shiftKey: true })
    expect(flags(e)).toBe('ctrl+alt')
    expect(e.shiftKey).toBe(true)
  })

  it('names a modifier press after what it now stands for', () => {
    setActiveModifierRemap({ MetaRight: 'control' })
    expect(press({ code: 'MetaRight', key: 'Meta', metaKey: true }).key).toBe('Control')
    expect(press({ code: 'KeyM', key: 'm' }).key).toBe('m')
  })

  it('remaps the modifiers of a mouse click too', () => {
    setActiveModifierRemap({ MetaLeft: 'control' })
    press({ code: 'MetaLeft', key: 'Meta', metaKey: true })
    const click = new MouseEvent('click', { metaKey: true })
    expect(click.ctrlKey).toBe(true)
    expect(click.metaKey).toBe(false)
  })

  it('forgets held keys when the window loses focus', () => {
    setActiveModifierRemap({ ControlLeft: 'option' })
    press({ code: 'ControlLeft', key: 'Control', ctrlKey: true })
    window.dispatchEvent(new Event('blur'))
    expect(flags(press({ code: 'KeyC', key: 'c', ctrlKey: true }))).toBe('ctrl')
  })

  it('does not remap a modifier the system says is not held', () => {
    setActiveModifierRemap({ ControlLeft: 'option' })
    press({ code: 'ControlLeft', key: 'Control', ctrlKey: true })
    expect(flags(press({ code: 'KeyC', key: 'c' }))).toBe('')
  })

  it('puts the native getters back on uninstall', () => {
    setActiveModifierRemap({ ControlLeft: 'option' })
    uninstall()
    press({ code: 'ControlLeft', key: 'Control', ctrlKey: true })
    expect(flags(press({ code: 'KeyC', key: 'c', ctrlKey: true }))).toBe('ctrl')
    uninstall = installModifierRemap()
  })
})
