import { create } from 'zustand'
import { useUIStore } from '@/stores/app/uiStore'
import { useWorkspacesStore } from './workspacesStore'

export type RailEdit =
  | { kind: 'workspace'; id: string; field: 'name' | 'description' }
  | { kind: 'group'; id: string }

interface RailEditState {
  editing: RailEdit | null
  recollapse: boolean
  begin: (edit: RailEdit) => void
  end: (edit?: RailEdit) => void
}

function same(a: RailEdit, b: RailEdit): boolean {
  if (a.kind === 'group' || b.kind === 'group') return a.kind === b.kind && a.id === b.id
  return a.id === b.id && a.field === b.field
}

export const useRailEditStore = create<RailEditState>((set, get) => ({
  editing: null,
  recollapse: false,
  begin: (editing) => set({ editing }),
  end: (edit) => {
    const { editing, recollapse } = get()
    if (editing === null || (edit && !same(edit, editing))) return
    set({ editing: null, recollapse: false })
    if (recollapse) useUIStore.getState().setRailCollapsed(true)
  },
}))

export function revealRailEdit(edit: RailEdit): void {
  const workspaces = useWorkspacesStore.getState()
  const groupId =
    edit.kind === 'group' ? null : workspaces.workspaces.find((w) => w.id === edit.id)?.groupId
  if (groupId && workspaces.groups.some((g) => g.id === groupId && g.collapsed)) {
    workspaces.setGroupCollapsed(groupId, false)
  }
  const ui = useUIStore.getState()
  const recollapse = useRailEditStore.getState().recollapse || ui.railCollapsed
  if (ui.railCollapsed) ui.setRailCollapsed(false)
  useRailEditStore.setState({ editing: edit, recollapse })
}

function shown(edit: RailEdit): boolean {
  const { workspaces, groups } = useWorkspacesStore.getState()
  if (edit.kind === 'group') return groups.some((g) => g.id === edit.id)
  const w = workspaces.find((x) => x.id === edit.id)
  if (!w) return false
  return !groups.some((g) => g.id === w.groupId && g.collapsed)
}

export function startRailEditSync(): () => void {
  const offWorkspaces = useWorkspacesStore.subscribe((s, prev) => {
    const { editing, end } = useRailEditStore.getState()
    if (editing === null) return
    if (s.activeWorkspaceId !== prev.activeWorkspaceId || !shown(editing)) end()
  })
  const offRail = useUIStore.subscribe((s, prev) => {
    if (s.railCollapsed && !prev.railCollapsed) useRailEditStore.getState().end()
  })
  return () => {
    offWorkspaces()
    offRail()
  }
}
