import { describe, expect, it, vi } from 'vitest'
import { createCellBoxCache, measureCellBox } from './cellBox'

function hostWithRows(rowHeight: number): HTMLElement {
  const parent = document.createElement('div')
  const host = document.createElement('div')
  host.innerHTML = '<div class="xterm-screen"><div class="xterm-rows"><div></div></div></div>'
  parent.append(host)
  const row = host.querySelector('.xterm-rows > div') as HTMLElement
  Object.defineProperty(row, 'offsetHeight', { value: rowHeight })
  const screen = host.querySelector('.xterm-screen') as HTMLElement
  screen.getBoundingClientRect = () => ({ top: 28 }) as DOMRect
  parent.getBoundingClientRect = () => ({ top: 20 }) as DOMRect
  return host
}

describe('measureCellBox', () => {
  it('reads the row height and the screen offset inside the stack', () => {
    expect(measureCellBox(hostWithRows(17))).toEqual({ cellHeight: 17, originTop: 8 })
  })

  it('answers null while no row has a height', () => {
    expect(measureCellBox(hostWithRows(0))).toBeNull()
    expect(measureCellBox(document.createElement('div'))).toBeNull()
  })
})

describe('createCellBoxCache', () => {
  it('measures once for any number of reads', () => {
    const measure = vi.fn(() => ({ cellHeight: 17, originTop: 8 }))
    const cache = createCellBoxCache(document.createElement('div'), measure)
    for (let frame = 0; frame < 120; frame++) cache.get()
    expect(measure).toHaveBeenCalledTimes(1)
    expect(cache.get()).toEqual({ cellHeight: 17, originTop: 8 })
  })

  it('measures again after it is invalidated', () => {
    const measure = vi
      .fn()
      .mockReturnValueOnce({ cellHeight: 17, originTop: 8 })
      .mockReturnValueOnce({ cellHeight: 21, originTop: 8 })
    const cache = createCellBoxCache(document.createElement('div'), measure)
    cache.get()
    cache.invalidate()
    expect(cache.get()).toEqual({ cellHeight: 21, originTop: 8 })
    expect(measure).toHaveBeenCalledTimes(2)
  })

  it('keeps measuring until the rows have a height', () => {
    const measure = vi
      .fn()
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({ cellHeight: 17, originTop: 8 })
    const cache = createCellBoxCache(document.createElement('div'), measure)
    expect(cache.get()).toBeNull()
    expect(cache.get()).toEqual({ cellHeight: 17, originTop: 8 })
    cache.get()
    expect(measure).toHaveBeenCalledTimes(2)
  })
})
