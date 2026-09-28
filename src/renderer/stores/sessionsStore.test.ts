import type { WorkspaceSnapshot } from '@shared/types'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLayoutStore } from './layoutStore'
import { useSessionsStore } from './sessionsStore'

const ensureMock = () => vi.mocked(useLayoutStore.getState().ensure)
const removeSessionMock = () => vi.mocked(useLayoutStore.getState().removeSession)
const sessions = () => useSessionsStore.getState().sessions
const activeId = () => useSessionsStore.getState().activeSessionId

describe('sessionsStore', () => {
  let sessionsInit: ReturnType<typeof useSessionsStore.getState>
  let layoutInit: ReturnType<typeof useLayoutStore.getState>

  beforeAll(() => {
    sessionsInit = useSessionsStore.getState()
    layoutInit = useLayoutStore.getState()
  })

  beforeEach(() => {
    vi.spyOn(useLayoutStore.getState(), 'ensure').mockImplementation(() => {})
    vi.spyOn(useLayoutStore.getState(), 'removeSession').mockImplementation(() => {})
    vi.spyOn(useLayoutStore.getState(), 'hydrate').mockImplementation(() => {})
  })

  afterEach(() => {
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
      expect(activeId()).toBe(added.id)
      expect(ensureMock()).toHaveBeenCalledWith(added.id)
    })

    it('defaults workDir to ~ (name "home") when called with no arg', () => {
      useSessionsStore.getState().addSession()

      expect(sessions()).toHaveLength(2)
      const added = sessions()[1]
      expect(added.workDir).toBe('~')
      expect(added.name).toBe('home')
      expect(activeId()).toBe(added.id)
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
      useSessionsStore.getState().addSession('/a/one')
      useSessionsStore.getState().addSession('/c/three')
      const [a, b, c] = sessions()

      useSessionsStore.getState().setWorkDir(b.id, '/x/y')

      const [na, nb, nc] = sessions()
      expect(sessions().map((s) => s.id)).toEqual([a.id, b.id, c.id])
      expect(nb.workDir).toBe('/x/y')
      expect(nb.name).toBe('y')
      expect(na).toBe(a)
      expect(nc).toBe(c)
    })
  })

  describe('closeSession', () => {
    it('removes a non-active session, leaves the active one, and drops its layout', () => {
      const first = sessions()[0]
      useSessionsStore.getState().addSession('/x/y')
      const second = sessions()[1]
      expect(activeId()).toBe(second.id)

      useSessionsStore.getState().closeSession(first.id)

      expect(sessions().map((s) => s.id)).toEqual([second.id])
      expect(activeId()).toBe(second.id)
      expect(removeSessionMock()).toHaveBeenCalledWith(first.id)
    })

    it('falls to the RIGHT neighbour when the active LEFTMOST session closes', () => {
      useSessionsStore.getState().addSession('/a')
      useSessionsStore.getState().addSession('/c')
      const [a, b, c] = sessions()
      useSessionsStore.getState().setActive(a.id)

      useSessionsStore.getState().closeSession(a.id)

      expect(sessions().map((s) => s.id)).toEqual([b.id, c.id])
      expect(activeId()).toBe(b.id)
      expect(removeSessionMock()).toHaveBeenCalledWith(a.id)
    })

    it('falls to the LEFT neighbour when the active session closes', () => {
      useSessionsStore.getState().addSession('/a')
      useSessionsStore.getState().addSession('/c')
      const [a, b, c] = sessions()
      expect(sessions()).toHaveLength(3)
      useSessionsStore.getState().setActive(b.id)

      useSessionsStore.getState().closeSession(b.id)

      expect(sessions().map((s) => s.id)).toEqual([a.id, c.id])
      expect(activeId()).toBe(a.id)
      expect(removeSessionMock()).toHaveBeenCalledWith(b.id)
    })

    it('NEVER leaves zero sessions: closing the last one re-seeds a fresh ~ home', () => {
      const original = sessions()[0]
      expect(sessions()).toHaveLength(1)

      useSessionsStore.getState().closeSession(original.id)

      expect(sessions()).toHaveLength(1)
      const fresh = sessions()[0]
      expect(fresh.id).not.toBe(original.id)
      expect(fresh.workDir).toBe('~')
      expect(fresh.name).toBe('home')
      expect(activeId()).toBe(fresh.id)
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

  describe('hydrate', () => {
    const snapshotOf = (ids: string[], activeSessionId = ids[0]): WorkspaceSnapshot => ({
      v: 1,
      savedAt: '2026-08-06T00:00:00.000Z',
      activeSessionId,
      sessions: ids.map((id) => ({
        id,
        name: `proj-${id}`,
        kind: 'terminal' as const,
        workDir: `/w/${id}`,
        activePaneId: `pane-${id}`,
        root: {
          type: 'pane' as const,
          id: `pane-${id}`,
          title: 'zsh',
          kind: 'terminal' as const,
          cwd: `/w/${id}`,
        },
      })),
    })

    it('replaces the seeded home session with the restored ones', () => {
      useSessionsStore.getState().hydrate(snapshotOf(['s40', 's41']))

      expect(sessions().map((s) => s.id)).toEqual(['s40', 's41'])
      expect(sessions().map((s) => s.workDir)).toEqual(['/w/s40', '/w/s41'])
      expect(sessions().map((s) => s.name)).toEqual(['proj-s40', 'proj-s41'])
    })

    it('restores every session as idle — a live state is never carried across a restart', () => {
      useSessionsStore.getState().hydrate(snapshotOf(['s40', 's41']))
      expect(sessions().every((s) => s.state === 'idle')).toBe(true)
    })

    it('focuses the session that was active when the snapshot was written', () => {
      useSessionsStore.getState().hydrate(snapshotOf(['s40', 's41'], 's41'))
      expect(activeId()).toBe('s41')
    })

    it('hands the restored layouts to layoutStore', () => {
      useSessionsStore.getState().hydrate(snapshotOf(['s40']))

      const hydrate = vi.mocked(useLayoutStore.getState().hydrate)
      expect(hydrate).toHaveBeenCalledTimes(1)
      const layouts = hydrate.mock.calls[0][0]
      expect(Object.keys(layouts)).toEqual(['s40'])
      expect(layouts.s40).toMatchObject({ activePaneId: 'pane-s40', zoomedPaneId: null })
    })

    it('announces each restored session to main so it can resolve their workDirs', () => {
      useSessionsStore.getState().hydrate(snapshotOf(['s40', 's41']))

      const emitted = vi.mocked(window.pine.lifecycle.emit).mock.calls.map((c) => c[0])
      expect(emitted).toContainEqual({ type: 'session-added', sessionId: 's40', workDir: '/w/s40' })
      expect(emitted).toContainEqual({ type: 'session-added', sessionId: 's41', workDir: '/w/s41' })
    })

    it('reserves restored session ids so a newly opened session cannot collide', () => {
      useSessionsStore.getState().hydrate(snapshotOf(['s40', 's41']))

      useSessionsStore.getState().addSession('/tmp')

      const ids = sessions().map((s) => s.id)
      expect(new Set(ids).size).toBe(ids.length)
      expect(ids.slice(0, 2)).toEqual(['s40', 's41'])
    })

    it('keeps the seeded home session when there is nothing to restore', () => {
      const seeded = sessions()[0]

      useSessionsStore.getState().hydrate(null)

      expect(sessions()).toEqual([seeded])
      expect(activeId()).toBe(seeded.id)
      expect(vi.mocked(window.pine.lifecycle.emit).mock.calls.map((c) => c[0])).toContainEqual({
        type: 'session-added',
        sessionId: seeded.id,
        workDir: '~',
      })
      expect(ensureMock()).toHaveBeenCalledWith(seeded.id)
    })
  })
})
