import { existsSync, rmSync } from 'node:fs'
import { parseAgentResume } from '../shared/agentResume'
import { isDangerousSegment } from '../shared/protoGuard'
import { isRemotePath } from '../shared/remoteFolders'
import { normalizeSplitTabName } from '../shared/splitTabs'
import type {
  AppSnapshot,
  PaneDrop,
  PanePlacement,
  PanePlacementZone,
  SnapshotGroup,
  SnapshotNode,
  SnapshotPaneNode,
  SnapshotSurfaceKind,
  SnapshotTabNode,
  SnapshotWindow,
  SnapshotWorkspace,
  WindowBounds,
  WorkspaceOrigin,
} from '../shared/types'
import { VIEW_NAME } from '../shared/views'
import { isWorkspaceGroupColor, normalizeGroupName } from '../shared/workspaceGroups'
import { MAX_LAYOUT_DEPTH, MAX_PANES, MAX_WORKSPACES } from '../shared/workspaceLimits'
import { normalizeDescription } from '../shared/workspaceText'
import { loadJson, saveJson, saveJsonAsync, storePath } from './jsonStore'
import { tailCut } from './ptyRingBuffer'

const SNAPSHOT_VERSION = 1

export const SCROLLBACK_CAP_BYTES = 131_072

const MAX_WINDOWS = 16
const MAX_GROUPS = 32
const CUSTOM_NAME_MAX = 120

const SURFACE_KINDS: ReadonlySet<string> = new Set<SnapshotSurfaceKind>([
  'terminal',
  'editor',
  'agent',
  'browser',
  'extension',
  'chat',
  'view',
])
const WORKSPACE_KINDS: ReadonlySet<string> = new Set(['agent', 'terminal', 'scratch'])
const PLACEMENT_ZONES: ReadonlySet<string> = new Set<PanePlacementZone>([
  'left',
  'right',
  'top',
  'bottom',
  'center',
])
const ID_MAX = 256
const ORIGIN_INDEX_MAX = 1000

export function snapshotPath(): string {
  return storePath('workspaces', 'global')
}

export function scrollbackPath(): string {
  return storePath('scrollback', 'global')
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function copyOptionalString(
  src: Record<string, unknown>,
  dst: SnapshotPaneNode,
  key: 'cwd' | 'filePath' | 'url' | 'extensionId' | 'chatSessionId',
): void {
  const value = src[key]
  if (typeof value === 'string' && value.length > 0) dst[key] = value
}

interface ParseOptions {
  scratch: boolean
}

const SAVED: ParseOptions = { scratch: false }

function tabPaneIds(node: SnapshotNode): string[] {
  return node.type === 'pane' ? [node.id] : node.children.flatMap(tabPaneIds)
}

function parseNode(
  raw: unknown,
  paneIds: string[],
  depth: number,
  inTab = false,
): SnapshotNode | null {
  if (depth > MAX_LAYOUT_DEPTH || !isRecord(raw)) return null
  const id = raw.id
  if (typeof id !== 'string' || id.length === 0) return null

  if (raw.type === 'pane') {
    if (typeof raw.kind !== 'string' || !SURFACE_KINDS.has(raw.kind)) return null
    if (paneIds.length >= MAX_PANES) return null
    const pane: SnapshotPaneNode = {
      type: 'pane',
      id,
      title: typeof raw.title === 'string' ? raw.title : id,
      kind: raw.kind as SnapshotSurfaceKind,
    }
    copyOptionalString(raw, pane, 'cwd')
    if (typeof raw.filePath !== 'string' || !isRemotePath(raw.filePath)) {
      copyOptionalString(raw, pane, 'filePath')
    }
    copyOptionalString(raw, pane, 'url')
    copyOptionalString(raw, pane, 'extensionId')
    if (pane.kind === 'chat') copyOptionalString(raw, pane, 'chatSessionId')
    if (pane.kind === 'browser' && raw.browserProfile === 'shared') pane.browserProfile = 'shared'
    if (typeof raw.viewName === 'string' && VIEW_NAME.test(raw.viewName)) {
      pane.viewName = raw.viewName
    }
    const resume = parseAgentResume(raw.resume)
    if (resume) pane.resume = resume
    if (resume && raw.agentRunning === true && raw.hibernated !== true) pane.agentRunning = true
    if (resume && raw.hibernated === true) pane.hibernated = true
    if (raw.locked === true) pane.locked = true
    if (pane.kind === 'terminal' && raw.defaultTitle === true) pane.defaultTitle = true
    if (raw.titlePinned === true) pane.titlePinned = true
    if (pane.kind === 'extension' && !pane.extensionId) return null
    if (pane.kind === 'view' && !pane.viewName) return null
    paneIds.push(id)
    return pane
  }

  if (raw.type === 'tabs') {
    if (inTab || !Array.isArray(raw.children) || raw.children.length === 0) return null
    const tabs: SnapshotTabNode[] = []
    for (const child of raw.children) {
      if (!isRecord(child) || (child.type !== 'pane' && child.type !== 'split')) return null
      const parsed = parseNode(child, paneIds, depth + 1, true)
      if (!parsed || parsed.type === 'tabs') return null
      const name = parsed.type === 'split' ? normalizeSplitTabName(child.name) : null
      tabs.push(name && parsed.type === 'split' ? { ...parsed, name } : parsed)
    }
    if (tabs.length === 1) return tabs[0]
    const ids = tabs.flatMap(tabPaneIds)
    const activeId = ids.includes(raw.activeId as string) ? (raw.activeId as string) : ids[0]
    return { type: 'tabs', id, children: tabs, activeId }
  }

  if (raw.type !== 'split') return null
  if (!Array.isArray(raw.children) || raw.children.length === 0) return null
  const direction = raw.direction === 'vertical' ? 'vertical' : 'horizontal'
  const children: SnapshotNode[] = []
  for (const child of raw.children) {
    const parsed = parseNode(child, paneIds, depth + 1, inTab)
    if (!parsed) return null
    children.push(parsed)
  }
  if (inTab && children.length === 1) return children[0]
  const raws = raw.sizes
  const sizesOk =
    Array.isArray(raws) &&
    raws.length === children.length &&
    raws.every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0)
  return {
    type: 'split',
    id,
    direction,
    children,
    sizes: sizesOk ? (raws as number[]) : children.map(() => 1),
  }
}

function parseGroups(raw: unknown): SnapshotGroup[] {
  if (!Array.isArray(raw)) return []
  const groups: SnapshotGroup[] = []
  for (const entry of raw) {
    if (groups.length >= MAX_GROUPS) break
    if (!isRecord(entry)) continue
    const id = entry.id
    const name = normalizeGroupName(entry.name)
    if (typeof id !== 'string' || !id || !name || groups.some((g) => g.id === id)) continue
    groups.push({
      id,
      name,
      ...(isWorkspaceGroupColor(entry.color) ? { color: entry.color } : {}),
      ...(entry.collapsed === true ? { collapsed: true } : {}),
    })
  }
  return groups
}

function isId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= ID_MAX
}

export function parsePlacement(raw: unknown): PanePlacement | null {
  if (!isRecord(raw) || !isId(raw.paneId)) return null
  if (typeof raw.zone !== 'string' || !PLACEMENT_ZONES.has(raw.zone)) return null
  return { paneId: raw.paneId, zone: raw.zone as PanePlacementZone }
}

export function parsePaneDrop(raw: unknown): PaneDrop | null {
  if (!isRecord(raw) || !isId(raw.paneId) || !isId(raw.workspaceId)) return null
  const placement = parsePlacement(raw.placement)
  return placement ? { paneId: raw.paneId, workspaceId: raw.workspaceId, placement } : null
}

export function parseOrigin(raw: unknown): WorkspaceOrigin | null {
  if (!isRecord(raw) || !isId(raw.workspaceId)) return null
  const index = raw.index
  const beside = parsePlacement(raw.beside)
  return {
    workspaceId: raw.workspaceId,
    index:
      typeof index === 'number' && Number.isInteger(index)
        ? Math.min(Math.max(index, 0), ORIGIN_INDEX_MAX)
        : 0,
    ...(isId(raw.groupId) ? { groupId: raw.groupId } : {}),
    ...(beside ? { beside } : {}),
  }
}

interface Claims {
  panes: Set<string>
  workspaces: Set<string>
}

function parseWorkspace(
  entry: unknown,
  knownGroups: SnapshotGroup[],
  claims: Claims,
  opts: ParseOptions,
): SnapshotWorkspace | null {
  if (!isRecord(entry)) return null
  const id = entry.id
  if (typeof id !== 'string' || id.length === 0 || claims.workspaces.has(id)) return null
  if (entry.kind === 'scratch' && !opts.scratch) return null

  const paneIds: string[] = []
  const root = entry.root === undefined ? undefined : parseNode(entry.root, paneIds, 0)
  if (root === null) return null
  if (root && paneIds.length === 0) return null
  if (new Set(paneIds).size !== paneIds.length) return null
  if (paneIds.some((p) => claims.panes.has(p))) return null
  const customName =
    typeof entry.customName === 'string' ? entry.customName.trim().slice(0, CUSTOM_NAME_MAX) : ''

  const workDir = typeof entry.workDir === 'string' && entry.workDir ? entry.workDir : '~'
  const description = normalizeDescription(entry.description)
  const origin = parseOrigin(entry.origin)
  claims.workspaces.add(id)
  for (const p of paneIds) claims.panes.add(p)
  return {
    id,
    name: typeof entry.name === 'string' && entry.name ? entry.name : 'workspace',
    ...(customName ? { customName } : {}),
    ...(description ? { description } : {}),
    ...(entry.pinned === true ? { pinned: true } : {}),
    ...(entry.pinned !== true && knownGroups.some((g) => g.id === entry.groupId)
      ? { groupId: entry.groupId as string }
      : {}),
    kind:
      typeof entry.kind === 'string' && WORKSPACE_KINDS.has(entry.kind)
        ? (entry.kind as SnapshotWorkspace['kind'])
        : 'terminal',
    workDir,
    ...(typeof entry.projectDir === 'string' && entry.projectDir
      ? { projectDir: entry.projectDir.slice(0, 4096) }
      : {}),
    ...(entry.anchored === true ? { anchored: true as const } : {}),
    ...(root
      ? {
          root,
          activePaneId:
            typeof entry.activePaneId === 'string' && paneIds.includes(entry.activePaneId)
              ? entry.activePaneId
              : paneIds[0],
        }
      : {}),
    ...(origin ? { origin } : {}),
  }
}

function parseWorkspaceList(
  raw: unknown[],
  knownGroups: SnapshotGroup[],
  claims: Claims,
  opts: ParseOptions,
  limit: number,
): SnapshotWorkspace[] {
  const workspaces: SnapshotWorkspace[] = []
  for (const entry of raw) {
    if (workspaces.length >= limit) break
    const parsed = parseWorkspace(entry, knownGroups, claims, opts)
    if (parsed) workspaces.push(parsed)
  }
  return workspaces
}

function activeOf(raw: unknown, workspaces: SnapshotWorkspace[]): string | null {
  return typeof raw === 'string' && workspaces.some((w) => w.id === raw)
    ? raw
    : (workspaces[0]?.id ?? null)
}

const BOUNDS_MIN = 100
const BOUNDS_MAX = 100_000

export function parseBounds(raw: unknown): WindowBounds | null {
  if (!isRecord(raw)) return null
  const { x, y, width, height } = raw
  const coords = [x, y].every(
    (n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= BOUNDS_MAX,
  )
  const sizes = [width, height].every(
    (n) => typeof n === 'number' && Number.isFinite(n) && n >= BOUNDS_MIN && n <= BOUNDS_MAX,
  )
  if (!coords || !sizes) return null
  return {
    x: Math.round(x as number),
    y: Math.round(y as number),
    width: Math.round(width as number),
    height: Math.round(height as number),
  }
}

const WINDOW_ID = /^[A-Za-z0-9-]{1,40}$/

function parseWindows(raw: unknown, claims: Claims, budget: number): SnapshotWindow[] {
  if (!Array.isArray(raw)) return []
  const windows: SnapshotWindow[] = []
  let left = budget
  for (const entry of raw) {
    if (windows.length >= MAX_WINDOWS || left <= 0) break
    if (!isRecord(entry) || !Array.isArray(entry.workspaces)) continue
    const id = entry.id
    const bounds = parseBounds(entry.bounds)
    if (typeof id !== 'string' || !WINDOW_ID.test(id) || !bounds) continue
    if (windows.some((w) => w.id === id)) continue
    const workspaces = parseWorkspaceList(entry.workspaces, [], claims, SAVED, left)
    if (workspaces.length === 0) continue
    left -= workspaces.length
    windows.push({
      id,
      bounds,
      activeWorkspaceId: activeOf(entry.activeWorkspaceId, workspaces),
      workspaces,
    })
  }
  return windows
}

export function parseSnapshot(raw: unknown): AppSnapshot | null {
  if (!isRecord(raw) || raw.v !== SNAPSHOT_VERSION || !Array.isArray(raw.workspaces)) return null
  const knownGroups = parseGroups(raw.groups)
  const claims: Claims = { panes: new Set(), workspaces: new Set() }
  const workspaces = parseWorkspaceList(raw.workspaces, knownGroups, claims, SAVED, MAX_WORKSPACES)
  const windows = parseWindows(raw.windows, claims, MAX_WORKSPACES - workspaces.length)
  return {
    v: SNAPSHOT_VERSION,
    savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : '',
    activeWorkspaceId: activeOf(raw.activeWorkspaceId, workspaces),
    workspaces,
    groups: knownGroups.filter((g) => workspaces.some((w) => w.groupId === g.id)),
    ...(windows.length > 0 ? { windows } : {}),
  }
}

export function parseHandoff(raw: unknown): SnapshotWorkspace | null {
  const claims: Claims = { panes: new Set(), workspaces: new Set() }
  return parseWorkspace(raw, [], claims, { scratch: true })
}

export function handoffPaneIds(workspace: SnapshotWorkspace): string[] {
  const ids: string[] = []
  const walk = (node: SnapshotNode): void => {
    if (node.type === 'pane') ids.push(node.id)
    else for (const child of node.children) walk(child)
  }
  if (workspace.root) walk(workspace.root)
  return ids
}

export function saveSnapshot(snapshot: AppSnapshot): void {
  saveJson(snapshotPath(), snapshot)
}

export function loadSnapshot(): AppSnapshot | null {
  return parseSnapshot(loadJson<unknown>(snapshotPath(), null))
}

export function trimScrollback(data: string, capBytes = SCROLLBACK_CAP_BYTES): string {
  return data.slice(tailCut(data, capBytes))
}

const restored = new Map<string, string>()

export function scrollbackToSave(
  byPane: Record<string, string>,
  unsaved: (paneId: string) => boolean = () => false,
): Record<string, string> {
  const out: Record<string, string> = {}
  let kept = 0
  for (const [paneId, data] of Object.entries(byPane)) {
    if (kept >= MAX_PANES) break
    if (!data || isDangerousSegment(paneId) || unsaved(paneId)) continue
    out[paneId] = trimScrollback(data)
    kept++
  }
  return out
}

let scrollbackEpoch = 0
let scrollbackWrites: Promise<void> = Promise.resolve()

export function saveScrollback(
  byPane: Record<string, string>,
  unsaved: (paneId: string) => boolean = () => false,
): Promise<void> {
  const epoch = scrollbackEpoch
  const data = scrollbackToSave(byPane, unsaved)
  const write = scrollbackWrites.then(() =>
    epoch === scrollbackEpoch ? saveJsonAsync(scrollbackPath(), data) : undefined,
  )
  scrollbackWrites = write.catch(() => undefined)
  return write
}

export type RestoreOutcome = 'ok' | 'none' | 'failed'

export function loadRestoredScrollback(): RestoreOutcome {
  restored.clear()
  if (!existsSync(scrollbackPath())) return 'none'
  const raw = loadJson<unknown>(scrollbackPath(), null)
  if (!isRecord(raw)) return 'failed'
  for (const [paneId, data] of Object.entries(raw)) {
    if (typeof data === 'string' && data && !isDangerousSegment(paneId)) restored.set(paneId, data)
  }
  return 'ok'
}

export function takeRestoredScrollback(paneId: string): string | null {
  const data = restored.get(paneId)
  if (data === undefined) return null
  restored.delete(paneId)
  return data
}

export function stashedScreen(
  paneId: string,
  askingWindow: string,
  ownerWindow: string | undefined,
): string | null {
  if (ownerWindow === undefined || ownerWindow !== askingWindow) return null
  return restored.get(paneId) ?? null
}

export function stashScrollback(paneId: string, data: string): void {
  if (!data || isDangerousSegment(paneId)) return
  restored.set(paneId, trimScrollback(data))
}

export function pendingRestoredScrollback(): Record<string, string> {
  return Object.fromEntries(restored)
}

export function dropRestoredScrollback(paneId: string): void {
  restored.delete(paneId)
}

export function clearPersisted(): Promise<void> {
  restored.clear()
  scrollbackEpoch++
  for (const path of [snapshotPath(), scrollbackPath()]) {
    rmSync(path, { force: true })
  }
  scrollbackWrites = scrollbackWrites.then(() => rmSync(scrollbackPath(), { force: true }))
  return scrollbackWrites
}
