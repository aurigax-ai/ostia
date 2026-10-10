import { randomUUID } from 'node:crypto'
import { type BrowserWindow, ipcMain, screen } from 'electron'
import { debounce } from 'es-toolkit'
import type {
  AppSnapshot,
  CommandResult,
  CommandTarget,
  NewWorkspaceRequest,
  SnapshotWorkspace,
  WindowBounds,
  WindowInfo,
  WindowPaneReport,
  WindowSummary,
  WindowWorkspaceReport,
  WorkspaceLiveState,
} from '../../shared/types'
import { MAX_WORKSPACES } from '../../shared/workspaces/workspaceLimits'
import type { AgentRunningPanes } from '../agents/agentRunning'
import {
  type OriginRules,
  ReferenceRelay,
  originAgentOwner,
  originAgents,
  parseAttentionState,
  parsePaneAgent,
  parseReferenceRequest,
  reachesTarget,
  summaryOf,
} from '../agents/originAgents'
import { approvals } from '../approvals/approvals'
import { questions } from '../approvals/questions'
import { getByPaneId, panesOwnedBy, rehomePanes } from '../control/idRegistry'
import {
  clearPersisted,
  handoffPaneIds,
  loadSnapshot,
  parseHandoff,
  parsePaneDrop,
  parseSnapshot,
  saveSnapshot,
} from '../workspaces/workspaceSnapshot'
import {
  Landings,
  MAIN_SLOT,
  WindowBook,
  boundsAt,
  clampBounds,
  crossesSandbox,
  parsePoint,
  planReturn,
  withoutOrigin,
} from './windowBook'

export interface WindowBrokerDeps {
  createWindow: (slot: string, bounds?: WindowBounds) => BrowserWindow
  holdPtys: (paneIds: readonly string[]) => void
  execCommand: (target: CommandTarget, id: string, args?: unknown) => Promise<CommandResult>
  agents: AgentRunningPanes
  isSandboxed: (workspaceId: string) => boolean
  isScratch: (workspaceId: string) => boolean
  reveal: (win: BrowserWindow) => void
  onList: (list: WindowSummary[]) => void
}

const DETACHED_SIZE = { width: 1100, height: 760 }
const DETACHED_OFFSET = 48
const BOUNDS_SAVE_MS = 500
const SUMMARY_MAX = 64
const TEXT_MAX = 256
const STATES: ReadonlySet<string> = new Set<WorkspaceLiveState>([
  'idle',
  'working',
  'waiting',
  'done',
  'error',
])
const WORKSPACE_DIR = /^(~|\/)/
const PANES_MAX = 64
const LANDING_WAIT_MS = 500

function parsePanes(raw: unknown): WindowPaneReport[] {
  if (!Array.isArray(raw)) return []
  const panes: WindowPaneReport[] = []
  for (const entry of raw.slice(0, PANES_MAX)) {
    if (typeof entry !== 'object' || entry === null) continue
    const { id, title, agent, state, cwd } = entry as Record<string, unknown>
    if (typeof id !== 'string' || !id || typeof title !== 'string') continue
    const paneAgent = parsePaneAgent(agent)
    const paneState = parseAttentionState(state)
    panes.push({
      id: id.slice(0, TEXT_MAX),
      title: title.slice(0, TEXT_MAX),
      ...(paneAgent ? { agent: paneAgent } : {}),
      ...(paneState ? { state: paneState } : {}),
      ...(typeof cwd === 'string' && cwd ? { cwd: cwd.slice(0, TEXT_MAX) } : {}),
    })
  }
  return panes
}

function windowIdOf(win: BrowserWindow): string {
  return String(win.webContents.id)
}

function workAreas(): WindowBounds[] {
  const primary = screen.getPrimaryDisplay()
  const others = screen.getAllDisplays().filter((d) => d.id !== primary.id)
  return [primary, ...others].map((d) => d.workArea)
}

export function parseReports(raw: unknown): WindowWorkspaceReport[] {
  if (!Array.isArray(raw)) return []
  const out: WindowWorkspaceReport[] = []
  for (const entry of raw.slice(0, SUMMARY_MAX)) {
    if (typeof entry !== 'object' || entry === null) continue
    const { id, name, workDir, state, unreadAt, panes, origin } = entry as Record<string, unknown>
    if (typeof id !== 'string' || !id || typeof name !== 'string') continue
    out.push({
      id: id.slice(0, TEXT_MAX),
      name: name.slice(0, TEXT_MAX),
      workDir: typeof workDir === 'string' ? workDir.slice(0, TEXT_MAX) : '',
      state:
        typeof state === 'string' && STATES.has(state) ? (state as WorkspaceLiveState) : 'idle',
      unreadAt: typeof unreadAt === 'number' && Number.isFinite(unreadAt) ? unreadAt : 0,
      panes: parsePanes(panes),
      ...(typeof origin === 'string' && origin ? { origin: origin.slice(0, TEXT_MAX) } : {}),
    })
  }
  return out
}

export class WindowBroker {
  private readonly book = new WindowBook(loadSnapshot())
  private readonly slots = new Map<string, string>()
  private readonly windows = new Map<string, BrowserWindow>()
  private readonly boot = new Map<string, AppSnapshot>()
  private readonly reports = new Map<string, WindowWorkspaceReport[]>()
  private readonly originRules: OriginRules
  private readonly references = new ReferenceRelay((windowId, insert) => {
    const win = this.windows.get(windowId)
    if (!win || win.isDestroyed()) return false
    win.webContents.send('windows:reference-insert', insert)
    return true
  })
  private readonly returning = new WeakSet<BrowserWindow>()
  private readonly closing = new WeakSet<BrowserWindow>()
  private readonly landings = new Landings()
  private readonly landingWaiters = new Map<string, () => void>()
  private persistEnabled = true
  private readonly debouncedPersist = debounce(() => this.persist(), BOUNDS_SAVE_MS)

  constructor(private readonly deps: WindowBrokerDeps) {
    this.originRules = {
      isSandboxed: deps.isSandboxed,
      isScratch: deps.isScratch,
      isManagerPane: (paneId) => getByPaneId(paneId)?.manager === true,
      ownerOfPane: (paneId) => getByPaneId(paneId)?.windowId,
    }
    deps.agents.seed(this.book.merged(''))
  }

  get persisting(): boolean {
    return this.persistEnabled
  }

  openAll(): void {
    this.deps.createWindow(MAIN_SLOT, this.restoredBounds(MAIN_SLOT))
    for (const slot of this.book.slots()) {
      this.deps.createWindow(slot.id, this.restoredBounds(slot.id))
    }
  }

  restoredBounds(slot: string): WindowBounds | undefined {
    const bounds = this.book.boundsOf(slot)
    return bounds ? clampBounds(bounds, workAreas()) : undefined
  }

  track(win: BrowserWindow, slot: string): void {
    const windowId = windowIdOf(win)
    this.slots.set(windowId, slot)
    this.windows.set(windowId, win)
    const capture = (): boolean => {
      if (win.isDestroyed() || win.isMinimized()) return false
      this.book.setBounds(slot, win.getNormalBounds())
      return true
    }
    const remember = (): void => {
      if (capture()) this.debouncedPersist()
    }
    win.on('move', remember)
    win.on('resize', remember)
    win.on('close', () => {
      if (capture()) this.persist()
    })
    win.on('closed', () => {
      this.slots.delete(windowId)
      this.windows.delete(windowId)
      this.reports.delete(windowId)
      this.references.windowClosed(windowId)
      this.broadcastList()
    })
  }

  isDetached(win: BrowserWindow): boolean {
    const slot = this.slots.get(windowIdOf(win))
    return slot !== undefined && slot !== MAIN_SLOT
  }

  hasDetached(): boolean {
    return [...this.slots.values()].some((slot) => slot !== MAIN_SLOT)
  }

  isReturning(win: BrowserWindow): boolean {
    return this.returning.has(win)
  }

  mainWindow(): BrowserWindow | undefined {
    for (const [windowId, slot] of this.slots) {
      if (slot === MAIN_SLOT) return this.windows.get(windowId)
    }
    return undefined
  }

  windowIds(): string[] {
    const main = this.mainWindow()
    const ids = [...this.windows.keys()]
    if (!main) return ids
    const mainId = windowIdOf(main)
    return [mainId, ...ids.filter((id) => id !== mainId)]
  }

  workspacesOf(win: BrowserWindow): WindowWorkspaceReport[] {
    return this.reports.get(windowIdOf(win)) ?? []
  }

  windowOfWorkspace(workspaceId: string): string | undefined {
    for (const [windowId, workspaces] of this.reports) {
      if (workspaces.some((w) => w.id === workspaceId)) return windowId
    }
    return undefined
  }

  reaches(senderWindowId: string, sourcePaneId: string, targetPaneId: string): boolean {
    return reachesTarget(this.reports, this.originRules, senderWindowId, sourcePaneId, targetPaneId)
  }

  private forwardReference(windowId: string, raw: unknown): Promise<boolean> {
    const request = parseReferenceRequest(raw)
    if (!request) return Promise.resolve(false)
    const owner = originAgentOwner(
      this.reports,
      this.originRules,
      windowId,
      request.workspaceId,
      request.paneId,
    )
    return owner ? this.references.forward(owner, request) : Promise.resolve(false)
  }

  requestReturn(win: BrowserWindow, closing = false): void {
    const slot = this.slots.get(windowIdOf(win))
    if (!slot || slot === MAIN_SLOT) return
    if (win.webContents.isCrashed() || win.webContents.isLoading()) {
      this.returnWorkspaces(win, slot, this.book.load(slot)?.workspaces ?? [], closing)
      return
    }
    if (closing) this.closing.add(win)
    else this.closing.delete(win)
    this.deps.reveal(win)
    win.webContents.send('windows:return-request')
  }

  persist(): void {
    if (!this.persistEnabled) return
    try {
      const merged = parseSnapshot(this.book.merged(new Date().toISOString()))
      if (merged) saveSnapshot(this.deps.agents.mark(merged))
    } catch (err) {
      console.error('[workspace] snapshot save failed', err)
    }
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
    const owner = this.windowOfWorkspace(workspace.id)
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

  private leavesSandbox(workspace: SnapshotWorkspace, destination: string): boolean {
    const from = handoffPaneIds(workspace).map((paneId) => getByPaneId(paneId)?.workspaceId)
    return crossesSandbox(from, destination, this.deps.isSandboxed)
  }

  private detach(source: BrowserWindow, raw: unknown, rawPoint: unknown): boolean {
    const sourceId = windowIdOf(source)
    const sourceSlot = this.slots.get(sourceId)
    const workspace = parseHandoff(raw)
    if (!sourceSlot || !workspace || !this.ownsWorkspace(workspace, sourceId)) return false
    if (this.leavesSandbox(workspace, workspace.id)) return false
    const slot = randomUUID().slice(0, 8)
    const point = parsePoint(rawPoint)
    const bounds = point ? boundsAt(point, DETACHED_SIZE, workAreas()) : this.detachedBounds(source)
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
    this.persist()
    return true
  }

  private openWith(source: BrowserWindow, raw: unknown): boolean {
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_WORKSPACES) return false
    const parsed = raw.map(parseHandoff)
    if (parsed.some((w) => w === null)) return false
    const workspaces = parsed as SnapshotWorkspace[]
    const paneIds = workspaces.flatMap(handoffPaneIds)
    if (new Set(workspaces.map((w) => w.id)).size !== workspaces.length) return false
    if (new Set(paneIds).size !== paneIds.length) return false
    if (workspaces.some((w) => this.windowOfWorkspace(w.id) !== undefined)) return false
    if (paneIds.some((paneId) => getByPaneId(paneId) !== undefined)) return false
    const slot = randomUUID().slice(0, 8)
    const bounds = this.detachedBounds(source)
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
    this.persist()
    return true
  }

  private returnWorkspaces(
    source: BrowserWindow,
    slot: string,
    workspaces: SnapshotWorkspace[],
    quiet: boolean,
  ): boolean {
    const main = this.mainWindow()
    if (!main || main.isDestroyed()) return false
    const mainId = windowIdOf(main)
    const sourceId = windowIdOf(source)
    const byWindow = new Map<string, SnapshotWorkspace[]>()
    for (const workspace of workspaces) {
      const plan = planReturn(
        workspace,
        sourceId,
        mainId,
        (id) => this.windowOfWorkspace(id),
        this.deps.isSandboxed,
      )
      const targetId = this.windows.has(plan.windowId) ? plan.windowId : mainId
      this.moveOwnership(plan.workspace, targetId)
      this.book.move(withoutOrigin(plan.workspace), slot, this.slots.get(targetId) ?? MAIN_SLOT)
      byWindow.set(targetId, [...(byWindow.get(targetId) ?? []), plan.workspace])
    }
    this.book.drop(slot)
    this.persist()
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

  private returnFrom(source: BrowserWindow, raw: unknown): boolean {
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

  private recordDrop(target: BrowserWindow, raw: unknown): void {
    const drop = parsePaneDrop(raw)
    if (!drop) return
    const targetId = windowIdOf(target)
    const owner = getByPaneId(drop.paneId)?.windowId
    if (!owner || owner === targetId || !this.windows.has(owner)) return
    if (this.windowOfWorkspace(drop.workspaceId) !== targetId) return
    if (getByPaneId(drop.placement.paneId)?.windowId !== targetId) return
    this.landings.record(
      drop.paneId,
      { windowId: targetId, workspaceId: drop.workspaceId, placement: drop.placement },
      Date.now(),
    )
    this.landingWaiters.get(drop.paneId)?.()
  }

  private async claimLanding(source: BrowserWindow, paneId: unknown): Promise<boolean> {
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

  private give(source: BrowserWindow, raw: unknown): boolean {
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
    this.persist()
    target.webContents.send('windows:adopt', [placed])
    this.deps.reveal(target)
    return true
  }

  private list(): WindowSummary[] {
    return this.windowIds().map((windowId) => ({
      windowId,
      detached: this.slots.get(windowId) !== MAIN_SLOT,
      workspaces: (this.reports.get(windowId) ?? []).map(summaryOf),
    }))
  }

  private broadcastList(): void {
    const list = this.list()
    this.deps.onList(list)
    for (const win of this.windows.values()) {
      if (win.isDestroyed()) continue
      win.webContents.send('windows:list', list)
      win.webContents.send('windows:origin-agents-changed')
    }
  }

  private focusWorkspace(workspaceId: string, jumpToUnread: boolean): void {
    const windowId = this.windowOfWorkspace(workspaceId)
    const win = windowId ? this.windows.get(windowId) : undefined
    if (!win || win.isDestroyed()) return
    this.deps.reveal(win)
    win.webContents.send('windows:activate-workspace', workspaceId, jumpToUnread)
  }

  private newWorkspaceInMain(raw: unknown): void {
    const main = this.mainWindow()
    if (!main || main.isDestroyed()) return
    const { dir, name, scratch, sandboxed } = (raw ?? {}) as Record<string, unknown>
    this.deps.reveal(main)
    const target = { windowId: windowIdOf(main), workspaceId: '', paneId: null }
    if (scratch === true) {
      void this.deps.execCommand(target, 'workspace.newScratch', { sandboxed: sandboxed === true })
      return
    }
    const request: NewWorkspaceRequest = {
      ...(typeof dir === 'string' && WORKSPACE_DIR.test(dir) ? { dir } : {}),
      ...(typeof name === 'string' ? { name: name.slice(0, TEXT_MAX) } : {}),
    }
    void this.deps.execCommand(target, 'workspace.new', request)
  }

  register(): void {
    const senderWindow = (e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) =>
      this.windows.get(String(e.sender.id))

    ipcMain.handle('windows:info', (e): WindowInfo => {
      const windowId = String(e.sender.id)
      return { windowId, detached: (this.slots.get(windowId) ?? MAIN_SLOT) !== MAIN_SLOT }
    })

    ipcMain.handle('workspace:load', (e): AppSnapshot | null => {
      const slot = this.slots.get(String(e.sender.id))
      if (!slot) return null
      const boot = this.boot.get(slot)
      if (boot) {
        this.boot.delete(slot)
        return boot
      }
      return this.book.load(slot)
    })

    ipcMain.on('workspace:save', (e, snapshot: AppSnapshot | null) => {
      const slot = this.slots.get(String(e.sender.id))
      if (!slot) return
      if (snapshot === null) {
        this.persistEnabled = false
        void clearPersisted()
        return
      }
      const parsed = parseSnapshot(snapshot)
      if (!parsed) return
      this.persistEnabled = true
      this.book.save(slot, parsed)
      this.persist()
    })

    ipcMain.handle('windows:detach', (e, raw: unknown, point: unknown) => {
      const source = senderWindow(e)
      return source ? this.detach(source, raw, point) : false
    })

    ipcMain.on('windows:drop-pane', (e, raw: unknown) => {
      const target = senderWindow(e)
      if (target) this.recordDrop(target, raw)
    })

    ipcMain.handle('windows:landing', (e, paneId: unknown) => {
      const source = senderWindow(e)
      return source ? this.claimLanding(source, paneId) : false
    })

    ipcMain.handle('windows:give', (e, raw: unknown) => {
      const source = senderWindow(e)
      return source ? this.give(source, raw) : false
    })

    ipcMain.handle('windows:open-with', (e, raw: unknown) => {
      const source = senderWindow(e)
      return source ? this.openWith(source, raw) : false
    })

    ipcMain.handle('windows:return', (e, raw: unknown) => {
      const source = senderWindow(e)
      return source ? this.returnFrom(source, raw) : false
    })

    ipcMain.on('windows:report', (e, raw: unknown) => {
      const windowId = String(e.sender.id)
      if (!this.windows.has(windowId)) return
      this.reports.set(windowId, parseReports(raw))
      this.broadcastList()
    })

    ipcMain.handle('windows:origin-agents', (e, workspaceId: unknown) =>
      originAgents(this.reports, this.originRules, String(e.sender.id), workspaceId),
    )

    ipcMain.handle('windows:insert-reference', (e, raw: unknown) =>
      this.forwardReference(String(e.sender.id), raw),
    )

    ipcMain.on('windows:reference-inserted', (e, requestId: unknown, inserted: unknown) => {
      this.references.answer(String(e.sender.id), requestId, inserted)
    })

    ipcMain.on('windows:focus-workspace', (_e, workspaceId: unknown, jumpToUnread: unknown) => {
      if (typeof workspaceId === 'string') this.focusWorkspace(workspaceId, jumpToUnread === true)
    })

    ipcMain.on('windows:return-workspace', (_e, workspaceId: unknown) => {
      if (typeof workspaceId !== 'string') return
      const windowId = this.windowOfWorkspace(workspaceId)
      const win = windowId ? this.windows.get(windowId) : undefined
      if (win && this.isDetached(win)) this.requestReturn(win)
    })

    ipcMain.on('windows:new-workspace', (e, raw: unknown) => {
      const source = senderWindow(e)
      if (source && this.isDetached(source)) this.newWorkspaceInMain(raw)
    })
  }
}
