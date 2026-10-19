import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { type CodexServerIo, startCodexServer, stopCodexServer, userRemote } from './codexServer'

const dir = mkdtempSync(join(tmpdir(), 'ostia-codexserver-'))
const agentDir = join(dir, 'agent')
const socket = join(dir, 'pane.codex.sock')
mkdirSync(join(agentDir, 'codex'), { recursive: true })
writeFileSync(
  join(agentDir, 'codex', 'hook-args.json'),
  JSON.stringify(['--no-daemon', '-c', 'hooks.x=1']),
)

afterAll(() => rmSync(dir, { recursive: true, force: true }))

function setup(over: Partial<CodexServerIo> = {}, appears = true) {
  const spawned: {
    bin: string
    args: string[]
    env: Record<string, string | undefined>
    cwd: string
  }[] = []
  const io: CodexServerIo = {
    env: { OSTIA_CODEX_SOCK: socket, OSTIA_AGENT_DIR: agentDir, PATH: '/bin', KEEP: 'yes' },
    cwd: '/work/here',
    findCodex: () => '/bin/codex',
    spawnServer: (bin, args, env, cwd) => {
      spawned.push({ bin, args, env, cwd })
      if (appears) writeFileSync(socket, '')
      return 4242
    },
    alive: () => true,
    kill: vi.fn(),
    sleep: async () => {},
    attach: vi.fn(async () => ({ ok: true })),
    detach: vi.fn(async () => ({ ok: true })),
    ...over,
  }
  return { io, spawned }
}

beforeEach(() => {
  rmSync(socket, { force: true })
  rmSync(`${socket}.pid`, { force: true })
})

describe('userRemote', () => {
  it('sees the user’s own --remote, with or without a value', () => {
    expect(userRemote(['--remote', 'ws://x'])).toBe(true)
    expect(userRemote(['--remote=ws://x'])).toBe(true)
    expect(userRemote(['resume', 'abc', '-m', 'o3'])).toBe(false)
  })
})

describe('startCodexServer', () => {
  it('starts app-server with the hook flags on the pane’s socket, in the pane’s folder and env, and attaches', async () => {
    const { io, spawned } = setup()
    const started = await startCodexServer(['resume', 'abc', '-m', 'o3'], io)
    expect(started).toBe(socket)
    expect(spawned).toHaveLength(1)
    expect(spawned[0]).toMatchObject({
      bin: '/bin/codex',
      args: ['--no-daemon', '-c', 'hooks.x=1', 'app-server', '--listen', `unix://${socket}`],
      cwd: '/work/here',
    })
    expect(spawned[0].env.KEEP).toBe('yes')
    expect(spawned[0].env.OSTIA_CODEX_ARGS).toBe('resume\u001fabc\u001f-m\u001fo3')
    expect(io.attach).toHaveBeenCalledOnce()
    expect(readFileSync(`${socket}.pid`, 'utf8')).toBe('4242')
  })

  it('starts nothing when the user brought their own --remote', async () => {
    const { io, spawned } = setup()
    expect(await startCodexServer(['--remote', 'ws://x'], io)).toBeUndefined()
    expect(spawned).toEqual([])
  })

  it.each([
    ['no socket path in the pane env', { env: { OSTIA_AGENT_DIR: agentDir } }],
    ['no agent folder', { env: { OSTIA_CODEX_SOCK: socket } }],
    ['no codex on the path', { findCodex: () => undefined }],
    ['no hook flags file', { env: { OSTIA_CODEX_SOCK: socket, OSTIA_AGENT_DIR: dir } }],
  ])('starts nothing with %s', async (_why, over) => {
    const { io, spawned } = setup(over as Partial<CodexServerIo>)
    expect(await startCodexServer([], io)).toBeUndefined()
    expect(spawned).toEqual([])
  })

  it('gives up and stops the server when the socket never appears', async () => {
    const { io } = setup({}, false)
    expect(await startCodexServer([], io)).toBeUndefined()
    expect(io.kill).toHaveBeenCalledWith(4242)
    expect(io.attach).not.toHaveBeenCalled()
  })

  it('gives up at once when the server process died', async () => {
    const { io } = setup({ alive: () => false }, false)
    expect(await startCodexServer([], io)).toBeUndefined()
    expect(io.kill).not.toHaveBeenCalled()
  })

  it('gives up when the process could not be started', async () => {
    const { io } = setup({ spawnServer: () => undefined })
    expect(await startCodexServer([], io)).toBeUndefined()
  })

  it('removes a stale socket from an earlier run before it starts', async () => {
    writeFileSync(socket, 'stale')
    const { io } = setup({
      spawnServer: () => {
        expect(existsSync(socket)).toBe(false)
        writeFileSync(socket, '')
        return 1
      },
    })
    expect(await startCodexServer([], io)).toBe(socket)
  })
})

describe('stopCodexServer', () => {
  it('detaches, stops the server it started and removes its files', async () => {
    const { io } = setup()
    await startCodexServer([], io)
    await stopCodexServer(io)
    expect(io.detach).toHaveBeenCalledOnce()
    expect(io.kill).toHaveBeenCalledWith(4242)
    expect(existsSync(socket)).toBe(false)
    expect(existsSync(`${socket}.pid`)).toBe(false)
  })

  it('does nothing in a pane without a socket path, and survives a missing pid file', async () => {
    const none = setup({ env: {} })
    await stopCodexServer(none.io)
    expect(none.io.detach).not.toHaveBeenCalled()
    const { io } = setup()
    await expect(stopCodexServer(io)).resolves.toBeUndefined()
    expect(io.kill).not.toHaveBeenCalled()
  })
})
