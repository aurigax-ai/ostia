import { describe, expect, it } from 'vitest'
import type { MessageConnection } from 'vscode-jsonrpc/node'
import { opensAsTarget } from './open'
import { workspaceFolderIn } from './workspace'

function connection(handlers: Record<string, () => unknown>): MessageConnection {
  return {
    sendRequest: async (method: string) => handlers[method]?.(),
  } as unknown as MessageConnection
}

describe('opensAsTarget', () => {
  it('lets an extension or command id win over a file of that name', async () => {
    const conn = connection({
      'ext.list': () => [{ id: 'package.json' }],
      'command.list': () => [],
    })
    expect(await opensAsTarget(conn, 'package.json')).toBe(false)
  })

  it('fails instead of opening a file when ext.list or command.list fails', async () => {
    const failing = (method: string) =>
      connection({
        'ext.list': () => [],
        'command.list': () => [],
        [method]: () => {
          throw new Error('refused')
        },
      })
    await expect(opensAsTarget(failing('ext.list'), 'package.json')).rejects.toThrow('refused')
    await expect(opensAsTarget(failing('command.list'), 'package.json')).rejects.toThrow('refused')
  })
})

describe('workspaceFolderIn', () => {
  it('fails instead of creating a second workspace when sameFolder fails', async () => {
    const calls: string[] = []
    const conn = {
      sendRequest: async (method: string) => {
        calls.push(method)
        throw new Error('refused')
      },
    } as unknown as MessageConnection
    await expect(workspaceFolderIn(conn, '/tmp/x', false)).rejects.toThrow('refused')
    expect(calls).toEqual(['workspace.sameFolder'])
  })
})
