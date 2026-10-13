import { describe, expect, it } from 'vitest'
import { cellDropTarget, dropZoneAt, endedOutside, paneDropTarget, tabDropTarget } from './dropZone'

const pane = { left: 100, top: 50, width: 800, height: 1000 }

describe('dropZoneAt', () => {
  it('adds a tab in the middle of the pane', () => {
    expect(dropZoneAt(pane, 500, 550)).toBe('center')
  })

  it('splits toward each edge inside its band, measured on the pane frame', () => {
    expect(dropZoneAt(pane, 150, 550)).toBe('left')
    expect(dropZoneAt(pane, 860, 550)).toBe('right')
    expect(dropZoneAt(pane, 500, 100)).toBe('top')
    expect(dropZoneAt(pane, 500, 1000)).toBe('bottom')
  })

  it('reaches the bottom of a tall pane, not only its top half', () => {
    expect(dropZoneAt(pane, 500, 700)).toBe('center')
    expect(dropZoneAt(pane, 500, 800)).toBe('bottom')
  })

  it('resolves a corner to the nearer edge', () => {
    expect(dropZoneAt(pane, 110, 120)).toBe('left')
    expect(dropZoneAt(pane, 180, 60)).toBe('top')
    expect(dropZoneAt(pane, 895, 1045)).toBe('bottom')
  })

  it('keeps a center and four edges on a tiny pane', () => {
    const tiny = { left: 0, top: 0, width: 60, height: 60 }
    expect(dropZoneAt(tiny, 30, 30)).toBe('center')
    expect(dropZoneAt(tiny, 5, 30)).toBe('left')
    expect(dropZoneAt(tiny, 55, 30)).toBe('right')
    expect(dropZoneAt(tiny, 30, 58)).toBe('bottom')
  })

  it('treats a point outside the frame as its nearest edge and a 0×0 frame as center', () => {
    expect(dropZoneAt(pane, 20, 550)).toBe('left')
    expect(dropZoneAt({ left: 0, top: 0, width: 0, height: 0 }, 0, 0)).toBe('center')
  })
})

describe('paneDropTarget', () => {
  const stack = { tabIds: ['a', 'b'], shownId: 'b' }

  it('targets the shown tab when the dragged pane comes from elsewhere', () => {
    expect(paneDropTarget(stack, 'x', 'right')).toEqual({ targetId: 'b', zone: 'right' })
    expect(paneDropTarget(stack, null, 'center')).toEqual({ targetId: 'b', zone: 'center' })
  })

  it('splits a tab out of its own stack beside the rest of the stack', () => {
    expect(paneDropTarget(stack, 'b', 'left')).toEqual({ targetId: 'a', zone: 'left' })
  })

  it('does nothing when a tab is dropped back in the middle of its own stack', () => {
    expect(paneDropTarget(stack, 'b', 'center')).toBeNull()
  })

  it('does nothing when a lone pane is dropped on itself', () => {
    expect(paneDropTarget({ tabIds: ['a'], shownId: 'a' }, 'a', 'right')).toBeNull()
  })
})

describe('tabDropTarget', () => {
  it('drops after the last tab when the strip is hovered past the tabs', () => {
    expect(tabDropTarget(['a', 'b'], 'x', null)).toEqual({ targetId: 'b', after: true })
  })

  it('reorders within a stack and ignores drops that keep the order', () => {
    expect(tabDropTarget(['a', 'b', 'c'], 'a', { targetId: 'c', after: true })).toEqual({
      targetId: 'c',
      after: true,
    })
    expect(tabDropTarget(['a', 'b', 'c'], 'a', { targetId: 'b', after: false })).toBeNull()
    expect(tabDropTarget(['a', 'b'], 'a', { targetId: 'a', after: true })).toBeNull()
    expect(tabDropTarget(['a'], 'a', null)).toBeNull()
  })
})

describe('endedOutside', () => {
  const viewport = { width: 1280, height: 800 }
  const origin = { x: 160, y: 100 }
  const end = { dropEffect: 'none', origin }

  it('is true when the drag ended outside the window', () => {
    expect(endedOutside({ ...end, point: { x: 1500, y: 400 } }, viewport)).toBe(true)
    expect(endedOutside({ ...end, point: { x: 400, y: 60 } }, viewport)).toBe(true)
  })

  it('is false for a cancel or a refused drop inside the window', () => {
    expect(endedOutside({ ...end, point: { x: 500, y: 400 } }, viewport)).toBe(false)
  })

  it('measures the end point in the drag’s own coordinates, not the window position', () => {
    expect(
      endedOutside({ ...end, origin: { x: 0, y: 0 }, point: { x: 310, y: 46 } }, viewport),
    ).toBe(false)
  })

  it('is false when something accepted the drop', () => {
    expect(endedOutside({ ...end, dropEffect: 'move', point: { x: 1500, y: 400 } }, viewport)).toBe(
      false,
    )
  })
})

describe('cellDropTarget', () => {
  it('targets the cell on every zone for a pane from elsewhere', () => {
    expect(cellDropTarget('c', ['a', 'split-1'], 'x', 'left')).toEqual({
      targetId: 'c',
      zone: 'left',
    })
    expect(cellDropTarget('c', ['a', 'split-1'], 'x', 'center')).toEqual({
      targetId: 'c',
      zone: 'center',
    })
  })

  it('refuses a drop on the cell itself and a center drop of a tab of the same stack', () => {
    expect(cellDropTarget('c', ['a', 'split-1'], 'c', 'right')).toBeNull()
    expect(cellDropTarget('c', ['a', 'split-1'], 'a', 'center')).toBeNull()
    expect(cellDropTarget('c', ['a', 'split-1'], 'a', 'bottom')).toEqual({
      targetId: 'c',
      zone: 'bottom',
    })
  })

  it('lets a sibling segment be pulled out into its own tab with a center drop', () => {
    expect(cellDropTarget('c', ['a', 'split-1'], 'b', 'center')).toEqual({
      targetId: 'c',
      zone: 'center',
    })
  })
})
