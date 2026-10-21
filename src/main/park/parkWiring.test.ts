import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ControlMethodContext } from '../control/controlServer'
import type { ExtensionHost } from '../extensions/extensionHost'

type Handler = (params: unknown, ctx: ControlMethodContext) => unknown
const registered = new Map<string, { handler: Handler; cap?: string; callers?: string }>()
const ipc = new Map<string, unknown>()
const dir = mkdtempSync(join(tmpdir(), 'park-wiring-'))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: unknown) => ipc.set(channel, fn) },
}))
vi.mock('../control/controlServer', () => ({
  registerControlMethod: (name: string, method: { handler: Handler }) =>
    registered.set(name, method),
}))
vi.mock('../control/idRegistry', () => ({
  getByPaneId: vi.fn(),
  panesOwnedBy: vi.fn(() => false),
  resolveExternal: vi.fn(),
}))
vi.mock('../platform/jsonStore', async (orig) => ({
  ...(await orig<typeof import('../platform/jsonStore')>()),
  storePath: () => join(dir, 'parked-sessions.json'),
}))

import { resolveExternal } from '../control/idRegistry'
import { registerParkWiring } from './parkWiring'

const ctx = {} as ControlMethodContext

let resumeListener: ((pane: string, resume: unknown) => void) | undefined

function wire(builtin: string | null) {
  const store = registerParkWiring({
    services: { extensionHost: { builtinId: () => builtin } as unknown as ExtensionHost },
    execCommand: vi.fn(async () => ({ ok: false, error: { code: 'x', message: 'x' } })),
    getTerminalState: () => undefined,
    ptyPid: () => undefined,
    windowIds: () => [],
    isWaking: () => false,
    ptys: new Map(),
    agentRunning: { has: () => false },
    agentWork: { reason: () => null },
    agentResumes: { subscribe: (fn: typeof resumeListener) => (resumeListener = fn) },
    paneJournal: { closing: () => undefined },
    redactor: { text: async (t: string) => t },
    scratchFolders: { isScratch: () => false },
    workspaceSandboxes: { isEnabled: () => false },
    workspaceCommandTarget: () => ({ windowId: '1', workspaceId: 'w1', paneId: null }),
    remoteCwdOfPane: () => undefined,
  } as never)
  return store
}

beforeEach(() => {
  registered.clear()
  ipc.clear()
})

describe('parked sessions host methods', () => {
  it.each(['ext.parkedList', 'ext.parkedResume', 'ext.parkedForget'])(
    '%s answers only the built-in activity extension',
    async (name) => {
      for (const builtin of [null, 'skills', 'agent']) {
        registered.clear()
        const store = wire(builtin)
        store.park({
          workspaceId: 'w1',
          resume: { agent: 'claude', id: 's1', cwd: '/a' },
          title: 't',
        })
        const id = store.list('w1')[0]?.id
        expect(await registered.get(name)?.handler({ workspaceId: 'w1', id }, ctx)).toEqual({
          ok: false,
          error: 'activity-only',
        })
        expect(store.get(id as string)).toBeDefined()
      }
    },
  )

  it('lists display fields for the workspace the activity extension names', async () => {
    const store = wire('activity')
    store.park({
      workspaceId: 'w1',
      resume: { agent: 'claude', id: 's1', cwd: '/a', args: ['--model', 'opus'] },
      title: 'export',
      summary: 'stopped',
    })
    store.park({
      workspaceId: 'w2',
      resume: { agent: 'codex', id: 's2', cwd: '/b' },
      title: 'billing',
    })
    const res = (await registered.get('ext.parkedList')?.handler({ workspaceId: 'w1' }, ctx)) as {
      ok: boolean
      items: { title: string }[]
    }
    expect(res.ok).toBe(true)
    expect(res.items.map((i) => i.title)).toEqual(['export'])
    expect(JSON.stringify(res)).not.toContain('opus')
    expect(await registered.get('ext.parkedList')?.handler({}, ctx)).toEqual({
      ok: false,
      error: 'invalid-params',
    })
  })

  it('forgets one record for the activity extension', async () => {
    const store = wire('activity')
    store.park({ workspaceId: 'w1', resume: { agent: 'claude', id: 's1', cwd: '/a' }, title: 't' })
    const id = store.list('w1')[0]?.id
    expect(await registered.get('ext.parkedForget')?.handler({ id }, ctx)).toEqual({ ok: true })
    expect(store.list('w1')).toHaveLength(0)
    expect(await registered.get('ext.parkedForget')?.handler({ id }, ctx)).toEqual({
      ok: false,
      error: 'unknown-parked',
    })
  })

  it('needs the board capability and answers extensions only', () => {
    wire('activity')
    for (const name of ['ext.parkedList', 'ext.parkedResume', 'ext.parkedForget']) {
      expect(registered.get(name)).toMatchObject({ cap: 'read-board', callers: 'extensions' })
    }
  })
})

describe('a resumed session', () => {
  it('removes its record when a pane of that workspace reports the same session', () => {
    const store = wire('activity')
    store.park({ workspaceId: 'w1', resume: { agent: 'claude', id: 's1', cwd: '/a' }, title: 't' })
    store.park({ workspaceId: 'w1', resume: { agent: 'claude', id: 's2', cwd: '/a' }, title: 'u' })
    vi.mocked(resolveExternal).mockReturnValue({ kind: 'pane', workspaceId: 'w2' } as never)
    resumeListener?.('x9', { agent: 'claude', id: 's1' })
    expect(store.list('w1')).toHaveLength(2)
    vi.mocked(resolveExternal).mockReturnValue({ kind: 'pane', workspaceId: 'w1' } as never)
    resumeListener?.('x9', { agent: 'claude', id: 's1' })
    expect(store.list('w1').map((r) => r.title)).toEqual(['u'])
  })
})

describe('park:pane', () => {
  it('refuses a pane the sender window does not own and bad arguments', async () => {
    wire('activity')
    const handler = ipc.get('park:pane') as (e: unknown, ...a: unknown[]) => Promise<unknown>
    expect(await handler({ sender: { id: 1 } }, 'w1', 'p1', '')).toEqual({
      ok: false,
      reason: 'unavailable',
    })
    expect(await handler({ sender: { id: 1 } }, 1, 'p1', '')).toEqual({
      ok: false,
      reason: 'unavailable',
    })
  })
})
