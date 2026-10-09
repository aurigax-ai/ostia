import { openExtensionTerminal } from '@/commands/extensionBridge'
import { createPane } from '@/layout/tree'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import type { ExtensionInfo } from '@shared/extensions'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { listSshHosts, openSshWorkspace, sshEnabled } from './sshWorkspace'

describe('sshWorkspace', () => {
  let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
  let layoutInit: ReturnType<typeof useLayoutStore.getState>

  beforeAll(() => {
    workspacesInit = useWorkspacesStore.getState()
    layoutInit = useLayoutStore.getState()
  })

  afterEach(() => {
    useWorkspacesStore.setState(workspacesInit, true)
    useLayoutStore.setState(layoutInit, true)
    vi.restoreAllMocks()
  })

  function seedWorkspace(): string {
    useWorkspacesStore.setState({
      workspaces: [{ id: 'seed', name: 'home', kind: 'terminal', workDir: '/home', state: 'idle' }],
      activeWorkspaceId: 'seed',
    })
    const pane = createPane('terminal')
    useLayoutStore.setState({
      byWorkspace: { seed: { root: pane, activePaneId: pane.id, zoomedPaneId: null } },
    })
    return pane.id
  }

  it('treats SSH as available only when the extension is on and has connect', () => {
    const ext = {
      id: 'ssh',
      enabled: true,
      commands: [{ id: 'connect' }],
    } as unknown as ExtensionInfo
    expect(sshEnabled([ext])).toBe(true)
    expect(sshEnabled([{ ...ext, enabled: false }])).toBe(false)
    expect(sshEnabled([{ ...ext, commands: [] }])).toBe(false)
    expect(sshEnabled([])).toBe(false)
  })

  it('reads host aliases and drops malformed entries', async () => {
    window.ostia.extensions.invoke = vi.fn().mockResolvedValue({
      ok: true,
      data: { hosts: [{ alias: 'db' }, { alias: '' }, null, { name: 'x' }, { alias: 'web' }] },
    })
    expect(await listSshHosts()).toEqual({ hosts: ['db', 'web'], truncated: false })
  })

  it('returns null when the extension refuses to list hosts', async () => {
    window.ostia.extensions.invoke = vi.fn().mockResolvedValue({ ok: false, error: 'sandboxed' })
    expect(await listSshHosts()).toBeNull()
  })

  it('closes the empty workspace and reports on the previous one when connect fails', async () => {
    const paneId = seedWorkspace()
    window.ostia.extensions.invoke = vi
      .fn()
      .mockResolvedValue({ ok: false, error: 'resolve-failed', message: 'no such host' })

    expect(await openSshWorkspace('ghost')).toBe(false)

    const state = useWorkspacesStore.getState()
    expect(state.workspaces.map((w) => w.id)).toEqual(['seed'])
    expect(state.activeWorkspaceId).toBe('seed')
    expect(window.ostia.notifications.post).toHaveBeenCalledWith({
      paneId,
      kind: 'error',
      title: 'Could not connect to ghost',
      body: 'no such host',
      desktop: false,
    })
  })

  it('keeps the new workspace when the session opened', async () => {
    seedWorkspace()
    window.ostia.extensions.invoke = vi.fn().mockResolvedValue({ ok: true, data: { paneId: 'p' } })

    expect(await openSshWorkspace('db')).toBe(true)

    const state = useWorkspacesStore.getState()
    expect(state.workspaces).toHaveLength(2)
    const added = state.workspaces.find((w) => w.id !== 'seed')
    expect(added?.customName).toBe('db')
    expect(state.activeWorkspaceId).toBe(added?.id)
  })

  it('SSH-C79 the human picks a host from the New workspace menu and gets a workspace that is just that ssh session', async () => {
    seedWorkspace()
    window.ostia.extensions.invoke = vi.fn(
      async (_ext: string, _command: string, ctx: { workspaceId: string | null }) => {
        const paneId = openExtensionTerminal({
          requestId: 'ssh-db',
          workspaceId: ctx.workspaceId ?? undefined,
          command: 'ssh -t -- db',
          title: 'db',
        })
        return paneId ? { ok: true, data: { paneId } } : { ok: false, error: 'not-opened' }
      },
    ) as typeof window.ostia.extensions.invoke

    expect(await openSshWorkspace('db')).toBe(true)

    const state = useWorkspacesStore.getState()
    const added = state.workspaces.filter((w) => w.id !== 'seed')
    expect(added.map((w) => w.customName)).toEqual(['db'])
    expect(state.activeWorkspaceId).toBe(added[0].id)
    expect(useLayoutStore.getState().byWorkspace[added[0].id].root).toMatchObject({
      type: 'pane',
      kind: 'terminal',
      title: 'db',
    })
  })
})
