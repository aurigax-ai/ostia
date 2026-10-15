import { beforeEach, describe, expect, it } from 'vitest'
import { paneInDirection } from './focusDirection'
import { allPanes, createPane, resetIds, splitOf, tabsOf } from './tree'
import type { LayoutNode } from './types'

beforeEach(() => resetIds())

describe('paneInDirection', () => {
  const grid = (): LayoutNode => {
    const left = createPane('terminal', 'left')
    const topRight = createPane('terminal', 'top-right')
    const bottomRight = createPane('terminal', 'bottom-right')
    return splitOf('horizontal', left, splitOf('vertical', topRight, bottomRight))
  }

  it('returns the pane that shares the edge in the asked direction', () => {
    const root = grid()
    const [left, topRight, bottomRight] = allPanes(root).map((p) => p.id)
    expect(paneInDirection(root, left, 'right')).toBe(topRight)
    expect(paneInDirection(root, topRight, 'down')).toBe(bottomRight)
    expect(paneInDirection(root, bottomRight, 'up')).toBe(topRight)
    expect(paneInDirection(root, bottomRight, 'left')).toBe(left)
  })

  it('returns null at the outer edge and for a lone pane', () => {
    const root = grid()
    const [left, topRight] = allPanes(root).map((p) => p.id)
    expect(paneInDirection(root, left, 'left')).toBeNull()
    expect(paneInDirection(root, topRight, 'up')).toBeNull()
    const lone = createPane()
    expect(paneInDirection(lone, lone.id, 'right')).toBeNull()
  })

  it('follows split sizes and picks the neighbour nearest the middle of the pane', () => {
    const a = createPane()
    const b = createPane()
    const c = createPane()
    const d = createPane()
    const right = { ...splitOf('vertical', b, c, d), sizes: [2, 1, 1] }
    const root = splitOf('horizontal', a, right)
    expect(paneInDirection(root, a.id, 'right')).toBe(c.id)
  })

  it('moves to the shown tab of a tab stack and from any tab of one', () => {
    const a = createPane()
    const t1 = createPane()
    const t2 = createPane()
    const root = splitOf('horizontal', a, tabsOf(t2.id, t1, t2))
    expect(paneInDirection(root, a.id, 'right')).toBe(t2.id)
    expect(paneInDirection(root, t1.id, 'left')).toBe(a.id)
  })
})
