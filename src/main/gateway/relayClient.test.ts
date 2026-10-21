import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type AccountHarness,
  accountHarness,
  signedIn,
} from '../../../test/fixtures/server/accountHarness'
import type { PhoneStream } from '../../../test/fixtures/server/fakeServer'
import type { GatewayRelayState } from '../../shared/gateway/gatewayApi'
import { RelayClient } from './relayClient'

interface Helper {
  port: number
  sockets: Socket[]
  received: (index: number) => Buffer
  close: () => Promise<void>
}

async function startHelper(): Promise<Helper> {
  const sockets: Socket[] = []
  const chunks: Buffer[][] = []
  const server: Server = createServer((socket) => {
    sockets.push(socket)
    const mine: Buffer[] = []
    chunks.push(mine)
    socket.on('data', (data) => mine.push(data))
    socket.on('error', () => {})
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    port,
    sockets,
    received: (index) => Buffer.concat(chunks[index] ?? []),
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

interface Running {
  harness: AccountHarness
  helper: Helper
  client: RelayClient
  states: GatewayRelayState[]
  hosts: Array<string | null>
}

let running: Running | null = null
let extraHarness: AccountHarness | null = null

async function boot(
  options: { harness?: AccountHarness; random?: () => number; start?: boolean } = {},
): Promise<Running> {
  const harness = options.harness ?? (await signedIn())
  const helper = await startHelper()
  const states: GatewayRelayState[] = []
  const hosts: Array<string | null> = []
  const client = new RelayClient({
    account: harness.account,
    helperPort: () => helper.port,
    onState: (state) => states.push(state),
    onHost: (host) => hosts.push(host),
    random: options.random,
  })
  running = { harness, helper, client, states, hosts }
  if (options.start !== false) client.start()
  return running
}

const realTimeout = globalThis.setTimeout

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((resolve) => realTimeout(resolve, 5))
  }
}

async function listening(r: Running): Promise<void> {
  await vi.waitFor(() => expect(r.client.status().state).toBe('listening'))
}

afterEach(async () => {
  vi.useRealTimers()
  running?.client.stop()
  await running?.helper.close()
  await running?.harness.close()
  await extraHarness?.close()
  running = null
  extraHarness = null
})

async function phoneOnHelper(r: Running, peer: string, family: 4 | 6 = 4): Promise<PhoneStream> {
  const phone = r.harness.server.phoneConnect(peer, family)
  await phone.accepted
  await until(() => r.helper.sockets.length > 0)
  return phone
}

describe('the relay listener', () => {
  it('RLY-C1 asks for the label, listens and reports the relay host', async () => {
    const r = await boot()
    await listening(r)
    const host = 'lbldevice1.relay.test'
    expect(r.client.status()).toEqual({ state: 'listening', host })
    expect(r.hosts).toEqual([host])
    const calls = r.harness.server.requests
    expect(calls.indexOf('POST /v1/relay/label')).toBeLessThan(
      calls.indexOf('UPGRADE /v1/relay/listen'),
    )
  })

  it('RLY-C2 answers the server ping with a pong', async () => {
    const harness = await signedIn({ pingMs: 30 })
    const r = await boot({ harness })
    await listening(r)
    await vi.waitFor(() => expect(harness.server.pongs).toBeGreaterThanOrEqual(2))
  })

  it('RLY-C3 dials nothing while it is not started', async () => {
    const r = await boot({ start: false })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(r.client.status()).toEqual({ state: 'off' })
    expect(r.harness.server.requests.filter((q) => q.includes('relay'))).toEqual([])
  })

  it('RLY-C4 stops listening, drops the label and goes off when stopped', async () => {
    const r = await boot()
    await listening(r)
    r.client.stop()
    expect(r.client.status()).toEqual({ state: 'off' })
    expect(r.hosts.at(-1)).toBeNull()
    await vi.waitFor(() => expect(r.harness.server.listenerCount()).toBe(0))
  })

  it('RLY-C5 waits for sign-in without any network and connects once signed in', async () => {
    const harness = await accountHarness()
    const r = await boot({ harness })
    expect(r.client.status()).toEqual({ state: 'needs-sign-in' })
    expect(harness.server.requests).toEqual([])
    harness.server.invites.add('late')
    await harness.account.signInWithInvite('late')
    await listening(r)
  })

  it('RLY-C6 closes the listener and forgets the host when the account signs out', async () => {
    const r = await boot()
    await listening(r)
    await r.harness.account.signOut()
    expect(r.client.status()).toEqual({ state: 'needs-sign-in' })
    expect(r.hosts.at(-1)).toBeNull()
    await vi.waitFor(() => expect(r.harness.server.listenerCount()).toBe(0))
  })

  it('RLY-C7 renews the session and retries once when the server refuses the token', async () => {
    const r = await boot({ start: false })
    await r.harness.session.ensure()
    r.harness.server.expireSessions()
    r.client.start()
    await listening(r)
    expect(r.harness.server.listenerConnections).toBe(1)
  })
})

describe('relayed phone connections', () => {
  it('RLY-C8 writes the PROXY line first and pipes bytes both ways', async () => {
    const r = await boot()
    await listening(r)
    const phone = await phoneOnHelper(r, '203.0.113.9:40000')
    phone.send(Buffer.from('\x16\x03\x01clienthello'))
    await vi.waitFor(() =>
      expect(r.helper.received(0).toString('latin1')).toBe(
        'PROXY TCP4 203.0.113.9 127.0.0.1 40000 40000\r\n\x16\x03\x01clienthello',
      ),
    )
    r.helper.sockets[0]?.write(Buffer.from('serverhello'))
    await vi.waitFor(() => expect(phone.received().toString()).toBe('serverhello'))
  })

  it('RLY-C9 writes a TCP6 PROXY line for an IPv6 phone', async () => {
    const r = await boot()
    await listening(r)
    await phoneOnHelper(r, '[2001:db8::7]:5000', 6)
    await vi.waitFor(() =>
      expect(r.helper.received(0).toString('latin1')).toBe(
        'PROXY TCP6 2001:db8::7 127.0.0.1 5000 5000\r\n',
      ),
    )
  })

  it('RLY-C10 passes binary bytes unchanged', async () => {
    const r = await boot()
    await listening(r)
    const phone = await phoneOnHelper(r, '203.0.113.9:40001')
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i))
    phone.send(bytes)
    const line = Buffer.byteLength('PROXY TCP4 203.0.113.9 127.0.0.1 40001 40001\r\n')
    await vi.waitFor(() => expect(r.helper.received(0).subarray(line)).toEqual(bytes))
  })

  it('RLY-C11 holds the phone back while the gateway is not reading, then delivers every byte', async () => {
    const r = await boot()
    await listening(r)
    const phone = await phoneOnHelper(r, '203.0.113.9:40002')
    const socket = r.helper.sockets[0] as Socket
    socket.pause()
    const block = Buffer.alloc(1024 * 1024, 7)
    const total = 24
    for (let i = 0; i < total; i += 1) phone.send(block)
    await new Promise((resolve) => setTimeout(resolve, 300))
    const heldBack = r.helper.received(0).length
    expect(heldBack).toBeLessThan(total * block.length)
    socket.resume()
    const line = Buffer.byteLength('PROXY TCP4 203.0.113.9 127.0.0.1 40002 40002\r\n')
    await vi.waitFor(() => expect(r.helper.received(0).length).toBe(line + total * block.length), {
      timeout: 10_000,
    })
  })

  it('RLY-C12 slows the gateway side when the phone is not reading', async () => {
    const r = await boot()
    await listening(r)
    const phone = await phoneOnHelper(r, '203.0.113.9:40003')
    const socket = r.helper.sockets[0] as Socket
    r.harness.server.pausePhone(phone.id)
    const block = Buffer.alloc(1024 * 1024, 9)
    let needsDrain = false
    for (let i = 0; i < 200 && !needsDrain; i += 1) {
      needsDrain = !socket.write(block)
      await new Promise((resolve) => setImmediate(resolve))
    }
    await vi.waitFor(() => expect(socket.writableNeedDrain).toBe(true))
    expect(phone.received().length).toBeLessThan(200 * block.length)
  })

  it('RLY-C13 ends the gateway connection when the phone goes away', async () => {
    const r = await boot()
    await listening(r)
    const phone = await phoneOnHelper(r, '203.0.113.9:40004')
    phone.close()
    await vi.waitFor(() => expect(r.helper.sockets[0]?.destroyed).toBe(true))
    expect(r.client.owns({ ip: '203.0.113.9', port: 40004 })).toBe(false)
  })

  it('RLY-C14 ignores an offer with a malformed peer or stream id', async () => {
    const r = await boot()
    await listening(r)
    const server = r.harness.server
    server.offer({ t: 'incoming', stream: 'ok', peer: 'not-a-peer', family: 4 })
    server.offer({ t: 'incoming', stream: 'bad id!', peer: '203.0.113.9:1', family: 4 })
    server.offer({ t: 'incoming', stream: 'ok2', peer: '203.0.113.9:70000', family: 4 })
    server.offer({ t: 'incoming', stream: 'ok3', peer: '203.0.113.9:5', family: 6 })
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(server.requests.filter((q) => q.includes('/accept/'))).toEqual([])
    expect(r.helper.sockets).toHaveLength(0)
  })
})

describe('confirming a stream', () => {
  it('RLY-C15 sends confirm only after the gateway accepted the phone, once', async () => {
    const r = await boot()
    await listening(r)
    const phone = await phoneOnHelper(r, '203.0.113.9:41000')
    const peer = { ip: '203.0.113.9', port: 41000 }
    expect(r.client.owns(peer)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(r.harness.server.confirmed).toEqual([])
    r.client.accepted(peer)
    r.client.accepted(peer)
    await vi.waitFor(() => expect(r.harness.server.confirmed).toEqual([phone.id]))
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(r.harness.server.confirmed).toEqual([phone.id])
  })

  it('RLY-C16 confirms nothing for a peer it did not relay', async () => {
    const r = await boot()
    await listening(r)
    await phoneOnHelper(r, '203.0.113.9:41001')
    expect(r.client.owns({ ip: '198.51.100.1', port: 41001 })).toBe(false)
    r.client.accepted({ ip: '198.51.100.1', port: 41001 })
    r.client.accepted({ ip: '203.0.113.9', port: 1 })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(r.harness.server.confirmed).toEqual([])
  })
})

describe('reconnecting', () => {
  it('RLY-C17 reconnects after the server drops the listener', async () => {
    const r = await boot({ random: () => 0 })
    await listening(r)
    r.harness.server.dropListener('device1', 1008)
    await vi.waitFor(() => expect(r.harness.server.listenerConnections).toBe(2), { timeout: 5000 })
    await listening(r)
  })

  it('RLY-C18 backs off 1 s doubling to 60 s with jitter while the server is away', async () => {
    const r = await boot({ random: () => 1 })
    await listening(r)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await r.harness.server.close()
    const attempts = (): number => r.states.filter((s) => s.state === 'connecting').length
    await until(() => attempts() === 2 && vi.getTimerCount() > 0)
    for (const delay of [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
      const before = attempts()
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(attempts()).toBe(before)
      await vi.advanceTimersByTimeAsync(1)
      await until(() => attempts() === before + 1 && r.client.status().state === 'error')
    }
  })

  it('RLY-C19 halves the wait at the lowest jitter', async () => {
    const r = await boot({ random: () => 0 })
    await listening(r)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await r.harness.server.close()
    const attempts = (): number => r.states.filter((s) => s.state === 'connecting').length
    await until(() => attempts() === 2 && vi.getTimerCount() > 0)
    await vi.advanceTimersByTimeAsync(499)
    expect(attempts()).toBe(2)
    await vi.advanceTimersByTimeAsync(1)
    await until(() => attempts() === 3)
  })

  it('RLY-C20 re-dials before the session expires and the newer listener replaces the older', async () => {
    const harness = await signedIn({ sessionTtlMs: 130_000 })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const r = await boot({ harness })
    await until(() => r.client.status().state === 'listening')
    const first = harness.session.current()?.token
    await vi.advanceTimersByTimeAsync(10_000)
    await until(() => harness.server.listenerConnections === 2)
    expect(harness.session.current()?.token).not.toBe(first)
    await until(() => harness.server.listenerCount() === 1)
    expect(r.client.status().state).toBe('listening')
  })

  it('RLY-C21 keeps streams of the older listener running when it is replaced', async () => {
    const harness = await signedIn({ sessionTtlMs: 130_000 })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const r = await boot({ harness })
    await until(() => r.client.status().state === 'listening')
    const phone = await phoneOnHelper(r, '203.0.113.9:42000')
    await vi.advanceTimersByTimeAsync(10_000)
    await until(() => harness.server.listenerConnections === 2)
    vi.useRealTimers()
    r.helper.sockets[0]?.write(Buffer.from('still here'))
    await vi.waitFor(() => expect(phone.received().toString()).toBe('still here'))
  })
})
