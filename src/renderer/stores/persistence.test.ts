import type { AppSnapshot } from '@shared/types'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetIds } from '../layout/tree'
import { useLayoutStore } from './layoutStore'
import {
  SAVE_DEBOUNCE_MS,
  SAVE_MAX_WAIT_MS,
  saveSnapshotNow,
  startSnapshotAutosave,
} from './persistence'
import { useSettingsStore } from './settingsStore'
import { useWorkspacesStore } from './workspacesStore'

const save = () => vi.mocked(window.pine.workspace.save)
const lastSnapshot = (): AppSnapshot => {
  const calls = save().mock.calls.filter((c) => c[0] !== null)
  const snapshot = calls.at(-1)?.[0]
  if (!snapshot) throw new Error('no snapshot was saved')
  return snapshot
}

const activeSid = (): string => {
  const sid = useWorkspacesStore.getState().activeWorkspaceId
  if (!sid) throw new Error('no active workspace')
  return sid
}

const activePane = (sid: string): string => {
  const layout = useLayoutStore.getState().byWorkspace[sid]
  if (!layout) throw new Error('no layout')
  return layout.activePaneId
}

describe('workspace autosave', () => {
  let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
  let layoutInit: ReturnType<typeof useLayoutStore.getState>
  let settingsInit: ReturnType<typeof useSettingsStore.getState>
  let stop: (() => void) | null = null

  beforeAll(() => {
    workspacesInit = useWorkspacesStore.getState()
    layoutInit = useLayoutStore.getState()
    settingsInit = useSettingsStore.getState()
  })

  beforeEach(() => {
    resetIds()
    useWorkspacesStore.getState().addWorkspace()
    useLayoutStore.getState().ensure(activeSid())
  })

  afterEach(() => {
    stop?.()
    stop = null
    useWorkspacesStore.setState(workspacesInit, true)
    useLayoutStore.setState(layoutInit, true)
    useSettingsStore.setState(settingsInit, true)
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  describe('saveSnapshotNow', () => {
    it('pushes a snapshot of the live workspaces and their layouts', () => {
      const active = activeSid()

      saveSnapshotNow()

      const snapshot = lastSnapshot()
      expect(snapshot.v).toBe(1)
      expect(snapshot.activeWorkspaceId).toBe(active)
      expect(snapshot.workspaces.map((s) => s.id)).toEqual([active])
      expect(snapshot.workspaces[0].root).toMatchObject({ type: 'pane', kind: 'terminal' })
    })

    it('never saves a scratch workspace, even when it is the active one', () => {
      const kept = activeSid()
      useWorkspacesStore
        .getState()
        .addWorkspace('/tmp/pine-scratch-1000/1-aaaaaaaaaaaa', 'end', 'scratch')
      const scratch = activeSid()
      useLayoutStore.getState().ensure(scratch)

      saveSnapshotNow()

      const snapshot = lastSnapshot()
      expect(snapshot.workspaces.map((s) => s.id)).toEqual([kept])
      expect(snapshot.activeWorkspaceId).toBe(kept)
    })

    it('stamps the save time so a stored snapshot can be dated by hand', () => {
      saveSnapshotNow()
      expect(Number.isNaN(Date.parse(lastSnapshot().savedAt))).toBe(false)
    })

    it('captures a split as a split', () => {
      const sid = activeSid()
      const paneId = activePane(sid)
      useLayoutStore.getState().split(sid, paneId, 'vertical')

      saveSnapshotNow()

      const root = lastSnapshot().workspaces[0].root
      expect(root).toMatchObject({ type: 'split', direction: 'vertical' })
      expect(root?.type === 'split' && root.children).toHaveLength(2)
    })

    it('tells main to forget everything when restore is switched off', () => {
      useSettingsStore.getState().setBehavior({ restoreWorkspace: false })
      save().mockClear()

      saveSnapshotNow()

      expect(save()).toHaveBeenCalledWith(null)
    })

    it('does not keep re-clearing while restore stays off', () => {
      useSettingsStore.getState().setBehavior({ restoreWorkspace: false })
      saveSnapshotNow()
      save().mockClear()

      saveSnapshotNow()
      saveSnapshotNow()

      expect(save()).not.toHaveBeenCalled()
    })

    it('starts saving again when restore is switched back on', () => {
      useSettingsStore.getState().setBehavior({ restoreWorkspace: false })
      saveSnapshotNow()
      useSettingsStore.getState().setBehavior({ restoreWorkspace: true })
      save().mockClear()

      saveSnapshotNow()

      expect(lastSnapshot().workspaces).toHaveLength(1)
    })
  })

  describe('startSnapshotAutosave', () => {
    it('collapses a burst of edits into a single write', () => {
      vi.useFakeTimers()
      stop = startSnapshotAutosave()
      save().mockClear()

      const sid = activeSid()
      useLayoutStore.getState().setCwd(sid, activePane(sid), '/a')
      useLayoutStore.getState().setCwd(sid, activePane(sid), '/b')
      useWorkspacesStore.getState().addWorkspace('/c')
      expect(save()).not.toHaveBeenCalled()

      vi.runAllTimers()
      expect(save()).toHaveBeenCalledTimes(1)
    })

    it('still writes while edits never pause, so a crashed renderer restores recent panes', () => {
      vi.useFakeTimers()
      stop = startSnapshotAutosave()
      save().mockClear()
      const sid = activeSid()
      for (let i = 0; i < 40; i++) {
        useLayoutStore.getState().setCwd(sid, activePane(sid), `/busy/${i}`)
        vi.advanceTimersByTime(SAVE_DEBOUNCE_MS / 2)
      }
      const busyMs = (40 * SAVE_DEBOUNCE_MS) / 2
      expect(save().mock.calls.length).toBeGreaterThanOrEqual(busyMs / SAVE_MAX_WAIT_MS - 1)
      expect(lastSnapshot().workspaces[0].root).toMatchObject({
        cwd: expect.stringMatching(/^\/busy\//),
      })
    })

    it('persists what changed, not a stale copy', () => {
      vi.useFakeTimers()
      stop = startSnapshotAutosave()
      const sid = activeSid()
      const paneId = activePane(sid)

      useLayoutStore.getState().setCwd(sid, paneId, '/home/u/moved')
      vi.runAllTimers()

      expect(lastSnapshot().workspaces[0].root).toMatchObject({ cwd: '/home/u/moved' })
    })

    it('flushes the pending write when the window is closing', () => {
      vi.useFakeTimers()
      stop = startSnapshotAutosave()
      save().mockClear()
      const sid = activeSid()
      useLayoutStore.getState().setCwd(sid, activePane(sid), '/x')

      window.dispatchEvent(new Event('beforeunload'))

      expect(save()).toHaveBeenCalledTimes(1)
      expect(lastSnapshot().workspaces[0].root).toMatchObject({ cwd: '/x' })
    })

    it('saves an empty workspace once the last workspace is closed', () => {
      useWorkspacesStore.getState().closeWorkspace(activeSid())
      save().mockClear()

      saveSnapshotNow()

      expect(save()).toHaveBeenCalledWith(
        expect.objectContaining({ v: 1, activeWorkspaceId: null, workspaces: [] }),
      )
    })

    it('stops watching once disposed', () => {
      vi.useFakeTimers()
      const dispose = startSnapshotAutosave()
      dispose()
      save().mockClear()

      useWorkspacesStore.getState().addWorkspace('/c')
      vi.runAllTimers()
      window.dispatchEvent(new Event('beforeunload'))

      expect(save()).not.toHaveBeenCalled()
    })
  })
})
