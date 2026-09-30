import type { AppSnapshot, SnapshotWorkspace, WindowBounds } from '../shared/types'

export const MAIN_SLOT = 'main'

export interface DetachedSlot {
  id: string
  bounds: WindowBounds
  snapshot: AppSnapshot
}

function emptySnapshot(savedAt = ''): AppSnapshot {
  return { v: 1, savedAt, activeWorkspaceId: null, workspaces: [], groups: [] }
}

export function withoutWorkspace(snapshot: AppSnapshot, workspaceId: string): AppSnapshot {
  if (!snapshot.workspaces.some((w) => w.id === workspaceId)) return snapshot
  const workspaces = snapshot.workspaces.filter((w) => w.id !== workspaceId)
  const activeWorkspaceId =
    snapshot.activeWorkspaceId === workspaceId
      ? (workspaces[0]?.id ?? null)
      : snapshot.activeWorkspaceId
  return {
    ...snapshot,
    activeWorkspaceId,
    workspaces,
    groups: snapshot.groups.filter((g) => workspaces.some((w) => w.groupId === g.id)),
  }
}

function withoutMarks(workspace: SnapshotWorkspace): SnapshotWorkspace {
  const { groupId: _group, ...rest } = workspace
  return JSON.parse(
    JSON.stringify(rest, (key, value) => (key === 'hibernated' ? undefined : value)),
  )
}

export function withWorkspace(snapshot: AppSnapshot, workspace: SnapshotWorkspace): AppSnapshot {
  const base = withoutWorkspace(snapshot, workspace.id)
  return {
    ...base,
    activeWorkspaceId: workspace.id,
    workspaces: [...base.workspaces, withoutMarks(workspace)],
  }
}

export function splitSnapshot(file: AppSnapshot | null): {
  main: AppSnapshot | null
  detached: DetachedSlot[]
} {
  if (!file) return { main: null, detached: [] }
  const { windows, ...main } = file
  return {
    main,
    detached: (windows ?? []).map((w) => ({
      id: w.id,
      bounds: w.bounds,
      snapshot: {
        ...emptySnapshot(file.savedAt),
        activeWorkspaceId: w.activeWorkspaceId,
        workspaces: w.workspaces,
      },
    })),
  }
}

export function mergeSnapshots(
  main: AppSnapshot | null,
  detached: readonly DetachedSlot[],
  savedAt: string,
): AppSnapshot {
  const base = main ?? emptySnapshot(savedAt)
  const windows = detached
    .filter((slot) => slot.snapshot.workspaces.length > 0)
    .map((slot) => ({
      id: slot.id,
      bounds: slot.bounds,
      activeWorkspaceId: slot.snapshot.activeWorkspaceId,
      workspaces: slot.snapshot.workspaces,
    }))
  const { windows: _stale, ...rest } = base
  return { ...rest, savedAt, ...(windows.length > 0 ? { windows } : {}) }
}

function overlap(a: WindowBounds, b: WindowBounds): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

export function clampBounds(bounds: WindowBounds, areas: readonly WindowBounds[]): WindowBounds {
  if (areas.length === 0) return bounds
  let area = areas[0]
  let best = 0
  for (const candidate of areas) {
    const shared = overlap(bounds, candidate)
    if (shared > best) {
      best = shared
      area = candidate
    }
  }
  const width = Math.min(bounds.width, area.width)
  const height = Math.min(bounds.height, area.height)
  const x = Math.min(Math.max(bounds.x, area.x), area.x + area.width - width)
  const y = Math.min(Math.max(bounds.y, area.y), area.y + area.height - height)
  return { x, y, width, height }
}

export class WindowBook {
  private main: AppSnapshot | null
  private readonly detached = new Map<string, DetachedSlot>()

  constructor(file: AppSnapshot | null) {
    const split = splitSnapshot(file)
    this.main = split.main
    for (const slot of split.detached) this.detached.set(slot.id, slot)
  }

  slots(): DetachedSlot[] {
    return [...this.detached.values()]
  }

  load(slot: string): AppSnapshot | null {
    if (slot === MAIN_SLOT) return this.main
    return this.detached.get(slot)?.snapshot ?? null
  }

  save(slot: string, snapshot: AppSnapshot): void {
    if (slot === MAIN_SLOT) {
      const { windows: _ignored, ...own } = snapshot
      this.main = own
      return
    }
    const entry = this.detached.get(slot)
    if (entry) this.detached.set(slot, { ...entry, snapshot: { ...snapshot, groups: [] } })
  }

  setBounds(slot: string, bounds: WindowBounds): void {
    const entry = this.detached.get(slot)
    if (entry) this.detached.set(slot, { ...entry, bounds })
  }

  open(slot: string, bounds: WindowBounds): void {
    this.detached.set(slot, { id: slot, bounds, snapshot: emptySnapshot() })
  }

  drop(slot: string): void {
    this.detached.delete(slot)
  }

  move(workspace: SnapshotWorkspace, from: string, to: string): void {
    const source = this.load(from)
    if (source) this.save(from, withoutWorkspace(source, workspace.id))
    this.save(to, withWorkspace(this.load(to) ?? emptySnapshot(), workspace))
  }

  merged(savedAt: string): AppSnapshot {
    return mergeSnapshots(this.main, this.slots(), savedAt)
  }
}
