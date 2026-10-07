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
import type { CommandDescriptor, CommandResult } from '../shared/types'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString().replace(/^enc:/, ''),
  },
}))

const { registerControlServer, stopControlServer } = await import('./controlServer')
const { registerPane } = await import('./idRegistry')
const { registerVaultMethods } = await import('./vault')
const { grant } = await import('./capabilityStore')

let dir: string
let conn: MessageConnection
let destroy: () => void

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ostia-vault-sbx-'))
  process.env.XDG_DATA_HOME = dir
  registerVaultMethods({ isSandboxed: (workspaceId) => workspaceId === 'ws-sbx' })
  const socketPath = join(dir, 'vault.sock')
  registerControlServer(
    {
      execCommand: async () => ({ ok: true }) as CommandResult,
      listCommandsFor: () => [] as CommandDescriptor[],
      getTerminalState: () => undefined,
      isSandboxed: () => false,
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
  rmSync(dir, { recursive: true, force: true })
})

async function as(workspaceId: string, paneId: string): Promise<void> {
  const id = registerPane({ windowId: 'w1', workspaceId, paneId })
  for (const cap of ['vault-read', 'vault-write', 'all-workspaces'] as const)
    grant(id.externalId, cap)
  await conn.sendRequest('hello', { token: id.token })
}

describe('vault in a sandboxed workspace', () => {
  it('SBX-C79 still hands a vault value to an unsandboxed workspace', async () => {
    await as('ws-plain', 'pane-plain')
    await conn.sendRequest('vault.set', { key: 'K', value: 'plain-value', scope: 'global' })
    await expect(conn.sendRequest('vault.get', { key: 'K', scope: 'global' })).resolves.toEqual({
      value: 'plain-value',
    })
  })

  it('SBX-C78 refuses vault get in a sandboxed workspace with a hint, and vault ls still works', async () => {
    await as('ws-sbx', 'pane-sbx')
    const res = (await conn.sendRequest('vault.get', { key: 'K', scope: 'global' })) as {
      ok?: boolean
      error?: string
      message?: string
      value?: string
    }
    expect(res.value).toBeUndefined()
    expect(res.error).toBe('sandboxed')
    expect(res.message).toContain('ostia secret get')
    await expect(conn.sendRequest('vault.list', { scope: 'global' })).resolves.toMatchObject({
      keys: ['K'],
    })
  })
})
