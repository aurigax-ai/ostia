import { mkdtempSync, rmSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
} from 'vscode-jsonrpc/node'
import type { CommandDescriptor, CommandResult } from '../shared/types'
import { registerControlServer, stopControlServer } from './controlServer'
import { registerPane } from './idRegistry'
import { registerProcessMethods } from './processManager'
import { SandboxUnavailableError } from './sandbox/workspaceSandboxes'
import { setWorkspaceWorkDir } from './workspaceRegistry'

const SANDBOXED = 'ws-sandboxed'
const BROKEN = 'ws-broken'

let dataHome: string
let conn: MessageConnection
let destroy: () => void
const wraps: string[] = []

async function until<T>(read: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 50))
  }
}

async function helloAs(workspaceId: string, paneId: string): Promise<void> {
  const id = registerPane({ windowId: 'w1', workspaceId, paneId })
  await conn.sendRequest('hello', { token: id.token })
}

async function outputOf(id: string, text: string): Promise<string> {
  return until(async () => {
    const out = (await conn.sendRequest('process.output', { id })) as { data: string }
    return out.data.includes(text) ? out.data : undefined
  })
}

beforeAll(async () => {
  dataHome = mkdtempSync(join(tmpdir(), 'pine-proc-sbx-'))
  process.env.XDG_DATA_HOME = dataHome
  setWorkspaceWorkDir(SANDBOXED, dataHome)
  setWorkspaceWorkDir(BROKEN, dataHome)
  registerProcessMethods({
    sandbox: {
      isEnabled: (workspaceId) => workspaceId === SANDBOXED || workspaceId === BROKEN,
      tmpDir: () => dataHome,
      wrap: async (workspaceId, command) => {
        if (workspaceId === BROKEN) {
          throw new SandboxUnavailableError('bubblewrap (bwrap) not found', ['bwrap not found'])
        }
        wraps.push(command)
        return `echo WRAPPED-BY-SANDBOX && ${command}`
      },
    },
  })
  const socketPath = join(tmpdir(), `pine-proc-sbx-${process.pid}.sock`)
  registerControlServer(
    {
      execCommand: async () => ({ ok: true }) as CommandResult,
      listCommandsFor: () => [] as CommandDescriptor[],
      getTerminalState: () => undefined,
    },
    socketPath,
  )
  const socket = createConnection(socketPath)
  conn = createMessageConnection(new StreamMessageReader(socket), new StreamMessageWriter(socket))
  conn.listen()
  destroy = () => socket.destroy()
})

afterAll(() => {
  destroy?.()
  stopControlServer()
  rmSync(dataHome, { recursive: true, force: true })
})

describe('pine process in a sandboxed workspace', () => {
  it('SBX-C2 runs a started process through the workspace sandbox', async () => {
    await helloAs(SANDBOXED, 'pane-c2')
    const started = (await conn.sendRequest('process.run', { cmd: 'echo C2-RAN' })) as {
      id: string
    }
    const out = await outputOf(started.id, 'C2-RAN')
    expect(out).toContain('WRAPPED-BY-SANDBOX')
    expect(wraps).toContain('echo C2-RAN')
  })

  it('SBX-C4 wraps a restarted process again', async () => {
    const started = (await conn.sendRequest('process.run', { cmd: 'echo C4-RAN' })) as {
      id: string
    }
    await outputOf(started.id, 'C4-RAN')
    const before = wraps.filter((c) => c === 'echo C4-RAN').length
    await conn.sendRequest('process.restart', { id: started.id })
    await until(async () =>
      wraps.filter((c) => c === 'echo C4-RAN').length > before ? true : undefined,
    )
    const out = await outputOf(started.id, 'WRAPPED-BY-SANDBOX')
    expect(out).toContain('C4-RAN')
  })

  it('SBX-C10 refuses to start a process when the sandbox cannot start, and spawns nothing', async () => {
    await helloAs(BROKEN, 'pane-c10')
    const res = (await conn.sendRequest('process.run', { cmd: 'echo C10-RAN' })) as {
      ok?: boolean
      error?: string
      message?: string
    }
    expect(res.ok).toBe(false)
    expect(res.error).toBe('sandbox-unavailable')
    expect(res.message).toContain('bwrap')
    const list = (await conn.sendRequest('process.list')) as { workspaceId: string }[]
    expect(list.filter((p) => p.workspaceId === BROKEN)).toHaveLength(0)
  })
})
