import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  SnapshotWorkspace,
  WindowBounds,
  WindowSummary,
  WindowWorkspaceReport,
} from '../../shared/types'

type Handler = (
  event: { sender: { id: number; getType: () => string } },
  ...args: unknown[]
) => unknown

const handlers = new Map<string, Handler>()
const fakes = new Map<number, FakeWindow>()

vi.mock('electron', () => ({
  app: { getPath: () => '/nonexistent' },
  ipcMain: {
    handle: (channel: string, fn: Handler) => handlers.set(channel, fn),
    on: (channel: string, fn: Handler) => handlers.set(channel, fn),
  },
  screen: {
    getPrimaryDisplay: () => ({ id: 1, workArea: { x: 0, y: 0, width: 3000, height: 2000 } }),
    getAllDisplays: () => [{ id: 1, workArea: { x: 0, y: 0, width: 3000, height: 2000 } }],
  },
  webContents: { fromId: (id: number) => fakes.get(id)?.webContents },
}))

const { AgentRunningPanes } = await import('../agents/agentRunning')
const { registerApprovals } = await import('../approvals/approvals')
const { ensureCaps } = await import('../approvals/controlElevation')
const { authenticate } = await import('../control/controlAuth')
const { getByPaneId, registerPane } = await import('../control/idRegistry')
const { WindowBroker } = await import('./windowBroker')

interface FakeWindow {
  webContents: {
    id: number
    sent: [string, ...unknown[]][]
    send: (channel: string, ...args: unknown[]) => void
    isCrashed: () => boolean
    isLoading: () => boolean
    isDestroyed: () => boolean
  }
  bounds: WindowBounds
  visible: boolean
  isDestroyed: () => boolean
  isVisible: () => boolean
  isMinimized: () => boolean
  getBounds: () => WindowBounds
  getNormalBounds: () => WindowBounds
  on: (event: string, listener: () => void) => void
  close: () => void
}

let nextId = 1
let dataDir: string | undefined

afterEach(() => {
  vi.unstubAllEnvs()
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
  dataDir = undefined
})

function fakeWindow(bounds: WindowBounds): FakeWindow {
  const id = nextId++
  const listeners = new Map<string, (() => void)[]>()
  let destroyed = false
  const emit = (event: string): void => {
    for (const listener of listeners.get(event) ?? []) listener()
  }
  const sent: [string, ...unknown[]][] = []
  const win: FakeWindow = {
    webContents: {
      id,
      sent,
      send: (channel, ...args) => sent.push([channel, ...args]),
      isCrashed: () => false,
      isLoading: () => false,
      isDestroyed: () => destroyed,
    },
    bounds,
    visible: true,
    isDestroyed: () => destroyed,
    isVisible: () => win.visible,
    isMinimized: () => false,
    getBounds: () => win.bounds,
    getNormalBounds: () => win.bounds,
    on: (event, listener) => listeners.set(event, [...(listeners.get(event) ?? []), listener]),
    close: () => {
      emit('close')
      destroyed = true
      emit('closed')
    },
  }
  fakes.set(id, win)
  return win
}

function start() {
  dataDir = mkdtempSync(join(tmpdir(), 'ostia-broker-'))
  vi.stubEnv('XDG_DATA_HOME', dataDir)
  const opened: FakeWindow[] = []
  const holdPtys = vi.fn()
  const reveal = vi.fn()
  const broker = new WindowBroker({
    createWindow: (slot, bounds) => {
      const win = fakeWindow(bounds ?? { x: 0, y: 0, width: 1280, height: 800 })
      opened.push(win)
      broker.track(win as unknown as Electron.BrowserWindow, slot)
      return win as unknown as Electron.BrowserWindow
    },
    holdPtys,
    execCommand: vi.fn(),
    agents: new AgentRunningPanes(() => {}),
    isSandboxed: () => false,
    isScratch: () => false,
    reveal,
    onList: () => {},
  })
  broker.register()
  broker.openAll()
  const send = (win: FakeWindow, channel: string, ...args: unknown[]): unknown =>
    handlers.get(channel)?.(
      { sender: { id: win.webContents.id, getType: () => 'window' } },
      ...args,
    )
  return { broker, main: opened[0], opened, holdPtys, reveal, send }
}

function workspace(id: string, paneId: string, extra?: Partial<SnapshotWorkspace>) {
  return {
    id,
    name: 'api',
    kind: 'terminal',
    workDir: '/home/u/api',
    activePaneId: paneId,
    root: { type: 'pane', id: paneId, title: 'zsh', kind: 'terminal' },
    ...extra,
  } as SnapshotWorkspace
}

function report(id: string, origin?: string): WindowWorkspaceReport {
  return {
    id,
    name: 'api',
    workDir: '/home/u/api',
    state: 'idle',
    unreadAt: 0,
    panes: [],
    ...(origin ? { origin } : {}),
  }
}

function lastList(win: FakeWindow): WindowSummary[] {
  const lists = win.webContents.sent.filter(([channel]) => channel === 'windows:list')
  return lists.at(-1)?.[1] as WindowSummary[]
}

function adopted(win: FakeWindow): unknown[] {
  return win.webContents.sent.filter(([channel]) => channel === 'windows:adopt').map(([, w]) => w)
}

function splitPane(tag: string) {
  const left = `pane-${tag}-left`
  const right = `pane-${tag}-right`
  const home = `w-${tag}`
  const moved = workspace(`w-${tag}-moved`, right, {
    origin: { workspaceId: home, index: 0, beside: { paneId: left, zone: 'right' } },
  })
  return { left, right, home, moved }
}

describe('WindowBroker', () => {
  it('an agent in a detached pane asks for approval in its own window', async () => {
    const { main, opened, send } = start()
    const identity = registerPane({
      windowId: String(main.webContents.id),
      workspaceId: 'w-ag',
      paneId: 'pane-ag',
    })
    send(main, 'windows:report', [report('w-ag')])
    registerApprovals(vi.fn(), vi.fn(), { opened: vi.fn(), settled: vi.fn() })

    expect(send(main, 'windows:detach', workspace('w-ag', 'pane-ag'))).toBe(true)
    const detached = opened[1]

    const conn = authenticate({ token: identity.token })
    if (!conn) throw new Error('pane token refused')
    let settled = false
    const asked = ensureCaps(conn, identity, ['settings-write'], 'settings.set', '').then(() => {
      settled = true
    })
    const cards = (win: FakeWindow) =>
      win.webContents.sent
        .filter(([channel]) => channel === 'approvals:changed')
        .flatMap(([, state]) => (state as { pending: { id: string; paneId: string }[] }).pending)
    expect(cards(detached).map((c) => c.paneId)).toEqual(['pane-ag'])
    expect(cards(main)).toEqual([])

    const id = cards(detached)[0].id
    expect(await send(main, 'approvals:answer', id, 'once')).toBe(false)
    expect(settled).toBe(false)
    expect(await send(detached, 'approvals:answer', id, 'once')).toBe(true)
    await asked
    expect(settled).toBe(true)
  })

  it('a pane moved to a new window rejoins its workspace when it comes back', () => {
    const { main, opened, holdPtys, reveal, send } = start()
    const { left, right, home, moved } = splitPane('rejoin')
    const mainId = String(main.webContents.id)
    registerPane({ windowId: mainId, workspaceId: home, paneId: left })
    registerPane({ windowId: mainId, workspaceId: home, paneId: right })
    send(main, 'windows:report', [report(home)])

    expect(send(main, 'windows:detach', moved)).toBe(true)
    const detached = opened[1]
    const detachedId = String(detached.webContents.id)
    send(detached, 'windows:report', [report(moved.id, home)])
    expect(lastList(main)).toEqual([
      expect.objectContaining({
        windowId: mainId,
        workspaces: [expect.objectContaining({ id: home })],
      }),
      expect.objectContaining({
        windowId: detachedId,
        detached: true,
        workspaces: [expect.objectContaining({ id: moved.id })],
      }),
    ])
    expect(getByPaneId(right)?.windowId).toBe(detachedId)

    expect(send(detached, 'windows:return', [moved])).toBe(true)

    expect(adopted(main)).toEqual([
      [
        expect.objectContaining({
          id: moved.id,
          origin: expect.objectContaining({
            workspaceId: home,
            beside: { paneId: left, zone: 'right' },
          }),
        }),
      ],
    ])
    expect(reveal).toHaveBeenCalledWith(main)
    expect(detached.isDestroyed()).toBe(true)
    expect(lastList(main).map((w) => w.windowId)).toEqual([mainId])
    expect(getByPaneId(right)?.windowId).toBe(mainId)
    expect(holdPtys.mock.calls).toEqual([[[right]], [[right]]])
  })

  it('dragging a tab out of the window opens it in a new window with its command still running', () => {
    const { main, opened, holdPtys, send } = start()
    const { left, right, home, moved } = splitPane('dragout')
    const mainId = String(main.webContents.id)
    registerPane({ windowId: mainId, workspaceId: home, paneId: left })
    registerPane({ windowId: mainId, workspaceId: home, paneId: right })
    send(main, 'windows:report', [report(home)])
    const drop = { x: 1600, y: 120 }

    expect(send(main, 'windows:detach', moved, drop)).toBe(true)

    const detached = opened[1]
    const { x, y, width, height } = detached.bounds
    expect(drop.x).toBeGreaterThanOrEqual(x)
    expect(drop.x).toBeLessThan(x + width)
    expect(drop.y).toBeGreaterThanOrEqual(y)
    expect(drop.y).toBeLessThan(y + height)
    expect(holdPtys).toHaveBeenCalledWith([right])
    expect(getByPaneId(right)?.windowId).toBe(String(detached.webContents.id))
    send(detached, 'windows:report', [report(moved.id, home)])
    expect(lastList(main).flatMap((w) => w.workspaces.map((ws) => ws.id))).toEqual([home, moved.id])
  })

  it('dropping a detached pane onto the main window moves it there and closes the empty window', async () => {
    const { main, opened, reveal, send } = start()
    const { left, right, home, moved } = splitPane('dropin')
    const mainId = String(main.webContents.id)
    registerPane({ windowId: mainId, workspaceId: home, paneId: left })
    registerPane({ windowId: mainId, workspaceId: home, paneId: right })
    send(main, 'windows:report', [report(home)])
    send(main, 'windows:detach', moved)
    const detached = opened[1]
    send(detached, 'windows:report', [report(moved.id, home)])
    const placement = { paneId: left, zone: 'right' }

    send(main, 'windows:drop-pane', { paneId: right, workspaceId: home, placement })
    expect(await send(detached, 'windows:landing', right)).toBe(true)
    const { origin: _origin, ...given } = moved
    expect(await send(detached, 'windows:give', given)).toBe(true)

    expect(adopted(main)).toEqual([
      [
        expect.objectContaining({
          id: moved.id,
          origin: expect.objectContaining({ workspaceId: home, beside: placement }),
        }),
      ],
    ])
    expect(reveal).toHaveBeenCalledWith(main)
    expect(getByPaneId(right)?.windowId).toBe(mainId)
  })

  it('closing a detached window while the main window is in the tray keeps it there', () => {
    const { broker, main, opened, reveal, send } = start()
    const { left, right, home, moved } = splitPane('tray')
    const mainId = String(main.webContents.id)
    registerPane({ windowId: mainId, workspaceId: home, paneId: left })
    registerPane({ windowId: mainId, workspaceId: home, paneId: right })
    send(main, 'windows:report', [report(home)])
    send(main, 'windows:detach', moved)
    const detached = opened[1]
    send(detached, 'windows:report', [report(moved.id, home)])
    main.visible = false

    broker.requestReturn(detached as unknown as Electron.BrowserWindow, true)
    expect(detached.webContents.sent.map(([channel]) => channel)).toContain(
      'windows:return-request',
    )
    expect(send(detached, 'windows:return', [moved])).toBe(true)

    expect(adopted(main)).toEqual([[expect.objectContaining({ id: moved.id })]])
    expect(reveal).not.toHaveBeenCalledWith(main)
    expect(main.isVisible()).toBe(false)
    expect(detached.isDestroyed()).toBe(true)
  })
})
