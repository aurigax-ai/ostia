import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ControlMethod, ControlMethodContext } from '../control/controlServer'

const methods = new Map<string, ControlMethod>()
vi.mock('../control/controlServer', () => ({
  registerControlMethod: (name: string, method: ControlMethod) => methods.set(name, method),
}))

const { registerPane } = await import('../control/idRegistry')
const { registerPaneListMethods } = await import('./paneList')
const { claimName, forgetNames } = await import('./paneNames')

const named = registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'list-named' })
const plain = registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'list-plain' })

registerPaneListMethods({
  execCommand: async () => ({
    ok: true,
    result: [
      { paneId: 'list-named', workspaceId: 's1', kind: 'terminal', title: 'a' },
      { paneId: 'list-plain', workspaceId: 's1', kind: 'terminal', title: 'b' },
    ],
  }),
  getTerminalState: () => undefined,
  ptyPid: () => undefined,
  windowIds: () => ['1'],
  waking: () => false,
})

function list(kind: 'pane' | 'extension'): Promise<Array<Record<string, unknown>>> {
  const ctx = {
    identity: { ...named, kind },
    authed: {},
    conn: {},
  } as unknown as ControlMethodContext
  return Promise.resolve(methods.get('pane.list')?.handler({}, ctx)) as never
}

beforeEach(forgetNames)

describe('pane.list names', () => {
  it('shows the bus name and description of a named pane to a pane', async () => {
    claimName('list-named', 'boss', 'plans', () => true)
    const panes = await list('pane')
    expect(panes.find((p) => p.paneId === named.externalId)).toMatchObject({
      name: 'boss',
      description: 'plans',
    })
    expect(panes.find((p) => p.paneId === plain.externalId)).not.toHaveProperty('name')
  })

  it('never shows them to an extension', async () => {
    claimName('list-named', 'boss', 'plans', () => true)
    for (const pane of await list('extension')) {
      expect(pane).not.toHaveProperty('name')
      expect(pane).not.toHaveProperty('description')
    }
  })
})
