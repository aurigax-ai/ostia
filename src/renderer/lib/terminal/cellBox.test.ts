import { describe, expect, it, vi } from 'vitest'
import { createCellBoxCache, measureCellBox } from './cellBox'

function hostWithScreen(screenClass: string, height: number): HTMLElement {
  const parent = document.createElement('div')
  const host = document.createElement('div')
  host.innerHTML = `<div class="${screenClass}"></div>`
  parent.append(host)
  const screen = host.querySelector(`.${screenClass}`) as HTMLElement
  screen.getBoundingClientRect = () => ({ top: 28, height }) as DOMRect
  parent.getBoundingClientRect = () => ({ top: 20 }) as DOMRect
  return host
}

describe('measureCellBox', () => {
  it('reads the cell height and the screen offset inside the stack, for either engine', () => {
    for (const screen of ['xterm-screen', 'ghostty-screen']) {
      expect(measureCellBox(hostWithScreen(screen, 17 * 24), 24)).toEqual({
        cellHeight: 17,
        originTop: 8,
      })
    }
  })

  it('answers null while the screen has no height or there is no screen', () => {
    expect(measureCellBox(hostWithScreen('xterm-screen', 0), 24)).toBeNull()
    expect(measureCellBox(document.createElement('div'), 24)).toBeNull()
  })
})

describe('createCellBoxCache', () => {
  it('measures once for any number of reads', () => {
    const measure = vi.fn(() => ({ cellHeight: 17, originTop: 8 }))
    const cache = createCellBoxCache(document.createElement('div'), () => 24, measure)
    for (let frame = 0; frame < 120; frame++) cache.get()
    expect(measure).toHaveBeenCalledTimes(1)
    expect(cache.get()).toEqual({ cellHeight: 17, originTop: 8 })
  })

  it('measures again after it is invalidated', () => {
    const measure = vi
      .fn()
      .mockReturnValueOnce({ cellHeight: 17, originTop: 8 })
      .mockReturnValueOnce({ cellHeight: 21, originTop: 8 })
    const cache = createCellBoxCache(document.createElement('div'), () => 24, measure)
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
    const cache = createCellBoxCache(document.createElement('div'), () => 24, measure)
    expect(cache.get()).toBeNull()
    expect(cache.get()).toEqual({ cellHeight: 17, originTop: 8 })
    cache.get()
    expect(measure).toHaveBeenCalledTimes(2)
  })
})
