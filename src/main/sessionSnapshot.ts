import { rmSync } from 'node:fs'
import { isDangerousSegment } from '../shared/protoGuard'
import type {
  SnapshotNode,
  SnapshotPaneNode,
  SnapshotSession,
  SnapshotSurfaceKind,
  WorkspaceSnapshot,
} from '../shared/types'
import { loadJson, saveJson, storePath } from './jsonStore'
import { PtyRingBuffer } from './ptyRingBuffer'

const SNAPSHOT_VERSION = 1

export const SCROLLBACK_CAP_BYTES = 131_072

const MAX_SESSIONS = 32
const MAX_PANES = 64
const MAX_DEPTH = 12

const SURFACE_KINDS: ReadonlySet<string> = new Set<SnapshotSurfaceKind>([
  'terminal',
  'editor',
  'agent',
  'browser',
  'extension',
])
const SESSION_KINDS: ReadonlySet<string> = new Set(['agent', 'terminal', 'scratch'])

export function snapshotPath(): string {
  return storePath('sessions', 'global')
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
  key: 'cwd' | 'filePath' | 'url' | 'extensionId',
): void {
  const value = src[key]
  if (typeof value === 'string' && value.length > 0) dst[key] = value
}

function parseNode(raw: unknown, paneIds: string[], depth: number): SnapshotNode | null {
  if (depth > MAX_DEPTH || !isRecord(raw)) return null
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
    copyOptionalString(raw, pane, 'filePath')
    copyOptionalString(raw, pane, 'url')
    copyOptionalString(raw, pane, 'extensionId')
    if (pane.kind === 'extension' && !pane.extensionId) return null
    paneIds.push(id)
    return pane
  }

  if (raw.type !== 'split') return null
  if (!Array.isArray(raw.children) || raw.children.length === 0) return null
  const direction = raw.direction === 'vertical' ? 'vertical' : 'horizontal'
  const children: SnapshotNode[] = []
  for (const child of raw.children) {
    const parsed = parseNode(child, paneIds, depth + 1)
    if (!parsed) return null
    children.push(parsed)
  }
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

export function parseSnapshot(raw: unknown): WorkspaceSnapshot | null {
  if (!isRecord(raw) || raw.v !== SNAPSHOT_VERSION || !Array.isArray(raw.sessions)) return null

  const sessions: SnapshotSession[] = []
  const claimedPaneIds = new Set<string>()
  const claimedSessionIds = new Set<string>()

  for (const entry of raw.sessions) {
    if (sessions.length >= MAX_SESSIONS) break
    if (!isRecord(entry)) continue
    const id = entry.id
    if (typeof id !== 'string' || id.length === 0 || claimedSessionIds.has(id)) continue

    const paneIds: string[] = []
    const root = parseNode(entry.root, paneIds, 0)
    if (!root || paneIds.length === 0) continue
    if (new Set(paneIds).size !== paneIds.length) continue
    if (paneIds.some((p) => claimedPaneIds.has(p))) continue

    const workDir = typeof entry.workDir === 'string' && entry.workDir ? entry.workDir : '~'
    sessions.push({
      id,
      name: typeof entry.name === 'string' && entry.name ? entry.name : 'session',
      kind:
        typeof entry.kind === 'string' && SESSION_KINDS.has(entry.kind)
          ? (entry.kind as SnapshotSession['kind'])
          : 'terminal',
      workDir,
      root,
      activePaneId:
        typeof entry.activePaneId === 'string' && paneIds.includes(entry.activePaneId)
          ? entry.activePaneId
          : paneIds[0],
    })
    claimedSessionIds.add(id)
    for (const p of paneIds) claimedPaneIds.add(p)
  }

  if (sessions.length === 0) return null
  const activeSessionId =
    typeof raw.activeSessionId === 'string' && claimedSessionIds.has(raw.activeSessionId)
      ? raw.activeSessionId
      : sessions[0].id
  return {
    v: SNAPSHOT_VERSION,
    savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : '',
    activeSessionId,
    sessions,
  }
}

export function saveSnapshot(snapshot: WorkspaceSnapshot): void {
  saveJson(snapshotPath(), snapshot)
}

export function loadSnapshot(): WorkspaceSnapshot | null {
  return parseSnapshot(loadJson<unknown>(snapshotPath(), null))
}

export function trimScrollback(data: string, capBytes = SCROLLBACK_CAP_BYTES): string {
  if (data.length <= capBytes) return data
  const ring = new PtyRingBuffer(capBytes)
  ring.push(data)
  return ring.since(0).data
}

const restored = new Map<string, string>()

export function saveScrollback(byPane: Record<string, string>): void {
  const out: Record<string, string> = {}
  let kept = 0
  for (const [paneId, data] of Object.entries(byPane)) {
    if (kept >= MAX_PANES) break
    if (!data || isDangerousSegment(paneId)) continue
    out[paneId] = trimScrollback(data)
    kept++
  }
  saveJson(scrollbackPath(), out)
}

export function loadRestoredScrollback(): void {
  restored.clear()
  const raw = loadJson<unknown>(scrollbackPath(), null)
  if (!isRecord(raw)) return
  for (const [paneId, data] of Object.entries(raw)) {
    if (typeof data === 'string' && data && !isDangerousSegment(paneId)) restored.set(paneId, data)
  }
}

export function takeRestoredScrollback(paneId: string): string | null {
  const data = restored.get(paneId)
  if (data === undefined) return null
  restored.delete(paneId)
  return data
}

export function pendingRestoredScrollback(): Record<string, string> {
  return Object.fromEntries(restored)
}

export function dropRestoredScrollback(paneId: string): void {
  restored.delete(paneId)
}

export function clearPersisted(): void {
  restored.clear()
  for (const path of [snapshotPath(), scrollbackPath()]) {
    rmSync(path, { force: true })
  }
}
