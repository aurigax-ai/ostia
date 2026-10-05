import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
} from 'vscode-jsonrpc/node'
import { managerAgents, parseManagerSettings } from '../shared/managerSettings'
import { PRODUCT_DISPLAY_NAME } from '../shared/productDisplay'
import type { MissingRequirement } from '../shared/systemRequirements'
import { ManagerService } from './manager'
import { type MirrorSink, Portal, portalSupported } from './portal'
import type { CallerVerdict } from './portalCaller'

interface FakePty {
  paneId: string
  argv: string[]
  input: string[]
  sizes: [number, number][]
  sinks: Set<MirrorSink>
  buffer: string
  onExit: () => void
}

let dir = ''
const portals: Portal[] = []
const clients: MessageConnection[] = []

afterEach(() => {
  for (const c of clients.splice(0)) c.dispose()
  for (const p of portals.splice(0)) p.stop()
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

async function startPortal(verdict: CallerVerdict = 'outside', missing: MissingRequirement[] = []) {
  dir = mkdtempSync(join(tmpdir(), 'ostia-portal-'))
  const path = join(dir, 'portal.sock')
  const ptys = new Map<string, FakePty>()
  let next = 0
  const manager = new ManagerService({
    loadResume: () => null,
    saveResume: () => {},
    agents: () => managerAgents(parseManagerSettings(undefined)),
    createPane: async () => `pane-${++next}`,
    spawn: (req) => {
      ptys.set(req.paneId, {
        paneId: req.paneId,
        argv: req.argv,
        input: [],
        sizes: [[req.cols, req.rows]],
        sinks: new Set(),
        buffer: 'welcome\r\n',
        onExit: req.onExit,
      })
      return true
    },
  })
  const judged: number[] = []
  const portal = new Portal(path, {
    missing: () => missing,
    hint: (m) => ({
      command: `sudo pacman -S --needed ${m.map((r) => r.package).join(' ')}`,
      packages: m.map((r) => r.package),
    }),
    judge: async () => {
      judged.push(1)
      return verdict
    },
    manager,
    attachMirror: (paneId, sink) => {
      const pty = ptys.get(paneId)
      if (!pty) return null
      pty.sinks.add(sink)
      sink.data(pty.buffer)
      return {
        write: (data) => pty.input.push(data),
        resize: (cols, rows) => pty.sizes.push([cols, rows]),
        detach: () => pty.sinks.delete(sink),
      }
    },
  })
  portals.push(portal)
  expect(await portal.start()).toBe(true)
  return { path, ptys, manager, portal, judged }
}

async function client(path: string) {
  const socket = createConnection(path)
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  const conn = createMessageConnection(
    new StreamMessageReader(socket),
    new StreamMessageWriter(socket),
  )
  const data: string[] = []
  const exits: number[] = []
  conn.onNotification('mirror.data', (p: { data: string }) => {
    data.push(p.data)
  })
  conn.onNotification('mirror.exit', (p: { code: number }) => {
    exits.push(p.code)
  })
  conn.listen()
  clients.push(conn)
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
  return { conn, data, exits, socket, closed }
}

const open = (conn: MessageConnection, agent = 'claude', args: string[] = []) =>
  conn.sendRequest<{ paneId: string; agent: string; created: boolean }>('portal.open', {
    agent,
    args,
    cwd: '/home/u',
    cols: 100,
    rows: 30,
  })

const settle = () => new Promise((r) => setTimeout(r, 30))

describe('Portal', () => {
  it('creates the socket readable only by the user', async () => {
    const { path } = await startPortal()
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('MGR-C21 opens the manager, replays its screen, forwards input and resize', async () => {
    const { path, ptys } = await startPortal()
    const c = await client(path)
    const res = await open(c.conn)
    expect(res).toEqual({ paneId: 'pane-1', agent: 'claude', created: true })
    await settle()
    expect(c.data.join('')).toBe('welcome\r\n')

    await c.conn.sendNotification('mirror.input', { data: 'hi\r' })
    await c.conn.sendNotification('mirror.resize', { cols: 90, rows: 20 })
    await settle()
    const pty = ptys.get('pane-1')
    expect(pty?.input).toEqual(['hi\r'])
    expect(pty?.sizes.at(-1)).toEqual([90, 20])

    for (const sink of pty?.sinks ?? []) sink.data('out')
    await settle()
    expect(c.data.at(-1)).toBe('out')
  })

  it('MGR-C39 refuses before checking the caller when ss is missing, naming the package and command', async () => {
    const { path, ptys, judged } = await startPortal('outside', [
      { program: 'ss', package: 'iproute2' },
    ])
    const c = await client(path)
    await expect(open(c.conn)).rejects.toThrow(
      `missing-requirements: ${PRODUCT_DISPLAY_NAME} needs ss (package iproute2) to check who is asking. Install it: sudo pacman -S --needed iproute2`,
    )
    expect(judged).toEqual([])
    expect(ptys.size).toBe(0)
  })

  it('MGR-C11 refuses a caller from inside Ostia before opening anything', async () => {
    const { path, ptys } = await startPortal('inside')
    const c = await client(path)
    await expect(open(c.conn)).rejects.toThrow(/inside-ostia/)
    expect(ptys.size).toBe(0)
  })

  it('MGR-C14 refuses a caller it could not check', async () => {
    const { path, ptys } = await startPortal('unknown')
    const c = await client(path)
    await expect(open(c.conn)).rejects.toThrow(/unknown-caller/)
    expect(ptys.size).toBe(0)
  })

  it('MGR-C15 refuses a second mirror while one is attached, and allows it after detach', async () => {
    const { path } = await startPortal()
    const first = await client(path)
    await open(first.conn)
    const second = await client(path)
    await expect(open(second.conn)).rejects.toThrow(/mirror-attached/)

    first.socket.destroy()
    await first.closed
    await settle()
    const third = await client(path)
    await expect(open(third.conn)).resolves.toMatchObject({ created: false })
  })

  it('MGR-C24 keeps the manager running when the mirror disconnects abruptly', async () => {
    const { path, ptys, manager } = await startPortal()
    const c = await client(path)
    await open(c.conn)
    c.socket.destroy()
    await c.closed
    await settle()
    expect(manager.live?.paneId).toBe('pane-1')
    expect(ptys.get('pane-1')?.sinks.size).toBe(0)
  })

  it('MGR-C10 reports a different running agent', async () => {
    const { path } = await startPortal()
    const first = await client(path)
    await open(first.conn)
    first.socket.destroy()
    await first.closed
    await settle()
    const c = await client(path)
    await expect(open(c.conn, 'codex')).rejects.toThrow(
      /manager-busy: the manager is running claude/,
    )
  })

  it('MGR-C23 tells the mirror the exit code and closes it when the agent exits', async () => {
    const { path, ptys } = await startPortal()
    const c = await client(path)
    await open(c.conn)
    for (const sink of ptys.get('pane-1')?.sinks ?? []) sink.exit(3)
    await c.closed
    expect(c.exits).toEqual([3])
  })

  it('does not take over a portal socket another live instance owns', async () => {
    const { path } = await startPortal()
    const other = new Portal(path, {
      missing: () => [],
      hint: () => ({ command: null, packages: [] }),
      judge: async () => 'outside',
      manager: new ManagerService({
        loadResume: () => null,
        saveResume: () => {},
        agents: () => ({}),
        createPane: async () => null,
        spawn: () => false,
      }),
      attachMirror: () => null,
    })
    expect(await other.start()).toBe(false)
    const c = await client(path)
    await expect(open(c.conn)).resolves.toMatchObject({ agent: 'claude' })
  })

  it('MGR-C18 runs only on Linux', () => {
    expect(portalSupported('linux')).toBe(true)
    expect(portalSupported('darwin')).toBe(false)
    expect(portalSupported('win32')).toBe(false)
  })
})
