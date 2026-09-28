import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { findPane, firstPaneId, paneIds } from '../layout/tree'
import type { SplitNode } from '../layout/types'
import { useLayoutStore } from './layoutStore'
import { useSessionsStore } from './sessionsStore'

const emit = () => vi.mocked(window.pine.lifecycle.emit)
const layoutOf = (sid: string) => useLayoutStore.getState().bySession[sid]

function ensure(sid: string): string {
  useLayoutStore.getState().ensure(sid)
  return firstPaneId(layoutOf(sid).root)
}

function twoPanes(sid: string): { first: string; second: string } {
  const first = ensure(sid)
  useLayoutStore.getState().split(sid, first, 'horizontal')
  const ids = paneIds(layoutOf(sid).root)
  const second = ids.find((id) => id !== first) as string
  return { first, second }
}

describe('layoutStore', () => {
  let layoutInit: ReturnType<typeof useLayoutStore.getState>
  let sessionsInit: ReturnType<typeof useSessionsStore.getState>

  beforeAll(() => {
    layoutInit = useLayoutStore.getState()
    sessionsInit = useSessionsStore.getState()
  })

  beforeEach(() => {
    emit().mockClear()
  })

  afterEach(() => {
    useLayoutStore.setState(layoutInit, true)
    useSessionsStore.setState(sessionsInit, true)
    vi.restoreAllMocks()
  })

  it('starts with an empty bySession', () => {
    expect(useLayoutStore.getState().bySession).toEqual({})
  })

  describe('ensure', () => {
    it('creates a one-terminal-pane layout and emits pane-created for it', () => {
      const paneId = ensure('sess')
      const layout = layoutOf('sess')

      expect(paneIds(layout.root)).toEqual([paneId])
      expect(findPane(layout.root, paneId)?.kind).toBe('terminal')
      expect(layout.activePaneId).toBe(paneId)
      expect(emit()).toHaveBeenCalledTimes(1)
      expect(emit()).toHaveBeenCalledWith({ type: 'pane-created', sessionId: 'sess', paneId })
    })

    it('reads the session workDir from useSessionsStore into the new pane cwd', () => {
      useSessionsStore.setState({
        sessions: [
          { id: 'w1', name: 'proj', kind: 'terminal', workDir: '/home/me/proj', state: 'idle' },
        ],
        activeSessionId: 'w1',
      })

      const paneId = ensure('w1')
      expect(findPane(layoutOf('w1').root, paneId)?.cwd).toBe('/home/me/proj')
    })

    it('is a no-op on a second call (layout unchanged, no second emit)', () => {
      ensure('sess')
      const before = layoutOf('sess')
      emit().mockClear()

      useLayoutStore.getState().ensure('sess')

      expect(layoutOf('sess')).toBe(before)
      expect(emit()).not.toHaveBeenCalled()
    })
  })

  describe('split', () => {
    it('adds a pane, focuses the new pane, and emits pane-created for it', () => {
      const first = ensure('sess')
      emit().mockClear()

      useLayoutStore.getState().split('sess', first, 'horizontal')
      const layout = layoutOf('sess')
      const ids = paneIds(layout.root)
      const newId = ids.find((id) => id !== first) as string

      expect(ids).toHaveLength(2)
      expect(layout.activePaneId).toBe(newId)
      expect(emit()).toHaveBeenCalledTimes(1)
      expect(emit()).toHaveBeenCalledWith({
        type: 'pane-created',
        sessionId: 'sess',
        paneId: newId,
      })
    })

    it('is a no-op on an absent session (no emit)', () => {
      const before = useLayoutStore.getState().bySession

      useLayoutStore.getState().split('ghost', 'pane-x', 'horizontal')

      expect(useLayoutStore.getState().bySession).toBe(before)
      expect(emit()).not.toHaveBeenCalled()
    })

    it('on an existing session with a missing target pane, adds no pane and does not emit', () => {
      const paneId = ensure('sess')
      emit().mockClear()

      useLayoutStore.getState().split('sess', 'nonexistent-pane', 'horizontal')
      const layout = layoutOf('sess')

      expect(paneIds(layout.root)).toEqual([paneId])
      expect(layout.activePaneId).toBe(paneId)
      expect(emit()).not.toHaveBeenCalled()
    })
  })

  describe('closePane (conditional pane-closed emit)', () => {
    it('removes a real pane in a 2-pane layout, moves focus, and emits pane-closed once', () => {
      const { first, second } = twoPanes('sess')
      expect(layoutOf('sess').activePaneId).toBe(second)
      emit().mockClear()

      useLayoutStore.getState().closePane('sess', second)
      const layout = layoutOf('sess')

      expect(paneIds(layout.root)).toEqual([first])
      expect(findPane(layout.root, second)).toBeNull()
      expect(layout.activePaneId).toBe(first)
      expect(emit()).toHaveBeenCalledTimes(1)
      expect(emit()).toHaveBeenCalledWith({
        type: 'pane-closed',
        sessionId: 'sess',
        paneId: second,
      })
    })

    it("guard: closing the session's LAST pane is a tree no-op and emits NO pane-closed", () => {
      const only = ensure('sess')
      emit().mockClear()

      useLayoutStore.getState().closePane('sess', only)
      const layout = layoutOf('sess')

      expect(paneIds(layout.root)).toEqual([only])
      expect(findPane(layout.root, only)).not.toBeNull()
      expect(layout.activePaneId).toBe(only)
      expect(emit()).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'pane-closed' }))
      expect(emit()).not.toHaveBeenCalled()
    })

    it('emits no pane-closed for an id that never existed or was already closed', () => {
      const { second } = twoPanes('sess')
      useLayoutStore.getState().closePane('sess', second)
      emit().mockClear()

      useLayoutStore.getState().closePane('sess', second)
      useLayoutStore.getState().closePane('sess', 'pane-bogus')

      expect(emit()).not.toHaveBeenCalled()
    })

    it('is a no-op on an absent session (no emit)', () => {
      const before = useLayoutStore.getState().bySession

      useLayoutStore.getState().closePane('ghost', 'pane-x')

      expect(useLayoutStore.getState().bySession).toBe(before)
      expect(emit()).not.toHaveBeenCalled()
    })
  })

  describe('focusPane', () => {
    it('sets activePaneId and emits no lifecycle event', () => {
      const { first, second } = twoPanes('sess')
      expect(layoutOf('sess').activePaneId).toBe(second)
      emit().mockClear()

      useLayoutStore.getState().focusPane('sess', first)

      expect(layoutOf('sess').activePaneId).toBe(first)
      expect(emit()).not.toHaveBeenCalled()
    })
  })

  describe('resize', () => {
    it("updates the target split's sizes and emits no lifecycle event", () => {
      twoPanes('sess')
      const root = layoutOf('sess').root as SplitNode
      expect(root.type).toBe('split')
      emit().mockClear()

      useLayoutStore.getState().resize('sess', root.id, [3, 1])

      expect((layoutOf('sess').root as SplitNode).sizes).toEqual([3, 1])
      expect(emit()).not.toHaveBeenCalled()
    })
  })

  describe('movePane', () => {
    it('relocates the pane, sets activePaneId = source, and emits no lifecycle event', () => {
      const { first, second } = twoPanes('sess')
      emit().mockClear()
      useLayoutStore.getState().movePane('sess', second, first, 'top')
      const layout = layoutOf('sess')

      expect(paneIds(layout.root)).toEqual([second, first])
      expect((layout.root as SplitNode).direction).toBe('vertical')
      expect(layout.activePaneId).toBe(second)
      expect(emit()).not.toHaveBeenCalled()
    })
  })

  describe('setCwd', () => {
    it("updates the target pane's cwd and emits no lifecycle event", () => {
      const paneId = ensure('sess')
      emit().mockClear()

      useLayoutStore.getState().setCwd('sess', paneId, '/x')

      expect(findPane(layoutOf('sess').root, paneId)?.cwd).toBe('/x')
      expect(emit()).not.toHaveBeenCalled()
    })

    it('leaves the store state identical when the cwd is unchanged', () => {
      const paneId = ensure('sess')
      useLayoutStore.getState().setCwd('sess', paneId, '/x')
      const before = useLayoutStore.getState().bySession

      useLayoutStore.getState().setCwd('sess', paneId, '/x')

      expect(useLayoutStore.getState().bySession).toBe(before)
    })
  })

  describe('setUrl', () => {
    it("records the browser pane's url and is a no-op when unchanged", () => {
      ensure('sess')
      useLayoutStore.getState().openBrowser('sess', 'https://a.test/')
      const paneId = layoutOf('sess').activePaneId

      useLayoutStore.getState().setUrl('sess', paneId, 'https://a.test/next')
      expect(findPane(layoutOf('sess').root, paneId)?.url).toBe('https://a.test/next')

      const before = useLayoutStore.getState().bySession
      useLayoutStore.getState().setUrl('sess', paneId, 'https://a.test/next')
      expect(useLayoutStore.getState().bySession).toBe(before)
    })
  })

  describe('openFile', () => {
    it('with no editor pane, splits and creates an editor pane, emitting pane-created', () => {
      const terminal = ensure('sess')
      emit().mockClear()

      useLayoutStore.getState().openFile('sess', '/a/b/foo.ts')
      const layout = layoutOf('sess')
      const ids = paneIds(layout.root)
      const editorId = ids.find((id) => id !== terminal) as string
      const editor = findPane(layout.root, editorId)

      expect(ids).toHaveLength(2)
      expect(editor?.kind).toBe('editor')
      expect(editor?.filePath).toBe('/a/b/foo.ts')
      expect(editor?.title).toBe('foo.ts')
      expect(layout.activePaneId).toBe(editorId)
      expect(emit()).toHaveBeenCalledTimes(1)
      expect(emit()).toHaveBeenCalledWith({
        type: 'pane-created',
        sessionId: 'sess',
        paneId: editorId,
      })
    })

    it('with an existing editor pane, reuses it (no new pane, no pane-created emit)', () => {
      const terminal = ensure('sess')
      useLayoutStore.getState().openFile('sess', '/a/b/foo.ts')
      const editorId = paneIds(layoutOf('sess').root).find((id) => id !== terminal) as string
      emit().mockClear()

      useLayoutStore.getState().openFile('sess', '/c/d/bar.ts')
      const layout = layoutOf('sess')
      const reused = findPane(layout.root, editorId)

      expect(paneIds(layout.root)).toHaveLength(2)
      expect(reused?.kind).toBe('editor')
      expect(reused?.filePath).toBe('/c/d/bar.ts')
      expect(reused?.title).toBe('bar.ts')
      expect(layout.activePaneId).toBe(editorId)
      expect(emit()).not.toHaveBeenCalled()
    })
  })

  describe('openBrowser', () => {
    it('with no browser pane, splits and creates a browser pane, emitting pane-created', () => {
      const terminal = ensure('sess')
      emit().mockClear()

      useLayoutStore.getState().openBrowser('sess', 'https://example.com/path')
      const layout = layoutOf('sess')
      const ids = paneIds(layout.root)
      const browserId = ids.find((id) => id !== terminal) as string
      const browser = findPane(layout.root, browserId)

      expect(ids).toHaveLength(2)
      expect(browser?.kind).toBe('browser')
      expect(browser?.url).toBe('https://example.com/path')
      expect(browser?.title).toBe('example.com')
      expect(layout.activePaneId).toBe(browserId)
      expect(emit()).toHaveBeenCalledTimes(1)
      expect(emit()).toHaveBeenCalledWith({
        type: 'pane-created',
        sessionId: 'sess',
        paneId: browserId,
      })
    })

    it('with an existing browser pane, reuses it (no new pane, no pane-created emit)', () => {
      const terminal = ensure('sess')
      useLayoutStore.getState().openBrowser('sess', 'https://example.com')
      const browserId = paneIds(layoutOf('sess').root).find((id) => id !== terminal) as string
      emit().mockClear()

      useLayoutStore.getState().openBrowser('sess', 'https://other.example')
      const layout = layoutOf('sess')
      const reused = findPane(layout.root, browserId)

      expect(paneIds(layout.root)).toHaveLength(2)
      expect(reused?.kind).toBe('browser')
      expect(reused?.url).toBe('https://other.example')
      expect(reused?.title).toBe('other.example')
      expect(layout.activePaneId).toBe(browserId)
      expect(emit()).not.toHaveBeenCalled()
    })
  })

  describe('openSurface', () => {
    it('with no pane of that kind, splits and creates one, emitting pane-created', () => {
      const terminal = ensure('sess')
      emit().mockClear()

      useLayoutStore.getState().openSurface('sess', 'kanban')
      const layout = layoutOf('sess')
      const ids = paneIds(layout.root)
      const kanbanId = ids.find((id) => id !== terminal) as string
      const kanban = findPane(layout.root, kanbanId)

      expect(ids).toHaveLength(2)
      expect(kanban?.kind).toBe('kanban')
      expect(kanban?.title).toBe('Board')
      expect(layout.activePaneId).toBe(kanbanId)
      expect(emit()).toHaveBeenCalledTimes(1)
      expect(emit()).toHaveBeenCalledWith({
        type: 'pane-created',
        sessionId: 'sess',
        paneId: kanbanId,
      })
    })

    it('with an existing pane of that kind, reuses it (no new pane, no pane-created emit)', () => {
      const terminal = ensure('sess')
      useLayoutStore.getState().openSurface('sess', 'wiki')
      const wikiId = paneIds(layoutOf('sess').root).find((id) => id !== terminal) as string
      emit().mockClear()

      useLayoutStore.getState().openSurface('sess', 'wiki')
      const layout = layoutOf('sess')

      expect(paneIds(layout.root)).toHaveLength(2)
      expect(layout.activePaneId).toBe(wikiId)
      expect(emit()).not.toHaveBeenCalled()
    })
  })

  describe('removeSession', () => {
    it('drops the layout and emits pane-closed for each pane it held', () => {
      const { first, second } = twoPanes('sess')
      emit().mockClear()

      useLayoutStore.getState().removeSession('sess')

      expect(layoutOf('sess')).toBeUndefined()
      expect('sess' in useLayoutStore.getState().bySession).toBe(false)
      expect(emit()).toHaveBeenCalledTimes(2)
      expect(emit()).toHaveBeenCalledWith({ type: 'pane-closed', sessionId: 'sess', paneId: first })
      expect(emit()).toHaveBeenCalledWith({
        type: 'pane-closed',
        sessionId: 'sess',
        paneId: second,
      })
    })

    it('is a no-op on an absent session (no emit)', () => {
      const before = useLayoutStore.getState().bySession

      useLayoutStore.getState().removeSession('ghost')

      expect(useLayoutStore.getState().bySession).toBe(before)
      expect(emit()).not.toHaveBeenCalled()
    })
  })

  describe('absent-session guard', () => {
    it('leaves state untouched and emits nothing for actions on an unknown session', () => {
      const before = useLayoutStore.getState().bySession

      const store = useLayoutStore.getState()
      store.split('ghost', 'p', 'horizontal')
      store.closePane('ghost', 'p')
      store.focusPane('ghost', 'p')
      store.resize('ghost', 'sp', [1, 1])
      store.movePane('ghost', 'a', 'b', 'center')
      store.setCwd('ghost', 'p', '/x')
      store.openFile('ghost', '/f')
      store.openBrowser('ghost', 'https://x')
      store.openSurface('ghost', 'kanban')

      expect(useLayoutStore.getState().bySession).toBe(before)
      expect(emit()).not.toHaveBeenCalled()
    })
  })

  describe('hydrate', () => {
    const pane = (id: string) => ({
      type: 'pane' as const,
      id,
      title: 'zsh',
      kind: 'terminal' as const,
    })

    it('installs a restored layout for each session', () => {
      useLayoutStore.getState().hydrate({
        s40: { root: pane('pane-40'), activePaneId: 'pane-40', zoomedPaneId: null },
      })

      expect(layoutOf('s40')).toEqual({
        root: pane('pane-40'),
        activePaneId: 'pane-40',
        zoomedPaneId: null,
      })
    })

    it('replaces any layouts already built, rather than merging into them', () => {
      ensure('stale')

      useLayoutStore.getState().hydrate({
        s40: { root: pane('pane-40'), activePaneId: 'pane-40', zoomedPaneId: null },
      })

      expect(Object.keys(useLayoutStore.getState().bySession)).toEqual(['s40'])
    })

    it('announces every restored pane so main can mint its identity', () => {
      useLayoutStore.getState().hydrate({
        s40: {
          root: {
            type: 'split',
            id: 'split-1',
            direction: 'horizontal',
            children: [pane('pane-1'), pane('pane-2')],
            sizes: [1, 1],
          },
          activePaneId: 'pane-1',
          zoomedPaneId: null,
        },
      })

      const emitted = emit().mock.calls.map((c) => c[0])
      expect(emitted).toContainEqual({ type: 'pane-created', sessionId: 's40', paneId: 'pane-1' })
      expect(emitted).toContainEqual({ type: 'pane-created', sessionId: 's40', paneId: 'pane-2' })
    })

    it('leaves ensure a no-op afterwards, so the first render cannot overwrite a restore', () => {
      useLayoutStore.getState().hydrate({
        s40: { root: pane('pane-40'), activePaneId: 'pane-40', zoomedPaneId: null },
      })

      useLayoutStore.getState().ensure('s40')

      expect(paneIds(layoutOf('s40').root)).toEqual(['pane-40'])
    })
  })
})
