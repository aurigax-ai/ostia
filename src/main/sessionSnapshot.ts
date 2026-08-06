/**
 * Session restore — the durable half (docs/ARCHITECTURE.md §"Autosave + resume").
 *
 * Pine is "soft resume", not tmux: quitting still kills every shell (ptys are children of
 * the Electron main process — surviving a quit would need a separate pty-host daemon, a
 * later upgrade). What DOES survive is the *shape* of the workspace plus each terminal's
 * recent output:
 *
 *   - `sessions.json`   — the {@link WorkspaceSnapshot} the renderer pushes over `session:save`
 *                          (which sessions existed, their split-trees, each pane's surface+cwd).
 *   - `scrollback.json` — the tail of each live pty's ring buffer, dumped at `before-quit`
 *                          and replayed into the fresh shell on the next `pty:attach`.
 *
 * Both live under `~/.local/share/pine/` via `jsonStore` (atomic temp+rename), alongside
 * `processes.json`/`wiki.json`/... — and both are hand-editable, so EVERYTHING read back is
 * re-validated by {@link parseSnapshot} before it can touch the UI. A corrupt, hostile, or
 * simply out-of-date file degrades to "no restore", never to a broken window.
 *
 * The honesty rule (borrowed from `processManager.ts`): nothing live is ever restored. A
 * restored session comes back `idle` with a BRAND NEW shell at the saved cwd; the replayed
 * scrollback is history, not a reattached process.
 */
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

/** Bump when the persisted shape changes incompatibly — an older/newer file is then ignored. */
const SNAPSHOT_VERSION = 1

/** Per-pane scrollback kept across a restart (~128KB — a screenful of history, not a log). */
export const SCROLLBACK_CAP_BYTES = 131_072

/**
 * Sanity bounds on the *file*, not on the UI: a hand-edited or corrupt snapshot must not be
 * able to make the renderer build a pathological tree (or make main hold megabytes of
 * scrollback). Real workspaces sit far below all three.
 */
const MAX_SESSIONS = 32
const MAX_PANES = 64
const MAX_DEPTH = 12

const SURFACE_KINDS: ReadonlySet<string> = new Set<SnapshotSurfaceKind>([
  'terminal',
  'editor',
  'agent',
  'browser',
  'kanban',
  'wiki',
])
const SESSION_KINDS: ReadonlySet<string> = new Set(['agent', 'terminal', 'scratch'])

export function snapshotPath(): string {
  return storePath('sessions', 'global')
}

export function scrollbackPath(): string {
  return storePath('scrollback', 'global')
}

// ── Validation ──────────────────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Copy `key` from `src` onto `dst` only when it holds a non-empty string. */
function copyOptionalString(
  src: Record<string, unknown>,
  dst: SnapshotPaneNode,
  key: 'cwd' | 'filePath' | 'url',
): void {
  const value = src[key]
  if (typeof value === 'string' && value.length > 0) dst[key] = value
}

/**
 * Validate one tree node, collecting every pane id it defines into `paneIds`. Returns null
 * for anything unusable — a bad node poisons its whole session rather than being silently
 * dropped, because a half-restored tree is more confusing than no restore.
 */
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
  // Sizes are only proportional weights, so a mismatched/garbage array is recoverable:
  // fall back to an even split rather than throwing the session away over cosmetics.
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

/**
 * Validate + normalize a snapshot read from disk (or pushed by a renderer). Returns null
 * when nothing usable survives. Normalization is deliberately narrow: dangling
 * `activeSessionId`/`activePaneId` references are repaired (they're just focus), while a
 * structurally invalid tree or a **duplicate pane id** drops its whole session — pane ids
 * key main's pty map, so two panes sharing one id would share one shell.
 */
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
    // Reject internal duplicates as well as collisions with an already-accepted session.
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

// ── Snapshot store ──────────────────────────────────────────────────────────────────────

export function saveSnapshot(snapshot: WorkspaceSnapshot): void {
  saveJson(snapshotPath(), snapshot)
}

/** The previous run's workspace, or null when absent / corrupt / a foreign schema version. */
export function loadSnapshot(): WorkspaceSnapshot | null {
  return parseSnapshot(loadJson<unknown>(snapshotPath(), null))
}

// ── Scrollback store ────────────────────────────────────────────────────────────────────

/**
 * Keep the last `capBytes` of `data`, cutting only at a boundary that can't sever an
 * OSC/CSI sequence — reusing `PtyRingBuffer`'s trim so persisted history replays through
 * xterm exactly as live replay does (see that module's header for why a raw slice corrupts
 * the parser and loses shell-integration marks).
 */
export function trimScrollback(data: string, capBytes = SCROLLBACK_CAP_BYTES): string {
  if (data.length <= capBytes) return data
  const ring = new PtyRingBuffer(capBytes)
  ring.push(data)
  return ring.since(0).data
}

/** Loaded at startup and drained by `pty:attach`; a Map so a hostile key can't reach a prototype. */
const restored = new Map<string, string>()

/** Persist the tail of each pane's output. Empty panes are skipped (nothing to replay). */
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

/** (Re)read the saved scrollback into memory. Call once at startup, before any `pty:attach`. */
export function loadRestoredScrollback(): void {
  restored.clear()
  const raw = loadJson<unknown>(scrollbackPath(), null)
  if (!isRecord(raw)) return
  for (const [paneId, data] of Object.entries(raw)) {
    if (typeof data === 'string' && data && !isDangerousSegment(paneId)) restored.set(paneId, data)
  }
}

/**
 * The saved output for `paneId`, consumed on first read. One-shot on purpose: pane ids are
 * handed out again by the renderer's id counter, and a *new* pane that happens to reuse a
 * restored id must not inherit the old shell's history.
 */
export function takeRestoredScrollback(paneId: string): string | null {
  const data = restored.get(paneId)
  if (data === undefined) return null
  restored.delete(paneId)
  return data
}

/** Forget everything on disk (and in memory) — what "restore session: off" actually does. */
export function clearPersisted(): void {
  restored.clear()
  for (const path of [snapshotPath(), scrollbackPath()]) {
    rmSync(path, { force: true })
  }
}
