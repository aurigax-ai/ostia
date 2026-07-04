import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLayoutStore } from './layoutStore'
import { useSessionsStore } from './sessionsStore'

/**
 * sessionsStore owns the sidebar's session list and cross-wires into layoutStore:
 * `addSession`/`closeSession` call `useLayoutStore.ensure`/`removeSession`. These tests
 * assert BOTH the real session state (array, names, activeSessionId) AND those cross-store
 * calls. The two meaningful invariants are the NEVER-ZERO re-seed (closing the last session
 * spawns a fresh '~' home) and the LEFT-neighbour fallback when the active session closes.
 *
 * layoutStore.ensure/removeSession are spied to no-ops: it isolates sessionsStore from real
 * layout mutation AND from the lifecycle events those layout actions emit through window.pine.
 * The `dom` setup (test/setup.ts) still stubs a fresh window.pine before every test, so
 * sessionsStore's own `window.pine.lifecycle.emit` calls are harmless.
 */

const ensureMock = () => vi.mocked(useLayoutStore.getState().ensure)
const removeSessionMock = () => vi.mocked(useLayoutStore.getState().removeSession)
const sessions = () => useSessionsStore.getState().sessions
const activeId = () => useSessionsStore.getState().activeSessionId

describe('sessionsStore', () => {
  let sessionsInit: ReturnType<typeof useSessionsStore.getState>
  let layoutInit: ReturnType<typeof useLayoutStore.getState>

  beforeAll(() => {
    // Snapshot pristine state (data + stable action fns) before any test mutates.
    sessionsInit = useSessionsStore.getState()
    layoutInit = useLayoutStore.getState()
  })

  beforeEach(() => {
    // Spy on the layout actions sessionsStore reaches into. mockImplementation keeps them
    // pure no-ops so no real layout is built and no lifecycle events fire from them.
    vi.spyOn(useLayoutStore.getState(), 'ensure').mockImplementation(() => {})
    vi.spyOn(useLayoutStore.getState(), 'removeSession').mockImplementation(() => {})
  })

  afterEach(() => {
    // Restore both stores to pristine (replace, not merge) so sessions/layouts don't bleed.
    useSessionsStore.setState(sessionsInit, true)
    useLayoutStore.setState(layoutInit, true)
    vi.restoreAllMocks()
  })

  it('starts with exactly one home session anchored at ~, and it is active', () => {
    expect(sessions()).toHaveLength(1)
    const only = sessions()[0]
    expect(only.workDir).toBe('~')
    expect(only.name).toBe('home')
    expect(activeId()).toBe(only.id)
  })

  describe('addSession', () => {
    it('appends a focused session named from its workDir and ensures its layout', () => {
      useSessionsStore.getState().addSession('/home/me/projects/app')

      expect(sessions()).toHaveLength(2)
      const added = sessions()[1]
      expect(added.workDir).toBe('/home/me/projects/app')
      expect(added.name).toBe('app')
      // The new session is focused.
      expect(activeId()).toBe(added.id)
      // Cross-store: layout is ensured for the new session id.
      expect(ensureMock()).toHaveBeenCalledWith(added.id)
    })

    it('defaults workDir to ~ (name "home") when called with no arg', () => {
      useSessionsStore.getState().addSession()

      expect(sessions()).toHaveLength(2)
      const added = sessions()[1]
      expect(added.workDir).toBe('~')
      expect(added.name).toBe('home')
      expect(activeId()).toBe(added.id)
      // Cross-store: even the default-anchored session ensures its layout.
      expect(ensureMock()).toHaveBeenCalledWith(added.id)
    })
  })

  describe('setActive', () => {
    it('sets activeSessionId to the given id', () => {
      const first = sessions()[0]
      useSessionsStore.getState().addSession('/x/y')
      expect(activeId()).not.toBe(first.id)

      useSessionsStore.getState().setActive(first.id)

      expect(activeId()).toBe(first.id)
    })
  })

  describe('setWorkDir', () => {
    it('re-anchors the session and re-derives its name from the new workDir', () => {
      const id = sessions()[0].id

      useSessionsStore.getState().setWorkDir(id, '/x/y')

      const updated = sessions().find((s) => s.id === id)
      expect(updated?.workDir).toBe('/x/y')
      expect(updated?.name).toBe('y')
    })

    it('touches ONLY the target session, leaving the others untouched', () => {
      // Build three sessions: [A, B, C].
      useSessionsStore.getState().addSession('/a/one')
      useSessionsStore.getState().addSession('/c/three')
      const [a, b, c] = sessions()

      useSessionsStore.getState().setWorkDir(b.id, '/x/y')

      const [na, nb, nc] = sessions()
      // Order + count preserved.
      expect(sessions().map((s) => s.id)).toEqual([a.id, b.id, c.id])
      // Only B changed.
      expect(nb.workDir).toBe('/x/y')
      expect(nb.name).toBe('y')
      // A and C are byte-for-byte the same objects (untouched).
      expect(na).toBe(a)
      expect(nc).toBe(c)
    })
  })

  describe('closeSession', () => {
    it('removes a non-active session, leaves the active one, and drops its layout', () => {
      const first = sessions()[0]
      useSessionsStore.getState().addSession('/x/y')
      const second = sessions()[1]
      // The added session is active; `first` is the non-active one we close.
      expect(activeId()).toBe(second.id)

      useSessionsStore.getState().closeSession(first.id)

      // Exactly the survivor remains — proves only `first` was removed.
      expect(sessions().map((s) => s.id)).toEqual([second.id])
      // Active is untouched when a non-active session closes.
      expect(activeId()).toBe(second.id)
      // Cross-store: the closed session's layout is removed.
      expect(removeSessionMock()).toHaveBeenCalledWith(first.id)
    })

    it('falls to the RIGHT neighbour when the active LEFTMOST session closes', () => {
      // Build three sessions: [A, B, C], then activate + close the FIRST (leftmost).
      useSessionsStore.getState().addSession('/a')
      useSessionsStore.getState().addSession('/c')
      const [a, b, c] = sessions()
      useSessionsStore.getState().setActive(a.id)

      useSessionsStore.getState().closeSession(a.id)

      expect(sessions().map((s) => s.id)).toEqual([b.id, c.id])
      // idx-1 clamps to 0 (Math.max), so active becomes the new first: B.
      expect(activeId()).toBe(b.id)
      expect(removeSessionMock()).toHaveBeenCalledWith(a.id)
    })

    it('falls to the LEFT neighbour when the active session closes', () => {
      // Build three sessions: [A, B, C].
      useSessionsStore.getState().addSession('/a')
      useSessionsStore.getState().addSession('/c')
      const [a, b, c] = sessions()
      expect(sessions()).toHaveLength(3)
      // Activate the MIDDLE one, then close it.
      useSessionsStore.getState().setActive(b.id)

      useSessionsStore.getState().closeSession(b.id)

      expect(sessions().map((s) => s.id)).toEqual([a.id, c.id])
      // Prefer left: active becomes A, not C.
      expect(activeId()).toBe(a.id)
      expect(removeSessionMock()).toHaveBeenCalledWith(b.id)
    })

    it('NEVER leaves zero sessions: closing the last one re-seeds a fresh ~ home', () => {
      const original = sessions()[0]
      expect(sessions()).toHaveLength(1)

      useSessionsStore.getState().closeSession(original.id)

      // Still exactly one session, but a brand-new one anchored at home.
      expect(sessions()).toHaveLength(1)
      const fresh = sessions()[0]
      expect(fresh.id).not.toBe(original.id)
      expect(fresh.workDir).toBe('~')
      expect(fresh.name).toBe('home')
      expect(activeId()).toBe(fresh.id)
      // Cross-store: old layout removed, fresh session's layout ensured.
      expect(removeSessionMock()).toHaveBeenCalledWith(original.id)
      expect(ensureMock()).toHaveBeenCalledWith(fresh.id)
    })
  })

  describe('setState', () => {
    it("updates the target session's state and mirrors a session-state lifecycle event", () => {
      const id = sessions()[0].id
      const emitSpy = vi.mocked(window.pine.lifecycle.emit)

      useSessionsStore.getState().setState(id, 'waiting')

      expect(sessions().find((s) => s.id === id)?.state).toBe('waiting')
      expect(emitSpy).toHaveBeenCalledWith({
        type: 'session-state',
        sessionId: id,
        state: 'waiting',
      })
    })

    it('touches ONLY the target session, leaving the others untouched', () => {
      useSessionsStore.getState().addSession('/a/one')
      useSessionsStore.getState().addSession('/c/three')
      const [a, b, c] = sessions()

      useSessionsStore.getState().setState(b.id, 'working')

      const [na, nb, nc] = sessions()
      expect(nb.state).toBe('working')
      expect(na).toBe(a)
      expect(nc).toBe(c)
    })

    it('is a no-op (no state change, no emit) when the session is already in that state', () => {
      const id = sessions()[0].id
      expect(sessions().find((s) => s.id === id)?.state).toBe('idle')
      const emitSpy = vi.mocked(window.pine.lifecycle.emit)

      useSessionsStore.getState().setState(id, 'idle')

      expect(emitSpy).not.toHaveBeenCalled()
    })

    it('is a no-op for an unknown session id', () => {
      const emitSpy = vi.mocked(window.pine.lifecycle.emit)

      useSessionsStore.getState().setState('does-not-exist', 'done')

      expect(emitSpy).not.toHaveBeenCalled()
    })
  })

  describe('nameFromWorkDir (via setWorkDir)', () => {
    it('strips a trailing slash: "/foo/bar/" → "bar"', () => {
      const id = sessions()[0].id

      useSessionsStore.getState().setWorkDir(id, '/foo/bar/')

      expect(sessions().find((s) => s.id === id)?.name).toBe('bar')
    })

    it('maps "~" to "home"', () => {
      const id = sessions()[0].id
      // Move away from home first so the change is observable.
      useSessionsStore.getState().setWorkDir(id, '/somewhere/else')
      expect(sessions().find((s) => s.id === id)?.name).toBe('else')

      useSessionsStore.getState().setWorkDir(id, '~')

      expect(sessions().find((s) => s.id === id)?.name).toBe('home')
    })

    it('falls back to "session" for a root path with an empty last segment: "/"', () => {
      const id = sessions()[0].id

      useSessionsStore.getState().setWorkDir(id, '/')

      const updated = sessions().find((s) => s.id === id)
      expect(updated?.workDir).toBe('/')
      expect(updated?.name).toBe('session')
    })
  })
})
