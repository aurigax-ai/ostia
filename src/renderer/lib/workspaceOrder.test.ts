import { describe, expect, it } from 'vitest'
import { moveBy, moveTo, setPinned } from './workspaceOrder'

interface W {
  id: string
  pinned?: boolean
}

const ids = (list: W[]) => list.map((w) => (w.pinned ? `${w.id}*` : w.id))
const list = (...spec: string[]): W[] =>
  spec.map((s) => (s.endsWith('*') ? { id: s.slice(0, -1), pinned: true } : { id: s }))

describe('setPinned', () => {
  it('pins a workspace to the end of the pinned group at the top', () => {
    expect(ids(setPinned(list('a*', 'b', 'c'), 'c', true))).toEqual(['a*', 'c*', 'b'])
  })

  it('unpins to the top of the unpinned group', () => {
    expect(ids(setPinned(list('a*', 'b*', 'c'), 'a', false))).toEqual(['b*', 'a', 'c'])
  })

  it('returns the same list when nothing changes', () => {
    const l = list('a*', 'b')
    expect(setPinned(l, 'a', true)).toBe(l)
    expect(setPinned(l, 'missing', true)).toBe(l)
  })
})

describe('moveTo / moveBy', () => {
  it('moves within the unpinned group and never above a pinned one', () => {
    const l = list('a*', 'b', 'c', 'd')
    expect(ids(moveTo(l, 'd', 1))).toEqual(['a*', 'd', 'b', 'c'])
    expect(ids(moveTo(l, 'd', 0))).toEqual(['a*', 'd', 'b', 'c'])
  })

  it('keeps a pinned workspace inside the pinned group', () => {
    expect(ids(moveTo(list('a*', 'b*', 'c'), 'a', 9))).toEqual(['b*', 'a*', 'c'])
  })

  it('moves one step up or down and stops at the group edge', () => {
    const l = list('a', 'b', 'c')
    expect(ids(moveBy(l, 'b', -1))).toEqual(['b', 'a', 'c'])
    expect(ids(moveBy(l, 'c', 1))).toEqual(['a', 'b', 'c'])
    expect(moveBy(l, 'a', -1)).toBe(l)
  })
})
