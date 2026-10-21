import { existsSync, lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  connectHostChannel,
  HostChannelError,
  JsonLines,
  type ListeningChannel,
  listenHostChannel,
} from './hostChannel'
import { SandboxHost } from './hostClient'
import { HOST_PROTOCOL_VERSION, type HostToMain, type MainToHost } from './protocol'

const root = mkdtempSync(join(tmpdir(), 'ostia-host-channel-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let n = 0

function received(socket: Socket): HostToMain[] {
  const out: HostToMain[] = []
  const lines = new JsonLines((m) => {
    const message = m as HostToMain
    if (!('type' in message) || message.type !== 'hello') out.push(message)
  })
  socket.on('data', (chunk: Buffer) => lines.push(chunk))
  return out
}

const POLL = { timeout: 3000, interval: 10 }

async function channel(onMessage: (m: MainToHost) => void = () => undefined) {
  const path = join(root, `h${n++}.sock`)
  const listening: ListeningChannel = await listenHostChannel(path, (m) => onMessage(m))
  return { path, listening }
}

describe('host channel', () => {
  it('KSH-C51 holds a question asked while no Ostia is connected and asks the next one that connects', async () => {
    const answers: MainToHost[] = []
    const { path, listening } = await channel((m) => answers.push(m))
    listening.send({ type: 'ask', askId: 1, host: 'example.org', port: 443 })
    listening.send({ type: 'violations', lines: ['denied write /x'] })
    const first = await connectHostChannel(path)
    const firstGot = received(first)
    await vi.waitUntil(() => firstGot.length === 2, POLL)
    expect(firstGot).toContainEqual({ type: 'ask', askId: 1, host: 'example.org', port: 443 })
    first.destroy()
    const second = await connectHostChannel(path)
    const secondGot = received(second)
    await vi.waitUntil(() => secondGot.length === 1, POLL)
    expect(secondGot).toEqual([{ type: 'ask', askId: 1, host: 'example.org', port: 443 }])
    second.write(`${JSON.stringify({ type: 'ask-answer', askId: 1, allow: true })}\n`)
    await vi.waitUntil(() => answers.length === 1, POLL)
    second.destroy()
    const third = await connectHostChannel(path)
    const thirdGot = received(third)
    await new Promise((r) => setTimeout(r, 100))
    expect(thirdGot).toEqual([])
    third.destroy()
    listening.close()
  })

  it('KSH-C53 refuses a channel path that is a symlink, a plain file or missing', async () => {
    const { path, listening } = await channel()
    const link = join(root, `link${n++}.sock`)
    symlinkSync(path, link)
    const file = join(root, `file${n++}.sock`)
    writeFileSync(file, '')
    await expect(connectHostChannel(link)).rejects.toBeInstanceOf(HostChannelError)
    await expect(connectHostChannel(file)).rejects.toBeInstanceOf(HostChannelError)
    await expect(connectHostChannel(join(root, 'missing.sock'))).rejects.toBeInstanceOf(
      HostChannelError,
    )
    await expect(connectHostChannel(path, (process.getuid?.() ?? 0) + 1)).rejects.toBeInstanceOf(
      HostChannelError,
    )
    listening.close()
  })

  it('answers a request only to the Ostia that asked it', async () => {
    const respondLater: ((id: number) => void)[] = []
    const path = join(root, `h${n++}.sock`)
    const listening = await listenHostChannel(path, (message, respond) => {
      if ('id' in message) respondLater.push((id) => respond({ id, ok: true }))
    })
    const first = await connectHostChannel(path)
    first.write(`${JSON.stringify({ id: 1, type: 'cleanup' })}\n`)
    await vi.waitUntil(() => respondLater.length === 1, POLL)
    first.destroy()
    const second = await connectHostChannel(path)
    const secondGot = received(second)
    respondLater[0](1)
    await new Promise((r) => setTimeout(r, 100))
    expect(secondGot).toEqual([])
    second.destroy()
    listening.close()
  })

  it('greets every Ostia that connects with its protocol version first', async () => {
    const { path, listening } = await channel()
    listening.send({ type: 'violations', lines: ['denied write /x'] })
    const socket = await connectHostChannel(path)
    const got: unknown[] = []
    const lines = new JsonLines((m) => got.push(m))
    socket.on('data', (chunk: Buffer) => lines.push(chunk))
    await vi.waitUntil(() => got.length === 2, POLL)
    expect(got[0]).toEqual({ type: 'hello', protocol: HOST_PROTOCOL_VERSION })
    socket.destroy()
    listening.close()
  })

  it('KSH-C75 refuses a sandbox host that speaks another protocol version', async () => {
    const path = join(root, `old${n++}.sock`)
    const server = createServer((socket) => {
      socket.write(`${JSON.stringify({ type: 'hello', protocol: HOST_PROTOCOL_VERSION + 1 })}\n`)
    })
    await new Promise<void>((r) => server.listen(path, r))
    const host = new SandboxHost({
      nodePath: process.execPath,
      hostScript: '',
      onAsk: async () => false,
    })
    await expect(
      host.attach(
        path,
        {
          network: { allowedDomains: [], deniedDomains: [] },
          filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
        },
        undefined,
        false,
      ),
    ).rejects.toThrow(/protocol/)
    server.close()
  })

  it('shows the channel path only once it listens, private and no longer than the path', async () => {
    const path = join(root, `ready${n++}.sock`)
    const listen = vi.spyOn(Server.prototype, 'listen')
    try {
      const listening = await listenHostChannel(path, () => undefined)
      const staged = listen.mock.calls[0]?.[0] as string
      expect(dirname(staged)).toBe(dirname(path))
      expect(basename(staged)).not.toBe(basename(path))
      expect(Buffer.byteLength(staged)).toBe(Buffer.byteLength(path))
      expect(existsSync(staged)).toBe(false)
      expect(lstatSync(path).isSocket()).toBe(true)
      expect(lstatSync(path).mode & 0o777).toBe(0o600)
      const socket = await connectHostChannel(path)
      socket.destroy()
      listening.close()
    } finally {
      listen.mockRestore()
    }
  })

  it('does not take a server that another process already listens on', async () => {
    const path = join(root, `busy${n++}.sock`)
    const other = createServer()
    await new Promise<void>((r) => other.listen(path, r))
    await expect(connectHostChannel(path)).resolves.toBeDefined()
    other.close()
  })
})
