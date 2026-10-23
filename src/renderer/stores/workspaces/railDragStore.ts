import { create } from 'zustand'
import { canonicalDrop } from '@/lib/sidebar/canonicalDrop'
import type { DragSource, DropTarget } from '@/lib/sidebar/workspaceGroups'
import { useWorkspacesStore } from './workspacesStore'

export type RailTarget = DropTarget | { kind: 'merge'; id: string }

interface RailDrop {
  source: DragSource
  target: RailTarget
}

interface RailDragState {
  source: DragSource | null
  target: RailTarget | null
  mergeable: ReadonlySet<string>
  start: (source: DragSource) => void
  offerMerges: (source: DragSource, ids: readonly string[]) => void
  aim: (target: RailTarget) => void
  leave: () => void
  take: () => RailDrop | null
  end: () => void
}

function sameTarget(a: RailTarget | null, b: RailTarget | null): boolean {
  if (a === null || b === null) return a === b
  if (a.kind !== b.kind) return false
  if (a.kind === 'end' || b.kind === 'end') return true
  if (a.kind === 'merge' || b.kind === 'merge') return a.id === b.id
  return a.id === b.id && a.place === b.place
}

const EMPTY: ReadonlySet<string> = new Set()

export const useRailDragStore = create<RailDragState>((set, get) => ({
  source: null,
  target: null,
  mergeable: EMPTY,
  start: (source) => set({ source, target: null, mergeable: EMPTY }),
  offerMerges: (source, ids) => {
    if (ids.length > 0 && get().source === source) set({ mergeable: new Set(ids) })
  },
  aim: (raw) => {
    const { source, mergeable, target } = get()
    if (!source) return
    const next =
      raw.kind === 'merge'
        ? mergeable.has(raw.id)
          ? raw
          : null
        : canonicalDrop(useWorkspacesStore.getState(), source, raw)
    if (!sameTarget(target, next)) set({ target: next })
  },
  leave: () => {
    if (get().target !== null) set({ target: null })
  },
  take: () => {
    const { source, target } = get()
    set({ source: null, target: null, mergeable: EMPTY })
    return source && target ? { source, target } : null
  },
  end: () => set({ source: null, target: null, mergeable: EMPTY }),
}))
