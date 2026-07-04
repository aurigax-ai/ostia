import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { findPane, firstPaneId, paneIds } from '../layout/tree'
import type { SplitNode } from '../layout/types'
import { useLayoutStore } from './layoutStore'
import { useSessionsStore } from './sessionsStore'

/**
 * layoutStore wraps the PURE tree.ts transforms AND emits control-plane lifecycle events
 * via `window.pine.lifecycle.emit`. These tests assert BOTH sides: the real tree shape
 * (via paneIds/findPane) and the emitted `pane-created`/`pane-closed` events. The two
 * meaningful cases are the CONDITIONAL pane-closed emit (last-pane guard, both branches)
 * and openFile's editor-pane reuse.
 *
 * The `dom` setup (test/setup.ts) stubs a fresh typed `window.pine` before every test, so
 * `window.pine.lifecycle.emit` is a clean vi.fn() at the start of each test body.
 */

const emit = () => vi.mocked(window.pine.lifecycle.emit)
const layoutOf = (sid: string) => useLayoutStore.getState().bySession[sid]

/** ensure a session and return its single pane's id. */
function ensure(sid: string): string {
  useLayoutStore.getState().ensure(sid)
  return firstPaneId(layoutOf(sid).root)
}

/** ensure + one horizontal split → a 2-pane layout; return both pane ids. */
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
    // Snapshot pristine state (data + stable action fns) before any test mutates.
    layoutInit = useLayoutStore.getState()
    sessionsInit = useSessionsStore.getState()
  })

  beforeEach(() => {
    // setup.ts stubs a fresh window.pine (with a new emit vi.fn) before this hook runs.
    emit().mockClear()
  })

  afterEach(() => {
    // Restore stores to pristine (replace, not merge) so panes/sessions don't bleed.
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

      // splitPane returns newPaneId=null when the target isn't found → no new pane, no emit.
      expect(paneIds(layout.root)).toEqual([paneId])
      expect(layout.activePaneId).toBe(paneId)
      expect(emit()).not.toHaveBeenCalled()
    })
  })

  describe('closePane (conditional pane-closed emit)', () => {
    it('removes a real pane in a 2-pane layout, moves focus, and emits pane-closed once', () => {
      const { first, second } = twoPanes('sess')
      // The split left `second` active.
      expect(layoutOf('sess').activePaneId).toBe(second)
      emit().mockClear()

      useLayoutStore.getState().closePane('sess', second)
      const layout = layoutOf('sess')

      expect(paneIds(layout.root)).toEqual([first])
      expect(findPane(layout.root, second)).toBeNull()
      // Closed pane was active → focus moves to the first remaining pane.
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

      // Pane can't be removed — it's still there.
      expect(paneIds(layout.root)).toEqual([only])
      expect(findPane(layout.root, only)).not.toBeNull()
      expect(layout.activePaneId).toBe(only)
      expect(emit()).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'pane-closed' }))
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
      // 2-pane horizontal split, order [first, second]. Drop `second` onto `first`'s top
      // edge → a vertical split ordered [second, first].
      useLayoutStore.getState().movePane('sess', second, first, 'top')
      const layout = layoutOf('sess')

      expect(paneIds(layout.root)).toEqual([second, first])
      expect((layout.root as SplitNode).direction).toBe('vertical')
      expect(layout.activePaneId).toBe(second)
      expect(emit()).not.toHaveBeenCalled()
    })
  })

  describe('removePane', () => {
    it('delegates to closePane — emits pane-closed exactly once for a real pane', () => {
      const { first, second } = twoPanes('sess')
      emit().mockClear()

      useLayoutStore.getState().removePane('sess', second)
      const layout = layoutOf('sess')

      expect(paneIds(layout.root)).toEqual([first])
      expect(findPane(layout.root, second)).toBeNull()
      expect(emit()).toHaveBeenCalledTimes(1)
      expect(emit()).toHaveBeenCalledWith({
        type: 'pane-closed',
        sessionId: 'sess',
        paneId: second,
      })
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
})
