import { describe, expect, it } from 'vitest'
import { setPinned } from './workspaceOrder'

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
