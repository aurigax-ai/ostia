import { randomUUID } from 'node:crypto'
import { type BrowserWindow, ipcMain, screen } from 'electron'
import type {
  AppSnapshot,
  CommandResult,
  CommandTarget,
  NewWorkspaceRequest,
  SnapshotWorkspace,
  WindowBounds,
  WindowInfo,
  WindowPaneSummary,
  WindowSummary,
  WindowWorkspaceSummary,
  WorkspaceLiveState,
} from '../shared/types'
import { approvals } from './approvals'
import { getByPaneId, panesOwnedBy, rehomePanes } from './idRegistry'
import {
  MAIN_SLOT,
  WindowBook,
  boundsAt,
  clampBounds,
  crossesSandbox,
  parsePoint,
  planReturn,
  withoutOrigin,
} from './windowBook'
import {
  clearPersisted,
  handoffPaneIds,
  loadSnapshot,
  parseHandoff,
  parseSnapshot,
  saveSnapshot,
} from './workspaceSnapshot'

export interface WindowBrokerDeps {
  createWindow: (slot: string, bounds?: WindowBounds) => BrowserWindow
  holdPtys: (paneIds: readonly string[]) => void
  execCommand: (target: CommandTarget, id: string, args?: unknown) => Promise<CommandResult>
  isSandboxed: (workspaceId: string) => boolean
  reveal: (win: BrowserWindow) => void
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

function parsePanes(raw: unknown): WindowPaneSummary[] {
  if (!Array.isArray(raw)) return []
  const panes: WindowPaneSummary[] = []
  for (const entry of raw.slice(0, PANES_MAX)) {
    if (typeof entry !== 'object' || entry === null) continue
    const { id, title } = entry as Record<string, unknown>
    if (typeof id === 'string' && id && typeof title === 'string') {
      panes.push({ id: id.slice(0, TEXT_MAX), title: title.slice(0, TEXT_MAX) })
    }
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

function parseSummaries(raw: unknown): WindowWorkspaceSummary[] {
  if (!Array.isArray(raw)) return []
  const out: WindowWorkspaceSummary[] = []
  for (const entry of raw.slice(0, SUMMARY_MAX)) {
    if (typeof entry !== 'object' || entry === null) continue
    const { id, name, workDir, state, unreadAt, panes } = entry as Record<string, unknown>
    if (typeof id !== 'string' || !id || typeof name !== 'string') continue
    out.push({
      id: id.slice(0, TEXT_MAX),
      name: name.slice(0, TEXT_MAX),
      workDir: typeof workDir === 'string' ? workDir.slice(0, TEXT_MAX) : '',
      state:
        typeof state === 'string' && STATES.has(state) ? (state as WorkspaceLiveState) : 'idle',
      unreadAt: typeof unreadAt === 'number' && Number.isFinite(unreadAt) ? unreadAt : 0,
      panes: parsePanes(panes),
    })
  }
  return out
}

export class WindowBroker {
  private readonly book = new WindowBook(loadSnapshot())
  private readonly slots = new Map<string, string>()
  private readonly windows = new Map<string, BrowserWindow>()
  private readonly boot = new Map<string, AppSnapshot>()
  private readonly reports = new Map<string, WindowWorkspaceSummary[]>()
  private readonly returning = new WeakSet<BrowserWindow>()
  private readonly closing = new WeakSet<BrowserWindow>()
  private persistEnabled = true
  private boundsTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly deps: WindowBrokerDeps) {}

  get persisting(): boolean {
    return this.persistEnabled
  }

  openAll(): void {
    this.deps.createWindow(MAIN_SLOT)
    for (const slot of this.book.slots()) {
      this.deps.createWindow(slot.id, clampBounds(slot.bounds, workAreas()))
    }
  }

  track(win: BrowserWindow, slot: string): void {
    const windowId = windowIdOf(win)
    this.slots.set(windowId, slot)
    this.windows.set(windowId, win)
    if (slot !== MAIN_SLOT) {
      const capture = (): boolean => {
        if (win.isDestroyed() || win.isMinimized()) return false
        this.book.setBounds(slot, win.getNormalBounds())
        return true
      }
      const remember = (): void => {
        if (!capture()) return
        if (this.boundsTimer) clearTimeout(this.boundsTimer)
        this.boundsTimer = setTimeout(() => this.persist(), BOUNDS_SAVE_MS)
      }
      win.on('move', remember)
      win.on('resize', remember)
      win.on('close', () => {
        if (capture()) this.persist()
      })
    }
    win.on('closed', () => {
      this.slots.delete(windowId)
      this.windows.delete(windowId)
      this.reports.delete(windowId)
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

  windowOfWorkspace(workspaceId: string): string | undefined {
    for (const [windowId, workspaces] of this.reports) {
      if (workspaces.some((w) => w.id === workspaceId)) return windowId
    }
    return undefined
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

  private persist(): void {
    if (!this.persistEnabled) return
    try {
      const merged = parseSnapshot(this.book.merged(new Date().toISOString()))
      if (merged) saveSnapshot(merged)
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
    approvals()?.rehome(
      moved.map((identity) => identity.externalId),
      windowId,
    )
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

  private list(): WindowSummary[] {
    return this.windowIds().map((windowId) => ({
      windowId,
      detached: this.slots.get(windowId) !== MAIN_SLOT,
      workspaces: this.reports.get(windowId) ?? [],
    }))
  }

  private broadcastList(): void {
    const list = this.list()
    for (const win of this.windows.values()) {
      if (!win.isDestroyed()) win.webContents.send('windows:list', list)
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
    const { dir, name } = (raw ?? {}) as Record<string, unknown>
    const request: NewWorkspaceRequest = {
      ...(typeof dir === 'string' && WORKSPACE_DIR.test(dir) ? { dir } : {}),
      ...(typeof name === 'string' ? { name: name.slice(0, TEXT_MAX) } : {}),
    }
    this.deps.reveal(main)
    void this.deps.execCommand(
      { windowId: windowIdOf(main), workspaceId: '', paneId: null },
      'workspace.new',
      request,
    )
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
        clearPersisted()
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

    ipcMain.handle('windows:return', (e, raw: unknown) => {
      const source = senderWindow(e)
      return source ? this.returnFrom(source, raw) : false
    })

    ipcMain.on('windows:report', (e, raw: unknown) => {
      const windowId = String(e.sender.id)
      if (!this.windows.has(windowId)) return
      this.reports.set(windowId, parseSummaries(raw))
      this.broadcastList()
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
