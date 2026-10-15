import { describe, expect, it } from 'vitest'
import { parseDeviceTouch } from './deviceTouch'

describe('parseDeviceTouch', () => {
  it('reads a touch at a window point and a wheel at a view point', () => {
    expect(parseDeviceTouch({ type: 'touchMove', windowX: 1, windowY: 2.5, extra: true })).toEqual({
      type: 'touchMove',
      windowX: 1,
      windowY: 2.5,
    })
    expect(parseDeviceTouch({ type: 'wheel', viewX: 1, viewY: 2, deltaX: 0, deltaY: -3 })).toEqual({
      type: 'wheel',
      viewX: 1,
      viewY: 2,
      deltaX: 0,
      deltaY: -3,
    })
  })

  it('refuses another event type, a point in the other space, or a non-finite number', () => {
    for (const raw of [
      null,
      'touchStart',
      { type: 'mouseDown', windowX: 1, windowY: 1 },
      { type: 'touchStart', windowX: Number.NaN, windowY: 1 },
      { type: 'touchEnd', viewX: 1, viewY: 1 },
      { type: 'wheel', windowX: 1, windowY: 1, deltaX: 0, deltaY: 3 },
      { type: 'wheel', viewX: 1, viewY: 1, deltaY: 3 },
    ]) {
      expect(parseDeviceTouch(raw)).toBeNull()
    }
  })
})
