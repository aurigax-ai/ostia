import { describe, expect, it } from 'vitest'
import { bellActions, createBellThrottle } from './bell'

describe('bellActions', () => {
  it('raises attention for a pane you are not viewing, and sounds only in sound mode', () => {
    expect(bellActions('attention', false)).toEqual({ attention: true, sound: false })
    expect(bellActions('attention', true)).toEqual({ attention: false, sound: false })
    expect(bellActions('sound', false)).toEqual({ attention: true, sound: true })
    expect(bellActions('sound', true)).toEqual({ attention: false, sound: true })
  })

  it('does nothing when the bell is off', () => {
    expect(bellActions('off', false)).toEqual({ attention: false, sound: false })
  })
})

describe('createBellThrottle', () => {
  it('lets one sound through per interval so a flood of BEL stays one beep', () => {
    const allow = createBellThrottle(500)
    expect(allow(1000)).toBe(true)
    expect(allow(1200)).toBe(false)
    expect(allow(1499)).toBe(false)
    expect(allow(1500)).toBe(true)
  })
})
