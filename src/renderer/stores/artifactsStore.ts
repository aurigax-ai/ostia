import { type ArtifactListing, changedArtifacts } from '@shared/artifacts'
import { create } from 'zustand'
import { allPanes, findPane } from '../layout/tree'
import { useLayoutStore } from './layoutStore'
import { useWorkspacesStore } from './workspacesStore'

interface ArtifactsState {
  byWorkspace: Record<string, ArtifactListing>
  unread: Record<string, true>
  refresh: (workspaceId: string) => Promise<void>
  markRead: (path: string) => void
  forget: (workspaceId: string) => void
}

function viewedFile(): string | null {
  if (!document.hasFocus()) return null
  const workspaceId = useWorkspacesStore.getState().activeWorkspaceId
  const layout = workspaceId ? useLayoutStore.getState().byWorkspace[workspaceId] : undefined
  const pane = layout ? findPane(layout.root, layout.activePaneId) : null
  return pane?.kind === 'editor' ? (pane.filePath ?? null) : null
}

function padChanged(before: ArtifactListing, after: ArtifactListing): boolean {
  return after.padModified !== null && after.padModified > (before.padModified ?? 0)
}

function isOpen(workspaceId: string, path: string): boolean {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId]
  return layout
    ? allPanes(layout.root).some((pane) => pane.kind === 'editor' && pane.filePath === path)
    : false
}

export const useArtifactsStore = create<ArtifactsState>((set, get) => ({
  byWorkspace: {},
  unread: {},

  refresh: async (workspaceId) => {
    const listing = await window.ostia.artifacts.list(workspaceId)
    if (!listing) return
    const previous = get().byWorkspace[workspaceId]
    const viewed = viewedFile()
    const fresh = previous
      ? changedArtifacts(previous.entries, listing.entries).filter((path) => path !== viewed)
      : []
    if (previous && padChanged(previous, listing) && !isOpen(workspaceId, listing.pad)) {
      fresh.push(listing.pad)
    }
    set((s) => {
      const listed = new Set(listing.entries.map((entry) => entry.path))
      const gone = (previous?.entries ?? []).filter((entry) => !listed.has(entry.path))
      const unread = { ...s.unread }
      for (const entry of gone) delete unread[entry.path]
      for (const path of fresh) unread[path] = true
      return { byWorkspace: { ...s.byWorkspace, [workspaceId]: listing }, unread }
    })
  },

  markRead: (path) =>
    set((s) => {
      if (!s.unread[path]) return s
      const { [path]: _read, ...unread } = s.unread
      return { unread }
    }),

  forget: (workspaceId) =>
    set((s) => {
      const listing = s.byWorkspace[workspaceId]
      if (!listing) return s
      const { [workspaceId]: _gone, ...byWorkspace } = s.byWorkspace
      const unread = { ...s.unread }
      for (const entry of listing.entries) delete unread[entry.path]
      delete unread[listing.pad]
      return { byWorkspace, unread }
    }),
}))

export function wireArtifacts(): void {
  window.ostia?.artifacts?.onChanged?.((workspaceId) => {
    void useArtifactsStore.getState().refresh(workspaceId)
  })
  useWorkspacesStore.subscribe((s, prev) => {
    if (s.workspaces === prev.workspaces) return
    const open = new Set(s.workspaces.map((w) => w.id))
    for (const id of Object.keys(useArtifactsStore.getState().byWorkspace)) {
      if (!open.has(id)) useArtifactsStore.getState().forget(id)
    }
  })
}
