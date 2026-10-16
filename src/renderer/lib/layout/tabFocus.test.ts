import { beforeEach, describe, expect, it } from 'vitest'
import { focusAfterClose, showAfterClose } from './tabFocus'
import { createPane, resetIds, tabsOf } from './tree'
import type { LayoutNode } from './types'

beforeEach(() => resetIds())

function stack(shown: number, count: number): { root: LayoutNode; ids: string[] } {
  const panes = Array.from({ length: count }, () => createPane())
  const ids = panes.map((p) => p.id)
  return { root: tabsOf(ids[shown], ...panes), ids }
}

describe('focusAfterClose', () => {
  it('returns the opener before any switch', () => {
    const { root, ids } = stack(2, 4)
    expect(focusAfterClose(root, ids[2], { recent: [], openers: { [ids[2]]: ids[0] } })).toBe(
      ids[0],
    )
  })

  it('prefers the opener over the most recently used tab', () => {
    const { root, ids } = stack(2, 4)
    const history = { recent: [ids[3], ids[1]], openers: { [ids[2]]: ids[0] } }
    expect(focusAfterClose(root, ids[2], history)).toBe(ids[0])
  })

  it('returns the most recently used tab when there is no opener', () => {
    const { root, ids } = stack(2, 4)
    expect(focusAfterClose(root, ids[2], { recent: [ids[2], ids[0], ids[3]], openers: {} })).toBe(
      ids[0],
    )
  })

  it('falls back to the recent tab when the opener is gone from the stack', () => {
    const { root, ids } = stack(2, 3)
    const history = { recent: [ids[1]], openers: { [ids[2]]: 'closed' } }
    expect(focusAfterClose(root, ids[2], history)).toBe(ids[1])
  })

  it('returns null without history so the neighbour applies', () => {
    const { root, ids } = stack(2, 4)
    expect(focusAfterClose(root, ids[2], { recent: [ids[2]], openers: {} })).toBeNull()
  })

  it('ignores history of another tab stack', () => {
    const { root, ids } = stack(1, 2)
    const other = createPane()
    const history = { recent: [other.id], openers: { [ids[1]]: other.id } }
    expect(focusAfterClose(root, ids[1], history)).toBeNull()
  })

  it('returns null when the closed tab is not the shown one', () => {
    const { root, ids } = stack(0, 3)
    expect(focusAfterClose(root, ids[2], { recent: [ids[1]], openers: {} })).toBeNull()
  })

  it('returns null for a pane that is not in a tab stack', () => {
    const pane = createPane()
    expect(focusAfterClose(pane, pane.id, { recent: [], openers: {} })).toBeNull()
  })
})

describe('showAfterClose', () => {
  it('returns the same root without a choice or when the tab is already shown', () => {
    const { root, ids } = stack(1, 3)
    expect(showAfterClose(root, null)).toBe(root)
    expect(showAfterClose(root, ids[1])).toBe(root)
  })

  it('shows the chosen tab', () => {
    const { root, ids } = stack(1, 3)
    expect(showAfterClose(root, ids[2])).toMatchObject({ activeId: ids[2] })
  })
})
