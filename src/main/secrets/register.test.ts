import { mkdtempSync, rmSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
} from 'vscode-jsonrpc/node'
import type { CommandDescriptor, CommandResult } from '../../shared/types'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

const { registerControlServer, stopControlServer } = await import('../controlServer')
const { registerPane } = await import('../idRegistry')
const { registerSecretMethods } = await import('./register')
const { SecretService } = await import('./secretService')

let dir: string
let conn: MessageConnection
let destroy: () => void

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pine-secret-ctl-'))
  const service = new SecretService({
    home: () => dir,
    env: () => ({ GITHUB_TOKEN: 'ghp_x' }),
    ghToken: () => null,
    vault: { list: () => [], get: () => null },
    grantedIds: () => [],
    ask: async () => 'deny',
  })
  registerSecretMethods({
    service,
    sandboxes: {} as never,
    ownerWindow: () => undefined,
  })
  const socketPath = join(dir, 'ctl.sock')
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
  const id = registerPane({ windowId: 'w1', workspaceId: 'ws', paneId: 'pane-secret' })
  await conn.sendRequest('hello', { token: id.token })
})

afterAll(() => {
  destroy?.()
  stopControlServer()
  rmSync(dir, { recursive: true, force: true })
})

describe('secret service and browser logins', () => {
  it('SBX-C100 neither lists nor fills saved browser logins', async () => {
    await expect(conn.sendRequest('secret.fill', { origin: 'https://a.example' })).rejects.toThrow()
    const list = (await conn.sendRequest('secret.list')) as { source: string }[]
    expect(list.map((s) => s.source)).not.toContain('browser')
    expect(list.map((s) => s.source)).toContain('host')
  })
})
