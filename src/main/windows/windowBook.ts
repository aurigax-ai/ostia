import type {
  AppSnapshot,
  PanePlacement,
  ScreenPoint,
  SnapshotWorkspace,
  WindowBounds,
} from '../../shared/types'

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

function withoutGroup(workspace: SnapshotWorkspace): SnapshotWorkspace {
  const { groupId: _group, ...rest } = workspace
  return rest
}

export function withWorkspace(snapshot: AppSnapshot, workspace: SnapshotWorkspace): AppSnapshot {
  const base = withoutWorkspace(snapshot, workspace.id)
  return {
    ...base,
    activeWorkspaceId: workspace.id,
    workspaces: [...base.workspaces, withoutGroup(workspace)],
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

const POINT_MAX = 100_000
const GRAB_OFFSET = { x: 120, y: 16 }

export function parsePoint(raw: unknown): ScreenPoint | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { x, y } = raw as Record<string, unknown>
  const valid = [x, y].every(
    (n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= POINT_MAX,
  )
  return valid ? { x: Math.round(x as number), y: Math.round(y as number) } : null
}

export function boundsAt(
  point: ScreenPoint,
  size: { width: number; height: number },
  areas: readonly WindowBounds[],
): WindowBounds {
  const bounds = { x: point.x - GRAB_OFFSET.x, y: point.y - GRAB_OFFSET.y, ...size }
  const home = areas.find(
    (a) => point.x >= a.x && point.x < a.x + a.width && point.y >= a.y && point.y < a.y + a.height,
  )
  return clampBounds(bounds, home ? [home] : areas)
}

export function withoutOrigin(workspace: SnapshotWorkspace): SnapshotWorkspace {
  const { origin: _origin, ...rest } = workspace
  return rest
}

export function crossesSandbox(
  paneWorkspaces: readonly (string | undefined)[],
  destination: string,
  isSandboxed: (workspaceId: string) => boolean,
): boolean {
  return paneWorkspaces.some(
    (from) =>
      from !== undefined &&
      from !== '' &&
      from !== destination &&
      (isSandboxed(from) || isSandboxed(destination)),
  )
}

export interface ReturnPlan {
  windowId: string
  workspace: SnapshotWorkspace
}

export function planReturn(
  workspace: SnapshotWorkspace,
  sourceWindowId: string,
  mainWindowId: string,
  ownerOf: (workspaceId: string) => string | undefined,
  isSandboxed: (workspaceId: string) => boolean,
): ReturnPlan {
  const origin = workspace.origin
  const home = origin && origin.workspaceId !== workspace.id ? origin.workspaceId : null
  const owner = home ? ownerOf(home) : undefined
  if (
    home &&
    owner &&
    owner !== sourceWindowId &&
    !crossesSandbox([workspace.id], home, isSandboxed)
  ) {
    return { windowId: owner, workspace }
  }
  if (!origin) return { windowId: mainWindowId, workspace }
  return {
    windowId: mainWindowId,
    workspace: {
      ...workspace,
      origin: {
        workspaceId: workspace.id,
        index: origin.index,
        ...(origin.groupId ? { groupId: origin.groupId } : {}),
      },
    },
  }
}

export const LANDING_CLAIM_MS = 3000
export const LANDING_GIVE_MS = 60_000

export interface Landing {
  windowId: string
  workspaceId: string
  placement: PanePlacement
}

interface LandingEntry extends Landing {
  at: number
  claimedAt?: number
}

export class Landings {
  private readonly entries = new Map<string, LandingEntry>()

  record(paneId: string, landing: Landing, now: number): void {
    this.entries.set(paneId, { ...landing, at: now })
  }

  private live(paneId: string, now: number): LandingEntry | null {
    const entry = this.entries.get(paneId)
    if (!entry) return null
    const expired = entry.claimedAt
      ? now - entry.claimedAt > LANDING_GIVE_MS
      : now - entry.at > LANDING_CLAIM_MS
    if (expired) this.entries.delete(paneId)
    return expired ? null : entry
  }

  pending(paneId: string, now: number): boolean {
    const entry = this.live(paneId, now)
    return entry !== null && entry.claimedAt === undefined
  }

  claim(paneId: string, now: number): boolean {
    const entry = this.live(paneId, now)
    if (!entry || entry.claimedAt !== undefined) return false
    entry.claimedAt = now
    return true
  }

  take(paneId: string, now: number): Landing | null {
    const entry = this.live(paneId, now)
    if (!entry || entry.claimedAt === undefined) return null
    this.entries.delete(paneId)
    return { windowId: entry.windowId, workspaceId: entry.workspaceId, placement: entry.placement }
  }
}

function withoutBounds(snapshot: AppSnapshot): AppSnapshot {
  const { bounds: _bounds, windows: _windows, ...rest } = snapshot
  return rest
}

export class WindowBook {
  private main: AppSnapshot | null
  private mainBounds: WindowBounds | null
  private readonly detached = new Map<string, DetachedSlot>()

  constructor(file: AppSnapshot | null) {
    const split = splitSnapshot(file)
    this.main = split.main ? withoutBounds(split.main) : null
    this.mainBounds = split.main?.bounds ?? null
    for (const slot of split.detached) this.detached.set(slot.id, slot)
  }

  boundsOf(slot: string): WindowBounds | null {
    if (slot === MAIN_SLOT) return this.mainBounds
    return this.detached.get(slot)?.bounds ?? null
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
      this.main = withoutBounds(snapshot)
      return
    }
    const entry = this.detached.get(slot)
    if (entry) this.detached.set(slot, { ...entry, snapshot: { ...snapshot, groups: [] } })
  }

  setBounds(slot: string, bounds: WindowBounds): void {
    if (slot === MAIN_SLOT) {
      this.mainBounds = bounds
      return
    }
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
    const merged = mergeSnapshots(this.main, this.slots(), savedAt)
    return this.mainBounds ? { ...merged, bounds: this.mainBounds } : merged
  }
}
