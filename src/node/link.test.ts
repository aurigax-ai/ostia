import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageConnection } from 'vscode-jsonrpc/node'

const dataHome = mkdtempSync(join(tmpdir(), 'ostia-node-link-'))
process.env.XDG_DATA_HOME = dataHome

const { enqueue, inboxOf, resetBus, setBusPath } = await import('../main/agents/busStore')
const { Jobs } = await import('./jobs')
const { RunnerLink, sendToDesktop } = await import('./link')

const VERSION = 'abcdef012345'

function fakeConn() {
  const handlers = new Map<string, (line: unknown) => void>()
  const closed: (() => void)[] = []
  const sent: unknown[] = []
  const conn = {
    onNotification: (method: string, handler: (line: unknown) => void) =>
      handlers.set(method, handler),
    onClose: (handler: () => void) => closed.push(handler),
    sendNotification: async (_method: string, line: string) => void sent.push(JSON.parse(line)),
    dispose: vi.fn(),
  }
  return {
    conn: conn as unknown as MessageConnection,
    dispose: conn.dispose,
    sent,
    receive: (frame: object) => handlers.get('link.in')?.(JSON.stringify(frame)),
  }
}

let jobs: InstanceType<typeof Jobs>
let runs = 0

beforeEach(async () => {
  vi.useFakeTimers()
  await resetBus()
  runs += 1
  setBusPath(join(dataHome, `bus-${runs}.json`))
  jobs = new Jobs(join(dataHome, `jobs-${runs}.json`))
  jobs.add({
    pane: 'aaaaaaaa',
    agent: 'shell',
    folder: '/',
    state: 'idle',
    startedAt: '',
    token: 't1',
  })
})

afterEach(() => vi.useRealTimers())
afterAll(() => rmSync(dataHome, { recursive: true, force: true }))

describe('RunnerLink', () => {
  it('REM-N1 sends a heartbeat every 15 s and drops a link that is silent for 45 s, telling its panes once', async () => {
    const link = new RunnerLink(jobs, VERSION)
    const peer = fakeConn()
    link.attach(peer.conn)
    peer.receive({ t: 'hello', version: VERSION })
    expect(peer.sent).toContainEqual({ t: 'hello-ok', version: VERSION })
    expect(link.isUp()).toBe(true)
    sendToDesktop('aaaaaaaa', 'desktop:local1', 'hi')
    await vi.advanceTimersByTimeAsync(15_000)
    expect(peer.sent.filter((frame) => (frame as { t: string }).t === 'hb').length).toBeGreaterThan(
      0,
    )
    peer.receive({ t: 'hb' })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(link.isUp()).toBe(true)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(link.isUp()).toBe(false)
    expect(peer.dispose).toHaveBeenCalled()
    const events = inboxOf('aaaaaaaa').filter((mail) => mail.kind === 'event')
    expect(events).toHaveLength(1)
    expect(events[0].text).toMatch(/desktop is offline since \d\d:\d\d; 1 message wait/)
  })

  it('REM-N2 refuses an incompatible version and mail for an unknown pane, and ignores frames before hello', async () => {
    const link = new RunnerLink(jobs, VERSION)
    const peer = fakeConn()
    link.attach(peer.conn)
    peer.receive({ t: 'mail', id: 'm0', from: 'local1', to: 'aaaaaaaa', text: 'early' })
    peer.receive({ t: 'hello', version: 'other' })
    expect(peer.sent).toEqual([{ t: 'incompatible', version: VERSION }])
    peer.receive({ t: 'hello', version: VERSION })
    peer.receive({ t: 'mail', id: 'm1', from: 'local1', to: 'ffffffff', text: 'nobody' })
    await vi.advanceTimersByTimeAsync(10)
    expect(peer.sent).toContainEqual({ t: 'refused', id: 'm1', reason: 'unknown-pane' })
    expect(inboxOf('aaaaaaaa')).toHaveLength(0)
  })

  it('REM-N3 never lets mail not written by a live pane cross the link', async () => {
    const link = new RunnerLink(jobs, VERSION)
    const peer = fakeConn()
    link.attach(peer.conn)
    enqueue({ from: 'selftest-a', to: 'desktop:local1', text: 'admin', route: 'desktop' })
    peer.receive({ t: 'hello', version: VERSION })
    await vi.advanceTimersByTimeAsync(10)
    expect(peer.sent.some((frame) => (frame as { t: string }).t === 'mail')).toBe(false)
  })

  it('RPF-C5 sends a ports frame only when the listening ports change, and only while the link is up', async () => {
    let ports = [{ port: 3000, name: 'node' }]
    const scan = vi.fn(async () => ports)
    const link = new RunnerLink(jobs, VERSION, Date.now, scan)
    const peer = fakeConn()
    link.attach(peer.conn)
    await vi.advanceTimersByTimeAsync(5000)
    expect(scan).not.toHaveBeenCalled()
    peer.receive({ t: 'hello', version: VERSION })
    await vi.advanceTimersByTimeAsync(10)
    await vi.advanceTimersByTimeAsync(6000)
    peer.receive({ t: 'hb' })
    const frames = () => peer.sent.filter((f) => (f as { t: string }).t === 'ports')
    expect(frames()).toEqual([{ t: 'ports', ports }])
    ports = []
    await vi.advanceTimersByTimeAsync(2100)
    expect(frames()).toHaveLength(2)
    expect(frames()[1]).toEqual({ t: 'ports', ports: [] })
  })
})
