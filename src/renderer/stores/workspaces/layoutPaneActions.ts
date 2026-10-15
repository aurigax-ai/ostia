import {
  clearPaneResumeFailure,
  failPaneResume,
  followMovedFile,
  hasLockedPane,
  renamePane,
  setDefaultPaneTitle,
  setPaneCwd,
  setPaneHibernated,
  setPaneLocked,
  setPaneResume,
  setPaneSpawnDir,
  setPaneTitle,
  setPaneUrl,
  setResumePending,
  settleSpawnDir,
} from '@/lib/layout/paneFields'
import { findPane } from '@/lib/layout/tree'
import { neutralTerminalTitle } from './layoutSeed'
import type { LayoutGet, LayoutSet, LayoutState, WorkspaceLayout } from './layoutTypes'

type LayoutPaneActions = Pick<
  LayoutState,
  | 'setCwd'
  | 'setUrl'
  | 'followMovedFile'
  | 'setTitle'
  | 'rename'
  | 'setDefaultTitle'
  | 'setResume'
  | 'setResumePending'
  | 'failResume'
  | 'clearResumeFailure'
  | 'setHibernated'
  | 'setSpawnDir'
  | 'settleSpawnDir'
  | 'setLocked'
  | 'isLocked'
>

export function createLayoutPaneActions(set: LayoutSet, get: LayoutGet): LayoutPaneActions {
  return {
    setCwd: (workspaceId, paneId, cwd) =>
      set((s) => {
        const layout = s.byWorkspace[workspaceId]
        if (!layout) return s
        const root = setPaneCwd(layout.root, paneId, cwd)
        return root === layout.root
          ? s
          : { byWorkspace: { ...s.byWorkspace, [workspaceId]: { ...layout, root } } }
      }),

    setUrl: (workspaceId, paneId, url) =>
      set((s) => {
        const layout = s.byWorkspace[workspaceId]
        if (!layout) return s
        const root = setPaneUrl(layout.root, paneId, url)
        return root === layout.root
          ? s
          : { byWorkspace: { ...s.byWorkspace, [workspaceId]: { ...layout, root } } }
      }),

    followMovedFile: (from, to) =>
      set((s) => {
        let changed = false
        const byWorkspace: Record<string, WorkspaceLayout> = {}
        for (const [id, layout] of Object.entries(s.byWorkspace)) {
          const root = followMovedFile(layout.root, from, to)
          changed ||= root !== layout.root
          byWorkspace[id] = root === layout.root ? layout : { ...layout, root }
        }
        return changed ? { byWorkspace } : s
      }),

    setTitle: (workspaceId, paneId, title) =>
      set((s) => {
        const layout = s.byWorkspace[workspaceId]
        if (!layout) return s
        const root = setPaneTitle(layout.root, paneId, title)
        return root === layout.root
          ? s
          : { byWorkspace: { ...s.byWorkspace, [workspaceId]: { ...layout, root } } }
      }),

    rename: (workspaceId, paneId, title) =>
      set((s) => {
        const layout = s.byWorkspace[workspaceId]
        if (!layout) return s
        const root = renamePane(layout.root, paneId, title)
        return root === layout.root
          ? s
          : { byWorkspace: { ...s.byWorkspace, [workspaceId]: { ...layout, root } } }
      }),

    setDefaultTitle: (workspaceId, paneId, title) =>
      set((s) => {
        const layout = s.byWorkspace[workspaceId]
        if (!layout) return s
        const root = setDefaultPaneTitle(layout.root, paneId, title)
        return root === layout.root
          ? s
          : { byWorkspace: { ...s.byWorkspace, [workspaceId]: { ...layout, root } } }
      }),

    setResume: (workspaceId, paneId, resume) =>
      set((s) => {
        const layout = s.byWorkspace[workspaceId]
        if (!layout) return s
        const root = setPaneResume(layout.root, paneId, resume)
        return root === layout.root
          ? s
          : { byWorkspace: { ...s.byWorkspace, [workspaceId]: { ...layout, root } } }
      }),

    failResume: (workspaceId, paneId, resume, exitCode) =>
      set((s) => {
        const layout = s.byWorkspace[workspaceId]
        if (!layout) return s
        const root = failPaneResume(layout.root, paneId, resume, exitCode)
        return root === layout.root
          ? s
          : { byWorkspace: { ...s.byWorkspace, [workspaceId]: { ...layout, root } } }
      }),

    clearResumeFailure: (workspaceId, paneId) =>
      set((s) => {
        const layout = s.byWorkspace[workspaceId]
        if (!layout) return s
        const root = clearPaneResumeFailure(layout.root, paneId)
        return root === layout.root
          ? s
          : { byWorkspace: { ...s.byWorkspace, [workspaceId]: { ...layout, root } } }
      }),

    setResumePending: (workspaceId, paneId, pending) =>
      set((s) => {
        const layout = s.byWorkspace[workspaceId]
        if (!layout) return s
        const root = setResumePending(layout.root, paneId, pending)
        return root === layout.root
          ? s
          : { byWorkspace: { ...s.byWorkspace, [workspaceId]: { ...layout, root } } }
      }),

    setHibernated: (workspaceId, paneId, hibernated) =>
      set((s) => {
        const layout = s.byWorkspace[workspaceId]
        if (!layout) return s
        const asleep = setPaneHibernated(layout.root, paneId, hibernated)
        const root = hibernated
          ? setDefaultPaneTitle(asleep, paneId, neutralTerminalTitle())
          : asleep
        return root === layout.root
          ? s
          : { byWorkspace: { ...s.byWorkspace, [workspaceId]: { ...layout, root } } }
      }),

    setSpawnDir: (workspaceId, paneId, spawnDir) =>
      set((s) => {
        const layout = s.byWorkspace[workspaceId]
        if (!layout) return s
        const root = setPaneSpawnDir(layout.root, paneId, spawnDir)
        return root === layout.root
          ? s
          : { byWorkspace: { ...s.byWorkspace, [workspaceId]: { ...layout, root } } }
      }),

    settleSpawnDir: (workspaceId, paneId, missing) =>
      set((s) => {
        const layout = s.byWorkspace[workspaceId]
        if (!layout) return s
        const root = settleSpawnDir(layout.root, paneId, missing)
        return root === layout.root
          ? s
          : { byWorkspace: { ...s.byWorkspace, [workspaceId]: { ...layout, root } } }
      }),

    setLocked: (workspaceId, paneId, locked) =>
      set((s) => {
        const layout = s.byWorkspace[workspaceId]
        if (!layout || findPane(layout.root, paneId)?.kind === 'manager') return s
        const root = setPaneLocked(layout.root, paneId, locked)
        return root === layout.root
          ? s
          : { byWorkspace: { ...s.byWorkspace, [workspaceId]: { ...layout, root } } }
      }),

    isLocked: (workspaceId, paneId) => {
      const root = get().byWorkspace[workspaceId]?.root
      if (!root) return false
      return paneId === undefined ? hasLockedPane(root) : findPane(root, paneId)?.locked === true
    },
  }
}
