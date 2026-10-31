import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { planConnect } from '../plan'
import { type ForwardMode, HostForwards } from './forwards'
import { PortMap } from './portMap'

const plan = planConnect(['dev@box'])
if (!plan) throw new Error('plan')

interface FakeChild extends EventEmitter {
  argv: string[]
  kill: ReturnType<typeof vi.fn>
  stdin: EventEmitter
  stdout: EventEmitter
  stderr: EventEmitter
}

let dir: string
let taken: Set<number>
let mode: ForwardMode
let children: FakeChild[]

function make(file = 'map.json') {
  const map = new PortMap(join(dir, file))
  const forwards = new HostForwards({
    host: 'dev@box',
    plan,
    map,
    mode: () => mode,
    isFree: async (port) => !taken.has(port),
    changed: () => {},
    spawn: (argv) => {
      const child = Object.assign(new EventEmitter(), {
        argv,
        kill: vi.fn(),
        stdin: new EventEmitter(),
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      }) as FakeChild
      children.push(child)
      return child as never
    },
  })
  return { forwards, map }
}

const locals = (f: HostForwards) => f.rows().map((r) => [r.remote, r.local])

beforeEach(() => {
  vi.useFakeTimers()
  dir = mkdtempSync(join(tmpdir(), 'ostia-fwd-'))
  taken = new Set()
  mode = 'auto'
  children = []
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

describe('HostForwards', () => {
  it('RPF-C1 RPF-C8 forwards a port opened after connect, bound to 127.0.0.1 only', async () => {
    const { forwards } = make()
    await forwards.onLink(true)
    await forwards.onPorts([])
    await forwards.onPorts([{ port: 3000, name: 'node' }])
    expect(forwards.rows()).toEqual([{ remote: 3000, name: 'node', local: 3000 }])
    const argv = children[0].argv
    expect(argv).toContain('127.0.0.1:3000:127.0.0.1:3000')
    expect(argv).toContain('-N')
    expect(argv.join(' ')).not.toMatch(/GatewayPorts|0\.0\.0\.0|\*:/)
  })

  it('RPF-C2 lists a port that was listening at connect as not forwarded', async () => {
    const { forwards } = make()
    await forwards.onLink(true)
    await forwards.onPorts([{ port: 3000 }])
    expect(forwards.rows()).toEqual([{ remote: 3000 }])
    expect(children).toHaveLength(0)
  })

  it('RPF-C3 maps to the next free local port when the same number is in use', async () => {
    taken.add(3000)
    const { forwards } = make()
    await forwards.onLink(true)
    await forwards.onPorts([])
    await forwards.onPorts([{ port: 3000 }])
    expect(locals(forwards)).toEqual([[3000, 3001]])
  })

  it('RPF-C4 maps a remote port below 1024 to the first free port from 1024', async () => {
    taken.add(1024)
    const { forwards } = make()
    await forwards.onLink(true)
    await forwards.onPorts([])
    await forwards.onPorts([{ port: 80 }])
    expect(locals(forwards)).toEqual([[80, 1025]])
  })

  it('RPF-C5 drops the row and the forward when the host stops listening, and keeps the saved map', async () => {
    const { forwards, map } = make()
    await forwards.onLink(true)
    await forwards.onPorts([])
    await forwards.onPorts([{ port: 3000 }])
    await forwards.onPorts([])
    expect(forwards.rows()).toEqual([])
    expect(children[0].kill).toHaveBeenCalled()
    expect(map.get('dev@box').get(3000)).toBe(3000)
  })

  it('RPF-C7 brings each forward back on the same local port after the link returns', async () => {
    taken.add(3000)
    const { forwards } = make()
    await forwards.onLink(true)
    await forwards.onPorts([])
    await forwards.onPorts([{ port: 3000 }])
    await forwards.onLink(false)
    taken.delete(3000)
    await forwards.onLink(true)
    await forwards.onPorts([{ port: 3000 }])
    expect(locals(forwards)).toEqual([[3000, 3001]])
  })

  it('RPF-C27 restores saved forwards in a new process on the same local ports', async () => {
    const first = make()
    await first.forwards.onLink(true)
    await first.forwards.onPorts([])
    await first.forwards.onPorts([{ port: 8080 }])
    const local = first.forwards.rows()[0].local
    const second = make()
    await second.forwards.onLink(true)
    await second.forwards.onPorts([{ port: 8080 }])
    expect(second.forwards.rows()[0].local).toBe(local)
  })

  it('RPF-C12 shows an error and opens no other port when a saved port is taken', async () => {
    const first = make()
    await first.forwards.onLink(true)
    await first.forwards.onPorts([])
    await first.forwards.onPorts([{ port: 3000 }])
    taken.add(3000)
    const second = make()
    await second.forwards.onLink(true)
    await second.forwards.onPorts([{ port: 3000 }])
    expect(second.forwards.rows()).toEqual([{ remote: 3000, error: 'port-taken' }])
    expect(children).toHaveLength(1)
  })

  it('RPF-C9 moves a forward to a new local port and closes the old one', async () => {
    const { forwards } = make()
    await forwards.onLink(true)
    await forwards.onPorts([])
    await forwards.onPorts([{ port: 3000 }])
    const answer = await forwards.forward(3000, 3100)
    expect(answer).toEqual({ ok: true, forwards: [{ remote: 3000, local: 3100 }] })
    expect(children[0].kill).toHaveBeenCalled()
    expect(children[1].argv).toContain('127.0.0.1:3100:127.0.0.1:3000')
  })

  it('RPF-C11 RPF-C21 refuses a bad or taken local port and keeps the forward running', async () => {
    const { forwards } = make()
    await forwards.onLink(true)
    await forwards.onPorts([])
    await forwards.onPorts([{ port: 3000 }])
    for (const bad of [0, 80, 70000, Number.NaN]) {
      expect(await forwards.forward(3000, bad)).toEqual({ ok: false, error: 'bad-port' })
    }
    taken.add(3200)
    expect(await forwards.forward(3000, 3200)).toEqual({ ok: false, error: 'port-taken' })
    expect(locals(forwards)).toEqual([[3000, 3000]])
    expect(children[0].kill).not.toHaveBeenCalled()
  })

  it('RPF-C13 picks the port by the auto rule when the local port is emptied', async () => {
    const { forwards } = make()
    await forwards.onLink(true)
    await forwards.onPorts([])
    await forwards.onPorts([{ port: 3000 }])
    await forwards.forward(3000, 3100)
    await forwards.forward(3000, undefined)
    expect(locals(forwards)).toEqual([[3000, 3000]])
  })

  it('RPF-C14 forwards a listed port when asked', async () => {
    const { forwards } = make()
    await forwards.onLink(true)
    await forwards.onPorts([{ port: 5173 }])
    expect(await forwards.forward(5173, undefined)).toEqual({
      ok: true,
      forwards: [{ remote: 5173, local: 5173 }],
    })
  })

  it('RPF-C15 keeps a forward the human stopped stopped while the port still listens', async () => {
    const { forwards } = make()
    await forwards.onLink(true)
    await forwards.onPorts([])
    await forwards.onPorts([{ port: 3000 }])
    await forwards.stop(3000)
    await forwards.onPorts([{ port: 3000 }])
    expect(forwards.rows()).toEqual([{ remote: 3000 }])
    await forwards.forward(3000, undefined)
    expect(locals(forwards)).toEqual([[3000, 3000]])
  })

  it('RPF-C16 lists a new port without starting ssh in Manual', async () => {
    mode = 'manual'
    const { forwards } = make()
    await forwards.onLink(true)
    await forwards.onPorts([])
    await forwards.onPorts([{ port: 3000 }])
    expect(forwards.rows()).toEqual([{ remote: 3000 }])
    expect(children).toHaveLength(0)
  })

  it('RPF-C17 keeps running forwards when the setting changes to Manual', async () => {
    const { forwards } = make()
    await forwards.onLink(true)
    await forwards.onPorts([])
    await forwards.onPorts([{ port: 3000 }])
    mode = 'manual'
    await forwards.onPorts([{ port: 3000 }, { port: 4000 }])
    expect(locals(forwards)).toEqual([
      [3000, 3000],
      [4000, undefined],
    ])
    expect(children[0].kill).not.toHaveBeenCalled()
  })

  it('RPF-C19 forwards an asked port in Manual and answers the observed state', async () => {
    mode = 'manual'
    const { forwards } = make()
    await forwards.onLink(true)
    await forwards.onPorts([{ port: 3000 }])
    expect(await forwards.forward(3000, 3100)).toEqual({
      ok: true,
      forwards: [{ remote: 3000, local: 3100 }],
    })
  })

  it('RPF-C22 answers link-down and starts nothing when the link is down', async () => {
    const { forwards } = make()
    expect(await forwards.forward(3000, 3100)).toEqual({ ok: false, error: 'link-down' })
    expect(forwards.list()).toEqual({ ok: false, error: 'link-down' })
    expect(children).toHaveLength(0)
  })

  it('RPF-C24 answers too-many at 32 forwards and lists the next port as not forwarded in Auto', async () => {
    const { forwards } = make()
    await forwards.onLink(true)
    await forwards.onPorts([])
    const ports = Array.from({ length: 33 }, (_, i) => ({ port: 4000 + i }))
    await forwards.onPorts(ports)
    expect(forwards.rows().filter((r) => r.local !== undefined)).toHaveLength(32)
    expect(forwards.rows()[32]).toEqual({ remote: 4032 })
    expect(await forwards.forward(4032, undefined)).toEqual({ ok: false, error: 'too-many' })
  })

  it('RPF-C25 keeps one forward when two callers forward one port at once', async () => {
    mode = 'manual'
    const { forwards } = make()
    await forwards.onLink(true)
    await forwards.onPorts([{ port: 3000 }])
    const [a, b] = await Promise.all([forwards.forward(3000, 3100), forwards.forward(3000, 3100)])
    expect(a).toEqual(b)
    expect(children).toHaveLength(1)
  })

  it('RPF-C26 stops every forward on close and keeps the saved map', async () => {
    const { forwards, map } = make()
    await forwards.onLink(true)
    await forwards.onPorts([])
    await forwards.onPorts([{ port: 3000 }])
    forwards.closeAll()
    expect(children[0].kill).toHaveBeenCalled()
    expect(map.get('dev@box').get(3000)).toBe(3000)
  })

  it('RPF-D4 saves the map in a file only the user can read', async () => {
    const { forwards } = make()
    await forwards.onLink(true)
    await forwards.onPorts([])
    await forwards.onPorts([{ port: 3000 }])
    expect(statSync(join(dir, 'map.json')).mode & 0o777).toBe(0o600)
  })

  it('RPF-C7 restarts a forward whose ssh ended while the link is up', async () => {
    const { forwards } = make()
    await forwards.onLink(true)
    await forwards.onPorts([])
    await forwards.onPorts([{ port: 3000 }])
    children[0].emit('close')
    await vi.advanceTimersByTimeAsync(1100)
    expect(children).toHaveLength(2)
  })
})
