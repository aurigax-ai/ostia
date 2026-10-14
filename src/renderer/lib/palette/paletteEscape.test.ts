import { afterEach, describe, expect, it, vi } from 'vitest'
import { isComposingEscape, swallowHeldEscape } from './paletteEscape'

const press = (init: KeyboardEventInit, type = 'keydown'): KeyboardEvent => {
  const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })
  document.body.dispatchEvent(event)
  return event
}

describe('isComposingEscape', () => {
  it('is the Escape an input method took while it was composing', () => {
    expect(
      isComposingEscape({ key: 'Process', code: 'Escape', keyCode: 229, isComposing: true }),
    ).toBe(true)
    expect(
      isComposingEscape({ key: 'Escape', code: 'Escape', keyCode: 27, isComposing: true }),
    ).toBe(true)
    expect(
      isComposingEscape({ key: 'Process', code: 'Escape', keyCode: 229, isComposing: false }),
    ).toBe(true)
  })

  it('is neither a plain Escape nor another key of a composition', () => {
    expect(
      isComposingEscape({ key: 'Escape', code: 'Escape', keyCode: 27, isComposing: false }),
    ).toBe(false)
    expect(
      isComposingEscape({ key: 'Process', code: 'KeyN', keyCode: 229, isComposing: true }),
    ).toBe(false)
  })
})

describe('swallowHeldEscape', () => {
  const seen = vi.fn()

  afterEach(() => {
    press({ code: 'Escape', key: 'Escape' }, 'keyup')
    document.body.removeEventListener('keydown', seen)
    seen.mockClear()
  })

  it('keeps the repeats of the held Escape from whatever has the keyboard, until the key is released', () => {
    document.body.addEventListener('keydown', seen)
    swallowHeldEscape()

    const repeat = press({ code: 'Escape', key: 'Escape', repeat: true })
    press({ code: 'Escape', key: 'Escape', repeat: true })
    expect(seen).not.toHaveBeenCalled()
    expect(repeat.defaultPrevented).toBe(true)

    press({ code: 'Escape', key: 'Escape' }, 'keyup')
    press({ code: 'Escape', key: 'Escape', repeat: true })
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('lets a new press of Escape through, and every repeat after it', () => {
    document.body.addEventListener('keydown', seen)
    swallowHeldEscape()

    const fresh = press({ code: 'Escape', key: 'Escape' })
    press({ code: 'Escape', key: 'Escape', repeat: true })
    expect(fresh.defaultPrevented).toBe(false)
    expect(seen).toHaveBeenCalledTimes(2)
  })

  it('stops at any other key and when the window loses the keyboard', () => {
    document.body.addEventListener('keydown', seen)
    swallowHeldEscape()
    press({ code: 'KeyA', key: 'a' })
    press({ code: 'Escape', key: 'Escape', repeat: true })
    expect(seen).toHaveBeenCalledTimes(2)

    swallowHeldEscape()
    window.dispatchEvent(new Event('blur'))
    press({ code: 'Escape', key: 'Escape', repeat: true })
    expect(seen).toHaveBeenCalledTimes(3)
  })
})
