import {
  clearPaneResumeFailure,
  failPaneResume,
  followMovedFile,
  hasLockedPane,
  renamePane,
  setDefaultPaneTitle,
  setPaneBrowserDevice,
  setPaneCwd,
  setPaneHibernated,
  setPaneKeepAwake,
  setPaneLocked,
  setPaneResume,
  setPaneSpawnDir,
  setPaneTitle,
  setPaneUrl,
  setPaneViewType,
  setResumePending,
  settleSpawnDir,
} from '@/lib/layout/paneFields'
import { findPane } from '@/lib/layout/tree'
import { neutralTerminalTitle } from './layoutSeed'
import type { LayoutGet, LayoutSet, LayoutState, WorkspaceLayout } from './layoutTypes'

type LayoutPaneFieldActions = Pick<
  LayoutState,
  | 'setCwd'
  | 'setUrl'
  | 'setBrowserDevice'
  | 'followMovedFile'
  | 'setTitle'
  | 'setViewType'
  | 'rename'
  | 'setDefaultTitle'
>

type LayoutPaneResumeActions = Pick<
  LayoutState,
  | 'setResume'
  | 'setResumePending'
  | 'failResume'
  | 'clearResumeFailure'
  | 'setHibernated'
  | 'setKeepAwake'
  | 'setSpawnDir'
  | 'settleSpawnDir'
>

type LayoutPaneLockActions = Pick<LayoutState, 'setLocked' | 'isLocked'>

type LayoutPaneActions = LayoutPaneFieldActions & LayoutPaneResumeActions & LayoutPaneLockActions

function createPaneFieldActions(set: LayoutSet): LayoutPaneFieldActions {
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

    setBrowserDevice: (workspaceId, paneId, device) =>
      set((s) => {
        const layout = s.byWorkspace[workspaceId]
        if (!layout) return s
        const root = setPaneBrowserDevice(layout.root, paneId, device)
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

    setViewType: (workspaceId, paneId, viewType) =>
      set((s) => {
        const layout = s.byWorkspace[workspaceId]
        if (!layout) return s
        const root = setPaneViewType(layout.root, paneId, viewType)
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
  }
}

function createPaneResumeActions(set: LayoutSet): LayoutPaneResumeActions {
  return {
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

    setKeepAwake: (workspaceId, paneId, keepAwake) =>
      set((s) => {
        const layout = s.byWorkspace[workspaceId]
        const pane = layout ? findPane(layout.root, paneId) : null
        if (!layout || pane?.kind !== 'terminal' || (keepAwake && !pane.resume)) return s
        const root = setPaneKeepAwake(layout.root, paneId, keepAwake)
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
  }
}

function createPaneLockActions(set: LayoutSet, get: LayoutGet): LayoutPaneLockActions {
  return {
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

export function createLayoutPaneActions(set: LayoutSet, get: LayoutGet): LayoutPaneActions {
  return {
    ...createPaneFieldActions(set),
    ...createPaneResumeActions(set),
    ...createPaneLockActions(set, get),
  }
}
