import { randomUUID } from 'node:crypto'
import { type BrowserWindow, screen } from 'electron'
import type { WindowWorkspaceReport } from '../../shared/windows/windowsApi'
import type {
  AppSnapshot,
  SnapshotWorkspace,
  WindowBounds,
} from '../../shared/workspaces/workspaceApi'
import { MAX_WORKSPACES } from '../../shared/workspaces/workspaceLimits'
import { approvals } from '../approvals/approvals'
import { questions } from '../approvals/questions'
import { getByPaneId, panesOwnedBy, rehomePanes } from '../control/idRegistry'
import { handoffPaneIds, parseHandoff, parsePaneDrop } from '../workspaces/workspaceSnapshot'
import {
  boundsAt,
  clampBounds,
  crossesSandbox,
  Landings,
  MAIN_SLOT,
  parsePoint,
  planReturn,
  type WindowBook,
  withoutOrigin,
} from './windowBook'

const DETACHED_SIZE = { width: 1100, height: 760 }
const DETACHED_OFFSET = 48
const LANDING_WAIT_MS = 500

export function windowIdOf(win: BrowserWindow): string {
  return String(win.webContents.id)
}

export function workAreas(): WindowBounds[] {
  const primary = screen.getPrimaryDisplay()
  const others = screen.getAllDisplays().filter((d) => d.id !== primary.id)
  return [primary, ...others].map((d) => d.workArea)
}

interface WindowHandoffState {
  book: WindowBook
  slots: Map<string, string>
  windows: Map<string, BrowserWindow>
  boot: Map<string, AppSnapshot>
  reports: Map<string, WindowWorkspaceReport[]>
  returning: WeakSet<BrowserWindow>
  closing: WeakSet<BrowserWindow>
}

interface WindowHandoffDeps {
  createWindow: (slot: string, bounds?: WindowBounds) => BrowserWindow
  holdPtys: (paneIds: readonly string[]) => void
  isSandboxed: (workspaceId: string) => boolean
  reveal: (win: BrowserWindow) => void
  persist: () => void
  mainWindow: () => BrowserWindow | undefined
  windowOfWorkspace: (workspaceId: string) => string | undefined
}

export class WindowHandoffs {
  private readonly landings = new Landings()
  private readonly landingWaiters = new Map<string, () => void>()
  private readonly book: WindowBook
  private readonly slots: Map<string, string>
  private readonly windows: Map<string, BrowserWindow>
  private readonly boot: Map<string, AppSnapshot>
  private readonly reports: Map<string, WindowWorkspaceReport[]>
  private readonly returning: WeakSet<BrowserWindow>
  private readonly closing: WeakSet<BrowserWindow>

  constructor(
    state: WindowHandoffState,
    private readonly deps: WindowHandoffDeps,
  ) {
    this.book = state.book
    this.slots = state.slots
    this.windows = state.windows
    this.boot = state.boot
    this.reports = state.reports
    this.returning = state.returning
    this.closing = state.closing
  }

  private moveOwnership(workspace: SnapshotWorkspace, windowId: string): void {
    for (const [owner, summaries] of this.reports) {
      if (owner !== windowId && summaries.some((w) => w.id === workspace.id)) {
        this.reports.set(
          owner,
          summaries.filter((w) => w.id !== workspace.id),
        )
      }
    }
    const paneIds = handoffPaneIds(workspace)
    const moved = rehomePanes(paneIds, windowId)
    const movedIds = moved.map((identity) => identity.externalId)
    approvals()?.rehome(movedIds, windowId)
    questions()?.rehome(movedIds, windowId)
    this.deps.holdPtys(paneIds)
  }

  private ownsWorkspace(workspace: SnapshotWorkspace, windowId: string): boolean {
    const owner = this.deps.windowOfWorkspace(workspace.id)
    if (owner !== undefined && owner !== windowId) return false
    return panesOwnedBy(handoffPaneIds(workspace), windowId)
  }

  private detachedBounds(source: BrowserWindow | null): WindowBounds {
    const origin = source && !source.isDestroyed() ? source.getBounds() : { x: 0, y: 0 }
    return clampBounds(
      {
        x: origin.x + DETACHED_OFFSET,
        y: origin.y + DETACHED_OFFSET,
        ...DETACHED_SIZE,
      },
      workAreas(),
    )
  }

  private reopenedBounds(workspaceId: string, source: BrowserWindow): WindowBounds {
    const last = this.book.lastDetachedBounds(workspaceId)
    return last ? clampBounds(last, workAreas()) : this.detachedBounds(source)
  }

  private leavesSandbox(workspace: SnapshotWorkspace, destination: string): boolean {
    const from = handoffPaneIds(workspace).map((paneId) => getByPaneId(paneId)?.workspaceId)
    return crossesSandbox(from, destination, this.deps.isSandboxed)
  }

  detach(source: BrowserWindow, raw: unknown, rawPoint: unknown): boolean {
    const sourceId = windowIdOf(source)
    const sourceSlot = this.slots.get(sourceId)
    const workspace = parseHandoff(raw)
    if (!sourceSlot || !workspace || !this.ownsWorkspace(workspace, sourceId)) return false
    if (this.leavesSandbox(workspace, workspace.id)) return false
    const slot = randomUUID().slice(0, 8)
    const point = parsePoint(rawPoint)
    const bounds = point
      ? boundsAt(point, DETACHED_SIZE, workAreas())
      : this.reopenedBounds(workspace.id, source)
    this.book.open(slot, bounds)
    this.book.move(workspace, sourceSlot, slot)
    this.boot.set(slot, {
      v: 1,
      savedAt: '',
      activeWorkspaceId: workspace.id,
      workspaces: [workspace],
      groups: [],
    })
    const win = this.deps.createWindow(slot, bounds)
    this.moveOwnership(workspace, windowIdOf(win))
    this.deps.persist()
    return true
  }

  openWith(source: BrowserWindow, raw: unknown): boolean {
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_WORKSPACES) return false
    const parsed = raw.map(parseHandoff)
    if (parsed.some((w) => w === null)) return false
    const workspaces = parsed as SnapshotWorkspace[]
    const paneIds = workspaces.flatMap(handoffPaneIds)
    if (new Set(workspaces.map((w) => w.id)).size !== workspaces.length) return false
    if (new Set(paneIds).size !== paneIds.length) return false
    if (workspaces.some((w) => this.deps.windowOfWorkspace(w.id) !== undefined)) return false
    if (paneIds.some((paneId) => getByPaneId(paneId) !== undefined)) return false
    const slot = randomUUID().slice(0, 8)
    const bounds = this.reopenedBounds(workspaces[0].id, source)
    const snapshot: AppSnapshot = {
      v: 1,
      savedAt: '',
      activeWorkspaceId: workspaces[0].id,
      workspaces,
      groups: [],
    }
    this.book.open(slot, bounds)
    this.book.save(slot, snapshot)
    this.boot.set(slot, snapshot)
    this.deps.createWindow(slot, bounds)
    this.deps.persist()
    return true
  }

  returnWorkspaces(
    source: BrowserWindow,
    slot: string,
    workspaces: SnapshotWorkspace[],
    quiet: boolean,
  ): boolean {
    const main = this.deps.mainWindow()
    if (!main || main.isDestroyed()) return false
    const mainId = windowIdOf(main)
    const sourceId = windowIdOf(source)
    const byWindow = new Map<string, SnapshotWorkspace[]>()
    for (const workspace of workspaces) {
      const plan = planReturn(
        workspace,
        sourceId,
        mainId,
        (id) => this.deps.windowOfWorkspace(id),
        this.deps.isSandboxed,
      )
      const targetId = this.windows.has(plan.windowId) ? plan.windowId : mainId
      this.moveOwnership(plan.workspace, targetId)
      this.book.move(withoutOrigin(plan.workspace), slot, this.slots.get(targetId) ?? MAIN_SLOT)
      byWindow.set(targetId, [...(byWindow.get(targetId) ?? []), plan.workspace])
    }
    this.book.drop(slot)
    this.deps.persist()
    for (const [targetId, adopted] of byWindow) {
      const target = this.windows.get(targetId)
      if (!target || target.isDestroyed()) continue
      target.webContents.send('windows:adopt', adopted)
      if (!quiet || target.isVisible()) this.deps.reveal(target)
    }
    this.returning.add(source)
    if (!source.isDestroyed()) source.close()
    return true
  }

  returnFrom(source: BrowserWindow, raw: unknown): boolean {
    const sourceId = windowIdOf(source)
    const slot = this.slots.get(sourceId)
    const quiet = this.closing.has(source)
    this.closing.delete(source)
    if (!slot || slot === MAIN_SLOT || !Array.isArray(raw)) return false
    const workspaces = raw.map(parseHandoff)
    if (workspaces.some((w) => w === null)) return false
    const parsed = workspaces as SnapshotWorkspace[]
    if (!parsed.every((w) => this.ownsWorkspace(w, sourceId))) return false
    return this.returnWorkspaces(source, slot, parsed, quiet)
  }

  recordDrop(target: BrowserWindow, raw: unknown): void {
    const drop = parsePaneDrop(raw)
    if (!drop) return
    const targetId = windowIdOf(target)
    const owner = getByPaneId(drop.paneId)?.windowId
    if (!owner || owner === targetId || !this.windows.has(owner)) return
    if (this.deps.windowOfWorkspace(drop.workspaceId) !== targetId) return
    if (getByPaneId(drop.placement.paneId)?.windowId !== targetId) return
    this.landings.record(
      drop.paneId,
      { windowId: targetId, workspaceId: drop.workspaceId, placement: drop.placement },
      Date.now(),
    )
    this.landingWaiters.get(drop.paneId)?.()
  }

  async claimLanding(source: BrowserWindow, paneId: unknown): Promise<boolean> {
    if (typeof paneId !== 'string') return false
    if (getByPaneId(paneId)?.windowId !== windowIdOf(source)) return false
    if (!this.landings.pending(paneId, Date.now())) {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer)
          this.landingWaiters.delete(paneId)
          resolve()
        }
        const timer = setTimeout(done, LANDING_WAIT_MS)
        this.landingWaiters.set(paneId, done)
      })
    }
    return this.landings.claim(paneId, Date.now())
  }

  give(source: BrowserWindow, raw: unknown): boolean {
    const sourceId = windowIdOf(source)
    const sourceSlot = this.slots.get(sourceId)
    const workspace = parseHandoff(raw)
    if (!sourceSlot || !workspace || !this.ownsWorkspace(workspace, sourceId)) return false
    const paneIds = handoffPaneIds(workspace)
    const landing = paneIds.length === 1 ? this.landings.take(paneIds[0], Date.now()) : null
    if (!landing) return false
    const target = this.windows.get(landing.windowId)
    const targetSlot = this.slots.get(landing.windowId)
    if (!target || target.isDestroyed() || !targetSlot) return false
    if (this.leavesSandbox(workspace, landing.workspaceId)) return false
    const placed: SnapshotWorkspace = {
      ...workspace,
      origin: { workspaceId: landing.workspaceId, index: 0, beside: landing.placement },
    }
    this.moveOwnership(placed, landing.windowId)
    this.book.move(withoutOrigin(placed), sourceSlot, targetSlot)
    this.deps.persist()
    target.webContents.send('windows:adopt', [placed])
    this.deps.reveal(target)
    return true
  }
}
