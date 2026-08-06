import { create } from 'zustand'
import {
  type DropZone,
  closePane,
  createPane,
  findPane,
  firstPaneId,
  firstPaneOfKind,
  movePane,
  paneIds,
  setPaneBrowser,
  setPaneCwd,
  setPaneEditor,
  setPaneKind,
  setSizes,
  splitPane,
} from '../layout/tree'
import type { Direction, LayoutNode, SurfaceKind } from '../layout/types'
import { useSessionsStore } from './sessionsStore'

/**
 * Per-session layout: a split-tree of single-surface panes (Warp-style — each pane
 * is one terminal/editor/… with a header, no tab bar). Sessions live in the sidebar.
 */
export interface SessionLayout {
  root: LayoutNode
  /** The focused pane (shows the accent ring). */
  activePaneId: string
  /** When set, `PaneTree` renders ONLY this pane (no Allotment split view) — a minimal
   *  maximize/zen mode (cmux-parity `browse.focusMode`'s renderer half). Every other pane's
   *  surface just stops being portaled into a live slot; `SurfacePool` already parks an
   *  unslotted surface in its detached holder (the same path a mid-split remount takes), so
   *  nothing unmounts/re-attaches while zoomed. */
  zoomedPaneId: string | null
}

interface LayoutState {
  bySession: Record<string, SessionLayout>
  /** Create a default layout (one terminal) for a session that has none yet. */
  ensure: (sessionId: string) => void
  /**
   * Install the layouts restored from the previous run (session restore), REPLACING
   * whatever is there — a stale layout from the seeded boot session would otherwise linger
   * as a ghost. Runs before the first render, so `ensure` then no-ops on every restored
   * session and can't overwrite one. Emits `pane-created` per restored pane: they never
   * went through `ensure`/`split`, so without it main has no identity for them and the
   * control socket can't address them.
   */
  hydrate: (layouts: Record<string, SessionLayout>) => void
  split: (sessionId: string, paneId: string, direction: Direction) => void
  closePane: (sessionId: string, paneId: string) => void
  focusPane: (sessionId: string, paneId: string) => void
  resize: (sessionId: string, splitId: string, sizes: number[]) => void
  /** Zoom pane `paneId` to fill its session's whole workzone (or un-zoom). `zoom` omitted toggles;
   *  `true`/`false` sets it deterministically (used by `browse.focusMode`'s enter/exit, which
   *  can't know the current state without a round-trip). Setting `true` on a different pane than
   *  the one currently zoomed just re-targets the zoom, no need to un-zoom first. */
  zoomPane: (sessionId: string, paneId: string, zoom?: boolean) => void
  movePane: (sessionId: string, sourceId: string, targetId: string, zone: DropZone) => void
  /** Remove a pane from this window (used after it's torn off into a new window). */
  removePane: (sessionId: string, paneId: string) => void
  /** Update a pane's cwd (from the terminal's live working directory). */
  setCwd: (sessionId: string, paneId: string, cwd: string) => void
  /** Open `path` in an editor pane — reuse an existing editor, else split a new one. */
  openFile: (sessionId: string, path: string) => void
  /** Open `url` in a browser pane — reuse an existing browser pane, else split a new one. */
  openBrowser: (sessionId: string, url: string) => void
  /** Focus a `kind` pane (kanban/wiki) — reuse an existing one of that kind, else split a new
   *  one off the focused pane. No extra per-pane data (unlike `openFile`/`openBrowser`). */
  openSurface: (sessionId: string, kind: SurfaceKind) => void
  /** Drop a session's layout (called when the session closes) so nothing leaks. */
  removeSession: (sessionId: string) => void
}

function layoutOf(root: LayoutNode): SessionLayout {
  return { root, activePaneId: firstPaneId(root), zoomedPaneId: null }
}

/** Update one session's layout via a pure transform; no-op if absent. */
function patch(
  state: LayoutState,
  sessionId: string,
  fn: (layout: SessionLayout) => SessionLayout,
): Pick<LayoutState, 'bySession'> | null {
  const layout = state.bySession[sessionId]
  if (!layout) return null
  return { bySession: { ...state.bySession, [sessionId]: fn(layout) } }
}

export const useLayoutStore = create<LayoutState>((set, get) => ({
  bySession: {},

  ensure: (sessionId) => {
    let createdPaneId: string | null = null
    set((s) => {
      if (s.bySession[sessionId]) return s
      const workDir = useSessionsStore
        .getState()
        .sessions.find((sess) => sess.id === sessionId)?.workDir
      const root = createPane('terminal', undefined, workDir)
      createdPaneId = firstPaneId(root)
      return {
        bySession: {
          ...s.bySession,
          [sessionId]: layoutOf(root),
        },
      }
    })
    if (createdPaneId) {
      window.pine?.lifecycle?.emit?.({ type: 'pane-created', sessionId, paneId: createdPaneId })
    }
  },

  hydrate: (layouts) => {
    set({ bySession: { ...layouts } })
    for (const [sessionId, layout] of Object.entries(layouts)) {
      for (const paneId of paneIds(layout.root)) {
        window.pine?.lifecycle?.emit?.({ type: 'pane-created', sessionId, paneId })
      }
    }
  },

  split: (sessionId, paneId, direction) => {
    let createdPaneId: string | null = null
    set((s) => {
      const next = patch(s, sessionId, (l) => {
        const result = splitPane(l.root, paneId, direction)
        createdPaneId = result.newPaneId
        return { ...l, root: result.root, activePaneId: result.newPaneId ?? l.activePaneId }
      })
      return next ?? s
    })
    if (createdPaneId) {
      window.pine?.lifecycle?.emit?.({ type: 'pane-created', sessionId, paneId: createdPaneId })
    }
  },

  closePane: (sessionId, paneId) => {
    // closePane (the pure tree transform) is a no-op on a session's last pane — the
    // pane can't be removed, so the tree comes back unchanged. Only emit `pane-closed`
    // when the pane actually left the tree; otherwise main's identity registry would
    // wrongly evict a still-live pane (see idRegistry.removePane via lifecycle:event).
    let removed = false
    set((s) => {
      const next = patch(s, sessionId, (l) => {
        const root = closePane(l.root, paneId)
        removed = findPane(root, paneId) === null
        const activePaneId = paneId === l.activePaneId ? firstPaneId(root) : l.activePaneId
        // A zoomed pane that just closed can't stay zoomed — leaving it set would strand the
        // session on a single-pane view of a pane id `PaneTree` can no longer find (harmless
        // there since it falls back to the full tree, but pointless to keep around).
        const zoomedPaneId = removed && l.zoomedPaneId === paneId ? null : l.zoomedPaneId
        return { root, activePaneId, zoomedPaneId }
      })
      return next ?? s
    })
    if (removed) {
      window.pine?.lifecycle?.emit?.({ type: 'pane-closed', sessionId, paneId })
    }
  },

  focusPane: (sessionId, paneId) =>
    set((s) => patch(s, sessionId, (l) => ({ ...l, activePaneId: paneId })) ?? s),

  zoomPane: (sessionId, paneId, zoom) =>
    set(
      (s) =>
        patch(s, sessionId, (l) => {
          const zoomedPaneId =
            zoom === undefined
              ? l.zoomedPaneId === paneId
                ? null
                : paneId
              : zoom
                ? paneId
                : l.zoomedPaneId === paneId
                  ? null
                  : l.zoomedPaneId
          return { ...l, zoomedPaneId }
        }) ?? s,
    ),

  resize: (sessionId, splitId, sizes) =>
    set((s) => patch(s, sessionId, (l) => ({ ...l, root: setSizes(l.root, splitId, sizes) })) ?? s),

  movePane: (sessionId, sourceId, targetId, zone) =>
    set(
      (s) =>
        patch(s, sessionId, (l) => ({
          ...l,
          root: movePane(l.root, sourceId, targetId, zone),
          activePaneId: sourceId,
        })) ?? s,
    ),

  // Delegates to closePane, so it inherits the conditional emit guard above —
  // no separate (and no double) `pane-closed` emit needed here.
  removePane: (sessionId, paneId) => get().closePane(sessionId, paneId),

  setCwd: (sessionId, paneId, cwd) =>
    set((s) => patch(s, sessionId, (l) => ({ ...l, root: setPaneCwd(l.root, paneId, cwd) })) ?? s),

  openFile: (sessionId, path) => {
    let createdPaneId: string | null = null
    set((s) => {
      const next = patch(s, sessionId, (l) => {
        const title = path.split('/').pop() || path
        // Reuse an existing editor pane if there is one.
        const existing = firstPaneOfKind(l.root, 'editor')
        if (existing) {
          return {
            ...l,
            root: setPaneEditor(l.root, existing.id, title, path),
            activePaneId: existing.id,
          }
        }
        // Otherwise split the focused pane and make the new one an editor.
        const { root, newPaneId } = splitPane(l.root, l.activePaneId, 'horizontal')
        if (!newPaneId) return l
        createdPaneId = newPaneId
        return { ...l, root: setPaneEditor(root, newPaneId, title, path), activePaneId: newPaneId }
      })
      return next ?? s
    })
    if (createdPaneId) {
      window.pine?.lifecycle?.emit?.({ type: 'pane-created', sessionId, paneId: createdPaneId })
    }
  },

  openBrowser: (sessionId, url) => {
    let createdPaneId: string | null = null
    set((s) => {
      const next = patch(s, sessionId, (l) => {
        // Reuse an existing browser pane if there is one.
        const existing = firstPaneOfKind(l.root, 'browser')
        if (existing) {
          return {
            ...l,
            root: setPaneBrowser(l.root, existing.id, url),
            activePaneId: existing.id,
          }
        }
        // Otherwise split the focused pane and make the new one a browser.
        const { root, newPaneId } = splitPane(l.root, l.activePaneId, 'horizontal')
        if (!newPaneId) return l
        createdPaneId = newPaneId
        return { ...l, root: setPaneBrowser(root, newPaneId, url), activePaneId: newPaneId }
      })
      return next ?? s
    })
    if (createdPaneId) {
      window.pine?.lifecycle?.emit?.({ type: 'pane-created', sessionId, paneId: createdPaneId })
    }
  },

  openSurface: (sessionId, kind) => {
    let createdPaneId: string | null = null
    set((s) => {
      const next = patch(s, sessionId, (l) => {
        // Reuse an existing pane of this kind if there is one.
        const existing = firstPaneOfKind(l.root, kind)
        if (existing) return { ...l, activePaneId: existing.id }
        // Otherwise split the focused pane and make the new one this kind.
        const { root, newPaneId } = splitPane(l.root, l.activePaneId, 'horizontal')
        if (!newPaneId) return l
        createdPaneId = newPaneId
        return { ...l, root: setPaneKind(root, newPaneId, kind), activePaneId: newPaneId }
      })
      return next ?? s
    })
    if (createdPaneId) {
      window.pine?.lifecycle?.emit?.({ type: 'pane-created', sessionId, paneId: createdPaneId })
    }
  },

  removeSession: (sessionId) => {
    const layout = get().bySession[sessionId]
    set((s) => {
      if (!(sessionId in s.bySession)) return s
      const { [sessionId]: _removed, ...bySession } = s.bySession
      return { bySession }
    })
    if (layout) {
      for (const paneId of paneIds(layout.root)) {
        window.pine?.lifecycle?.emit?.({ type: 'pane-closed', sessionId, paneId })
      }
    }
  },
}))
