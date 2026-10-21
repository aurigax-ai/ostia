import { describe, expect, it } from 'vitest'
import { type HudInputs, hudVisible } from './hudState'

const idle: HudInputs = {
  paused: false,
  active: false,
  hovered: false,
  focusWithin: false,
  menuOpen: false,
}

describe('hudVisible', () => {
  it('hides while playing with no activity', () => {
    expect(hudVisible(idle)).toBe(false)
  })

  it('shows while paused', () => {
    expect(hudVisible({ ...idle, paused: true })).toBe(true)
  })

  it('shows on activity, hover, focus inside or an open menu', () => {
    expect(hudVisible({ ...idle, active: true })).toBe(true)
    expect(hudVisible({ ...idle, hovered: true })).toBe(true)
    expect(hudVisible({ ...idle, focusWithin: true })).toBe(true)
    expect(hudVisible({ ...idle, menuOpen: true })).toBe(true)
  })
})
