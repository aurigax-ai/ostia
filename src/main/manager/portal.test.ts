import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PRODUCT_DISPLAY_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/productDisplay'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node'
import { managerAgents, parseManagerSettings } from '../../shared/agents/managerSettings'
import type { MissingRequirement } from '../../shared/app/systemRequirements'
import type { PortalPromptResult } from '../agent/portalPrompts'
import { ManagerService } from './manager'
import type { SessionSink } from './managerSession'
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
    adopt: () => true,
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
  const sessionSinks = new Map<string, SessionSink>()
  const prompted: string[] = []
  const promptResult: { value: PortalPromptResult } = { value: { ok: true } }
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
    attachSession: (paneId, sink) => {
      sessionSinks.set(paneId, sink)
      return {
        prompt: async (text) => {
          prompted.push(text)
          return promptResult.value
        },
        detach: () => sessionSinks.delete(paneId),
      }
    },
  })
  portals.push(portal)
  expect(await portal.start()).toBe(true)
  return { path, ptys, manager, portal, judged, sessionSinks, prompted, promptResult }
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
    expect(res).toEqual({ paneId: 'pane-1', agent: 'claude', created: true, session: false })
    await settle()
    expect(c.data.join('')).toBe('welcome\r\n')

    await c.conn.sendNotification('mirror.input', { data: 'hi\r' })
    await c.conn.sendNotification('mirror.resize', { cols: 90, rows: 20 })
    const pty = ptys.get('pane-1')
    await vi.waitFor(() => expect(pty?.sizes.at(-1)).toEqual([90, 20]), { timeout: 10_000 })
    expect(pty?.input).toEqual(['hi\r'])

    for (const sink of pty?.sinks ?? []) sink.data('out')
    await vi.waitFor(() => expect(c.data.at(-1)).toBe('out'), { timeout: 10_000 })
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
        adopt: () => true,
        spawn: () => false,
      }),
      attachMirror: () => null,
      attachSession: () => null,
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

  it('PIM-C1 opens the pi session without a mirror, forwards a prompt and the session events', async () => {
    const { path, sessionSinks, prompted } = await startPortal()
    const c = await client(path)
    const events: unknown[] = []
    const waits: boolean[] = []
    c.conn.onNotification('session.events', (p: { events: unknown[] }) => {
      events.push(...p.events)
    })
    c.conn.onNotification('session.waiting', (p: { waiting: boolean }) => {
      waits.push(p.waiting)
    })
    const opened = await open(c.conn, 'pi')
    expect(opened).toMatchObject({ agent: 'pi', created: true, session: true })
    expect(await c.conn.sendRequest('portal.prompt', { text: 'list workspaces' })).toEqual({
      ok: true,
    })
    expect(prompted).toEqual(['list workspaces'])
    const sink = sessionSinks.get(opened.paneId)
    sink?.events([{ type: 'turn.started', turn: 't1' }])
    sink?.waiting(true)
    await vi.waitFor(() => expect(events).toHaveLength(1))
    await vi.waitFor(() => expect(waits).toEqual([true]))
  })

  it('PIM-C2 refuses a prompt before the session is open, an empty one and one that is too long', async () => {
    const { path, prompted } = await startPortal()
    const c = await client(path)
    await expect(c.conn.sendRequest('portal.prompt', { text: 'early' })).rejects.toThrow(
      'not-attached',
    )
    await open(c.conn, 'pi')
    await expect(c.conn.sendRequest('portal.prompt', { text: '' })).rejects.toThrow('bad-request')
    await expect(
      c.conn.sendRequest('portal.prompt', { text: 'x'.repeat(9 * 1024) }),
    ).rejects.toThrow('bad-request')
    await expect(c.conn.sendRequest('portal.prompt', { text: 7 })).rejects.toThrow('bad-request')
    expect(prompted).toEqual([])
  })

  it('PIM-C3 turns a failed delivery into a named refusal instead of waiting', async () => {
    const { path, promptResult } = await startPortal()
    const c = await client(path)
    await open(c.conn, 'pi')
    promptResult.value = { ok: false, error: 'no-window' }
    await expect(c.conn.sendRequest('portal.prompt', { text: 'hi' })).rejects.toThrow('no-window')
  })

  it('PIM-C4 detach on disconnect keeps the manager session running', async () => {
    const { path, manager, sessionSinks } = await startPortal()
    const c = await client(path)
    const opened = await open(c.conn, 'pi')
    c.socket.destroy()
    await c.closed
    await vi.waitFor(() => expect(sessionSinks.has(opened.paneId)).toBe(false))
    expect(manager.live).toMatchObject({ agent: 'pi', session: true })
    const again = await client(path)
    expect(await open(again.conn, 'pi')).toMatchObject({ created: false, session: true })
  })

  it('PIM-C5 tells the client when the manager pane closes and closes the connection', async () => {
    const { path, manager, sessionSinks } = await startPortal()
    const c = await client(path)
    let ended = 0
    c.conn.onNotification('session.ended', () => {
      ended += 1
    })
    const opened = await open(c.conn, 'pi')
    manager.paneClosed(opened.paneId)
    sessionSinks.get(opened.paneId)?.ended()
    await c.closed
    expect(ended).toBe(1)
  })

  it('PIM-C6 offers no way to answer a card, a question or a capability', async () => {
    const { path } = await startPortal()
    const c = await client(path)
    await open(c.conn, 'pi')
    for (const method of [
      'approvals.answer',
      'agent:tool-result',
      'ask.answer',
      'portal.answer',
      'pane.input',
      'manager.input',
    ]) {
      await expect(c.conn.sendRequest(method, {})).rejects.toThrow()
    }
  })

  it('PIM-C7 still refuses a caller from inside Ostia before opening the pi session', async () => {
    const { path, manager } = await startPortal('inside')
    const c = await client(path)
    await expect(open(c.conn, 'pi')).rejects.toThrow('inside-ostia')
    expect(manager.live).toBeNull()
    await expect(c.conn.sendRequest('portal.prompt', { text: 'hi' })).rejects.toThrow(
      'not-attached',
    )
  })
})
