import { type BrowserWindow, ipcMain } from 'electron'
import { debounce } from 'es-toolkit'
import type { WorkspaceLiveState } from '../../shared/attention/attention'
import type { CommandResult, CommandTarget } from '../../shared/control/commands'
import type {
  NewWorkspaceRequest,
  WindowInfo,
  WindowPaneReport,
  WindowSummary,
  WindowWorkspaceReport,
} from '../../shared/windows/windowsApi'
import type { AppSnapshot, WindowBounds } from '../../shared/workspaces/workspaceApi'
import type { AgentRunningPanes } from '../agents/agentRunning'
import {
  type OriginRules,
  originAgentOwner,
  originAgents,
  parseAttentionState,
  parsePaneAgent,
  parseReferenceRequest,
  ReferenceRelay,
  reachesTarget,
  summaryOf,
} from '../agents/originAgents'
import { getByPaneId } from '../control/idRegistry'
import { clearPersisted } from '../workspaces/savedScrollback'
import { loadSnapshot, parseSnapshot, saveSnapshot } from '../workspaces/workspaceSnapshot'
import { clampBounds, MAIN_SLOT, WindowBook } from './windowBook'
import { WindowHandoffs, windowIdOf, workAreas } from './windowHandoffs'

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

function parseReports(raw: unknown): WindowWorkspaceReport[] {
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
  private readonly handoffs: WindowHandoffs
  private persistEnabled = true
  private readonly debouncedPersist = debounce(() => this.persist(), BOUNDS_SAVE_MS)

  constructor(private readonly deps: WindowBrokerDeps) {
    this.originRules = {
      isSandboxed: deps.isSandboxed,
      isScratch: deps.isScratch,
      isManagerPane: (paneId) => getByPaneId(paneId)?.manager === true,
      ownerOfPane: (paneId) => getByPaneId(paneId)?.windowId,
    }
    this.handoffs = new WindowHandoffs(
      {
        book: this.book,
        slots: this.slots,
        windows: this.windows,
        boot: this.boot,
        reports: this.reports,
        returning: this.returning,
        closing: this.closing,
      },
      {
        createWindow: deps.createWindow,
        holdPtys: deps.holdPtys,
        isSandboxed: deps.isSandboxed,
        reveal: deps.reveal,
        persist: () => this.persist(),
        mainWindow: () => this.mainWindow(),
        windowOfWorkspace: (workspaceId) => this.windowOfWorkspace(workspaceId),
      },
    )
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
      this.handoffs.returnWorkspaces(win, slot, this.book.load(slot)?.workspaces ?? [], closing)
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

  private focusWorkspace(workspaceId: string, jumpToUnread: boolean, takesKeyboard: boolean): void {
    const windowId = this.windowOfWorkspace(workspaceId)
    const win = windowId ? this.windows.get(windowId) : undefined
    if (!win || win.isDestroyed()) return
    this.deps.reveal(win)
    win.webContents.send('windows:activate-workspace', workspaceId, jumpToUnread, takesKeyboard)
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
      return source ? this.handoffs.detach(source, raw, point) : false
    })

    ipcMain.on('windows:drop-pane', (e, raw: unknown) => {
      const target = senderWindow(e)
      if (target) this.handoffs.recordDrop(target, raw)
    })

    ipcMain.handle('windows:landing', (e, paneId: unknown) => {
      const source = senderWindow(e)
      return source ? this.handoffs.claimLanding(source, paneId) : false
    })

    ipcMain.handle('windows:give', (e, raw: unknown) => {
      const source = senderWindow(e)
      return source ? this.handoffs.give(source, raw) : false
    })

    ipcMain.handle('windows:open-with', (e, raw: unknown) => {
      const source = senderWindow(e)
      return source ? this.handoffs.openWith(source, raw) : false
    })

    ipcMain.handle('windows:return', (e, raw: unknown) => {
      const source = senderWindow(e)
      return source ? this.handoffs.returnFrom(source, raw) : false
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

    ipcMain.on(
      'windows:focus-workspace',
      (_e, workspaceId: unknown, jumpToUnread: unknown, takesKeyboard: unknown) => {
        if (typeof workspaceId !== 'string') return
        this.focusWorkspace(workspaceId, jumpToUnread === true, takesKeyboard === true)
      },
    )

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
