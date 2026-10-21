import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createPane, firstPaneId, splitOf, tabsOfPane } from '@/lib/layout/tree'
import { tabHistoryOf } from '@/lib/panes/tabHistory'
import { useLayoutStore } from './layoutStore'

const layoutOf = (ws: string) => useLayoutStore.getState().byWorkspace[ws]
const shown = (ws: string, id: string) => tabsOfPane(layoutOf(ws).root, id)?.activeId

describe('layoutStore close focus', () => {
  let layoutInit: ReturnType<typeof useLayoutStore.getState>

  beforeAll(() => {
    layoutInit = useLayoutStore.getState()
  })

  afterEach(() => {
    useLayoutStore.setState(layoutInit, true)
  })

  function tabs(ws: string, count: number): string[] {
    useLayoutStore.getState().ensure(ws)
    const ids = [firstPaneId(layoutOf(ws).root)]
    for (let i = 1; i < count; i++) {
      ids.push(useLayoutStore.getState().newTab(ws, ids[i - 1], 'terminal') as string)
    }
    return ids
  }

  it('returns to the tab that opened the closed one, past a tab in between', () => {
    const [a] = tabs('opener', 3)
    useLayoutStore.getState().focusPane('opener', a)
    const opened = useLayoutStore
      .getState()
      .openBrowserTab('opener', 'https://a.test', 'isolated', {
        beside: a,
      }) as string
    useLayoutStore.getState().closePane('opener', opened)
    expect(layoutOf('opener').activePaneId).toBe(a)
    expect(shown('opener', a)).toBe(a)
  })

  it('returns to the most recently used tab after switching around', () => {
    const [a, b, c, d] = tabs('recent', 4)
    for (const id of [a, d, b, c]) useLayoutStore.getState().focusPane('recent', id)
    useLayoutStore.getState().closePane('recent', c)
    expect(layoutOf('recent').activePaneId).toBe(b)
    useLayoutStore.getState().closePane('recent', b)
    expect(layoutOf('recent').activePaneId).toBe(d)
  })

  it('forgets the opener once the human switches away from the opened tab', () => {
    const [a, , c] = tabs('switched', 3)
    useLayoutStore.getState().focusPane('switched', a)
    const opened = useLayoutStore
      .getState()
      .openBrowserTab('switched', 'https://a.test', 'isolated', {
        beside: a,
      }) as string
    useLayoutStore.getState().focusPane('switched', c)
    useLayoutStore.getState().focusPane('switched', opened)
    useLayoutStore.getState().closePane('switched', opened)
    expect(layoutOf('switched').activePaneId).toBe(c)
  })

  it('forgets the opener of a background tab once another tab was shown first', () => {
    const [a, , c] = tabs('background', 3)
    useLayoutStore.getState().focusPane('background', a)
    const opened = useLayoutStore
      .getState()
      .openBrowserTab('background', 'https://a.test', 'isolated', {
        beside: a,
        background: true,
      }) as string
    useLayoutStore.getState().focusPane('background', c)
    useLayoutStore.getState().focusPane('background', opened)
    useLayoutStore.getState().closePane('background', opened)
    expect(layoutOf('background').activePaneId).toBe(c)
  })

  it('returns to the opener of a background tab shown straight from it', () => {
    const [a] = tabs('direct', 3)
    useLayoutStore.getState().focusPane('direct', a)
    const opened = useLayoutStore
      .getState()
      .openBrowserTab('direct', 'https://a.test', 'isolated', {
        beside: a,
        background: true,
      }) as string
    useLayoutStore.getState().focusPane('direct', opened)
    useLayoutStore.getState().closePane('direct', opened)
    expect(layoutOf('direct').activePaneId).toBe(a)
  })

  it('shows the choice without moving the keyboard when the closed tab did not hold it', () => {
    const [a, b] = tabs('keyboard', 3)
    const state = useLayoutStore.getState()
    state.focusPane('keyboard', a)
    state.focusPane('keyboard', b)
    const cell = createPane('terminal')
    useLayoutStore.setState((s) => ({
      byWorkspace: {
        ...s.byWorkspace,
        keyboard: {
          ...s.byWorkspace.keyboard,
          root: splitOf('horizontal', s.byWorkspace.keyboard.root, cell),
          activePaneId: cell.id,
        },
      },
    }))
    state.closePane('keyboard', b)
    expect(layoutOf('keyboard').activePaneId).toBe(cell.id)
    expect(shown('keyboard', a)).toBe(a)
  })

  it('forgets a released pane, its opener and the panes it opened', () => {
    const [a, b] = tabs('released', 3)
    const state = useLayoutStore.getState()
    state.focusPane('released', b)
    state.focusPane('released', a)
    const opened = state.openBrowserTab('released', 'https://a.test', 'isolated', {
      beside: a,
    }) as string
    expect(tabHistoryOf('released').openers[opened]).toBe(a)
    state.releasePane('released', opened)
    expect(tabHistoryOf('released').openers[opened]).toBeUndefined()
    expect(tabHistoryOf('released').recent).not.toContain(opened)
  })

  it('drops the history of a released workspace', () => {
    const [a] = tabs('gone', 3)
    useLayoutStore.getState().focusPane('gone', a)
    useLayoutStore.getState().openBrowserTab('gone', 'https://a.test', 'isolated', { beside: a })
    useLayoutStore.getState().release('gone')
    expect(tabHistoryOf('gone')).toEqual({ recent: [], openers: {} })
  })

  it('keeps the neighbour when there is no history', () => {
    useLayoutStore.getState().ensure('fresh')
    const a = firstPaneId(layoutOf('fresh').root)
    const b = useLayoutStore.getState().newTab('fresh', a, 'terminal') as string
    useLayoutStore.getState().closePane('fresh', b)
    expect(layoutOf('fresh').activePaneId).toBe(a)
  })
})
