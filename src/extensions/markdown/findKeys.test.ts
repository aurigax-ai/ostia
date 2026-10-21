import { describe, expect, it } from 'vitest'
import { findKeyOf } from './findKeys'

function key(init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return {
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    ...init,
  } as KeyboardEvent
}

describe('findKeyOf', () => {
  it('opens find with the primary modifier and F, and steps with F3', () => {
    expect(findKeyOf(key({ key: 'f', ctrlKey: true }), false)).toBe('open')
    expect(findKeyOf(key({ key: 'f', metaKey: true }), true)).toBe('open')
    expect(findKeyOf(key({ key: 'f', metaKey: true }), false)).toBeNull()
    expect(findKeyOf(key({ key: 'F3' }), false)).toBe('next')
    expect(findKeyOf(key({ key: 'F3', shiftKey: true }), false)).toBe('previous')
  })

  it('steps to the next and previous match with the primary modifier and G', () => {
    expect(findKeyOf(key({ key: 'g', ctrlKey: true }), false)).toBe('next')
    expect(findKeyOf(key({ key: 'G', ctrlKey: true, shiftKey: true }), false)).toBe('previous')
    expect(findKeyOf(key({ key: 'g', metaKey: true }), true)).toBe('next')
    expect(findKeyOf(key({ key: 'g', metaKey: true, shiftKey: true }), true)).toBe('previous')
  })

  it('ignores other keys, Shift with F and a held Alt', () => {
    expect(findKeyOf(key({ key: 'g' }), false)).toBeNull()
    expect(findKeyOf(key({ key: 'f', ctrlKey: true, shiftKey: true }), false)).toBeNull()
    expect(findKeyOf(key({ key: 'g', ctrlKey: true, altKey: true }), false)).toBeNull()
  })
})
