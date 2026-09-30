import { beforeEach, describe, expect, it } from 'vitest'
import { createPane, equalizeSizes, resetIds, slotCount, splitOf, tabsOf } from './tree'
import type { SplitNode } from './types'

beforeEach(() => resetIds())

describe('slotCount', () => {
  it('counts a tab stack as one slot', () => {
    const a = createPane()
    const b = createPane()
    const c = createPane()
    expect(slotCount(a)).toBe(1)
    expect(slotCount(splitOf('horizontal', tabsOf(b.id, a, b), c))).toBe(2)
  })
})

describe('equalizeSizes', () => {
  it('sets every split, nested ones included, to equal shares', () => {
    const inner: SplitNode = { ...splitOf('vertical', createPane(), createPane()), sizes: [3, 1] }
    const root: SplitNode = { ...splitOf('horizontal', createPane(), inner), sizes: [5, 1] }
    const next = equalizeSizes(root) as SplitNode
    expect(next.sizes).toEqual([1, 1])
    expect((next.children[1] as SplitNode).sizes).toEqual([1, 1])
  })

  it('returns the same tree when it is already equal', () => {
    const root = splitOf('horizontal', createPane(), createPane())
    expect(equalizeSizes(root)).toBe(root)
  })

  it('returns a pane unchanged', () => {
    const pane = createPane()
    expect(equalizeSizes(pane)).toBe(pane)
  })
})
