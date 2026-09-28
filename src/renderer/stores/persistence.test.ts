import type { WorkspaceSnapshot } from '@shared/types'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetIds } from '../layout/tree'
import { useLayoutStore } from './layoutStore'
import { saveWorkspaceNow, startWorkspaceAutosave } from './persistence'
import { useSessionsStore } from './sessionsStore'
import { useSettingsStore } from './settingsStore'

const save = () => vi.mocked(window.pine.session.save)
const lastSnapshot = (): WorkspaceSnapshot => {
  const calls = save().mock.calls.filter((c) => c[0] !== null)
  const snapshot = calls.at(-1)?.[0]
  if (!snapshot) throw new Error('no snapshot was saved')
  return snapshot
}

const activeSid = (): string => {
  const sid = useSessionsStore.getState().activeSessionId
  if (!sid) throw new Error('no active session')
  return sid
}

const activePane = (sid: string): string => {
  const layout = useLayoutStore.getState().bySession[sid]
  if (!layout) throw new Error('no layout')
  return layout.activePaneId
}

describe('workspace autosave', () => {
  let sessionsInit: ReturnType<typeof useSessionsStore.getState>
  let layoutInit: ReturnType<typeof useLayoutStore.getState>
  let settingsInit: ReturnType<typeof useSettingsStore.getState>
  let stop: (() => void) | null = null

  beforeAll(() => {
    sessionsInit = useSessionsStore.getState()
    layoutInit = useLayoutStore.getState()
    settingsInit = useSettingsStore.getState()
  })

  beforeEach(() => {
    resetIds()
    useSessionsStore.getState().addSession()
  })

  afterEach(() => {
    stop?.()
    stop = null
    useSessionsStore.setState(sessionsInit, true)
    useLayoutStore.setState(layoutInit, true)
    useSettingsStore.setState(settingsInit, true)
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  describe('saveWorkspaceNow', () => {
    it('pushes a snapshot of the live sessions and their layouts', () => {
      const active = activeSid()

      saveWorkspaceNow()

      const snapshot = lastSnapshot()
      expect(snapshot.v).toBe(1)
      expect(snapshot.activeSessionId).toBe(active)
      expect(snapshot.sessions.map((s) => s.id)).toEqual([active])
      expect(snapshot.sessions[0].root).toMatchObject({ type: 'pane', kind: 'terminal' })
    })

    it('stamps the save time so a stored snapshot can be dated by hand', () => {
      saveWorkspaceNow()
      expect(Number.isNaN(Date.parse(lastSnapshot().savedAt))).toBe(false)
    })

    it('captures a split as a split', () => {
      const sid = activeSid()
      const paneId = activePane(sid)
      useLayoutStore.getState().split(sid, paneId, 'vertical')

      saveWorkspaceNow()

      const root = lastSnapshot().sessions[0].root
      expect(root).toMatchObject({ type: 'split', direction: 'vertical' })
      expect(root.type === 'split' && root.children).toHaveLength(2)
    })

    it('tells main to forget everything when restore is switched off', () => {
      useSettingsStore.getState().setBehavior({ restoreSession: false })
      save().mockClear()

      saveWorkspaceNow()

      expect(save()).toHaveBeenCalledWith(null)
    })

    it('does not keep re-clearing while restore stays off', () => {
      useSettingsStore.getState().setBehavior({ restoreSession: false })
      saveWorkspaceNow()
      save().mockClear()

      saveWorkspaceNow()
      saveWorkspaceNow()

      expect(save()).not.toHaveBeenCalled()
    })

    it('starts saving again when restore is switched back on', () => {
      useSettingsStore.getState().setBehavior({ restoreSession: false })
      saveWorkspaceNow()
      useSettingsStore.getState().setBehavior({ restoreSession: true })
      save().mockClear()

      saveWorkspaceNow()

      expect(lastSnapshot().sessions).toHaveLength(1)
    })
  })

  describe('startWorkspaceAutosave', () => {
    it('collapses a burst of edits into a single write', () => {
      vi.useFakeTimers()
      stop = startWorkspaceAutosave()
      save().mockClear()

      const sid = activeSid()
      useLayoutStore.getState().setCwd(sid, activePane(sid), '/a')
      useLayoutStore.getState().setCwd(sid, activePane(sid), '/b')
      useSessionsStore.getState().addSession('/c')
      expect(save()).not.toHaveBeenCalled()

      vi.runAllTimers()
      expect(save()).toHaveBeenCalledTimes(1)
    })

    it('persists what changed, not a stale copy', () => {
      vi.useFakeTimers()
      stop = startWorkspaceAutosave()
      const sid = activeSid()
      const paneId = activePane(sid)

      useLayoutStore.getState().setCwd(sid, paneId, '/home/u/moved')
      vi.runAllTimers()

      expect(lastSnapshot().sessions[0].root).toMatchObject({ cwd: '/home/u/moved' })
    })

    it('flushes the pending write when the window is closing', () => {
      vi.useFakeTimers()
      stop = startWorkspaceAutosave()
      save().mockClear()
      const sid = activeSid()
      useLayoutStore.getState().setCwd(sid, activePane(sid), '/x')

      window.dispatchEvent(new Event('beforeunload'))

      expect(save()).toHaveBeenCalledTimes(1)
      expect(lastSnapshot().sessions[0].root).toMatchObject({ cwd: '/x' })
    })

    it('saves an empty workspace once the last session is closed', () => {
      useSessionsStore.getState().closeSession(activeSid())
      save().mockClear()

      saveWorkspaceNow()

      expect(save()).toHaveBeenCalledWith(
        expect.objectContaining({ v: 1, activeSessionId: null, sessions: [] }),
      )
    })

    it('stops watching once disposed', () => {
      vi.useFakeTimers()
      const dispose = startWorkspaceAutosave()
      dispose()
      save().mockClear()

      useSessionsStore.getState().addSession('/c')
      vi.runAllTimers()
      window.dispatchEvent(new Event('beforeunload'))

      expect(save()).not.toHaveBeenCalled()
    })
  })
})
