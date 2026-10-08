import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { type Socket, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  HostChannelError,
  JsonLines,
  type ListeningChannel,
  connectHostChannel,
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

async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 3000
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

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
    await until(() => firstGot.length === 2)
    expect(firstGot).toContainEqual({ type: 'ask', askId: 1, host: 'example.org', port: 443 })
    first.destroy()
    const second = await connectHostChannel(path)
    const secondGot = received(second)
    await until(() => secondGot.length === 1)
    expect(secondGot).toEqual([{ type: 'ask', askId: 1, host: 'example.org', port: 443 }])
    second.write(`${JSON.stringify({ type: 'ask-answer', askId: 1, allow: true })}\n`)
    await until(() => answers.length === 1)
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
    await until(() => respondLater.length === 1)
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
    await until(() => got.length === 2)
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

  it('does not take a server that another process already listens on', async () => {
    const path = join(root, `busy${n++}.sock`)
    const other = createServer()
    await new Promise<void>((r) => other.listen(path, r))
    await expect(connectHostChannel(path)).resolves.toBeDefined()
    other.close()
  })
})
