import { afterEach, describe, expect, it } from 'vitest'
import {
  POINTER_VIEW_MS,
  isPanePointedAt,
  leavePane,
  pointAtPane,
  resetPointerView,
} from './pointerView'

afterEach(resetPointerView)

describe('pointerView', () => {
  it('counts a pane as pointed at only while the pointer moved over it recently', () => {
    pointAtPane('a', 1000)
    expect(isPanePointedAt('a', 1000 + POINTER_VIEW_MS)).toBe(true)
    expect(isPanePointedAt('a', 1001 + POINTER_VIEW_MS)).toBe(false)
    expect(isPanePointedAt('b', 1000)).toBe(false)
  })

  it('forgets a pane the pointer left, but not when another pane is the one pointed at', () => {
    pointAtPane('a', 1000)
    leavePane('b')
    expect(isPanePointedAt('a', 1000)).toBe(true)
    leavePane('a')
    expect(isPanePointedAt('a', 1000)).toBe(false)
  })
})
