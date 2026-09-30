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
import type { CommandDescriptor, CommandResult } from '../../shared/types'
import { registerControlServer, stopControlServer } from '../controlServer'
import { registerPane } from '../idRegistry'
import { registerSandboxMethods } from './controlMethods'
import { DomainRequests } from './domainRequests'

let dir: string
let conn: MessageConnection
let destroy: () => void

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pine-sbx-ctl-'))
  registerSandboxMethods({
    domains: new DomainRequests({
      isSandboxed: () => true,
      ask: async () => 'deny',
      allowWorkspace: () => undefined,
      allowUntilRestart: () => undefined,
      now: Date.now,
    }),
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
  const id = registerPane({ windowId: 'w1', workspaceId: 'ws', paneId: 'pane-ctl' })
  await conn.sendRequest('hello', { token: id.token })
})

afterAll(() => {
  destroy?.()
  stopControlServer()
  rmSync(dir, { recursive: true, force: true })
})

const refuses = (method: string, params: unknown) =>
  expect(conn.sendRequest(method, params)).rejects.toThrow()

describe('sandbox control methods', () => {
  it('SBX-C27 offers an agent no socket method that adds a read path', async () => {
    for (const method of [
      'sandbox.set-allow-read',
      'sandbox.allow-read',
      'sandbox.add-read-path',
      'sandbox.set-enabled',
      'sandbox.update',
    ]) {
      await refuses(method, { workspaceId: 'ws', paths: ['/etc'], enabled: false })
    }
  })

  it('SBX-C54 offers an agent no socket method that changes the Pine access switches', async () => {
    for (const method of ['sandbox.set-controls', 'sandbox.controls', 'sandbox.set-domains']) {
      await refuses(method, { workspaceId: 'ws', allWorkspaces: true, browser: 'unrestricted' })
    }
  })
})
