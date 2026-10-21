import type { ExtensionCommandContribution } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { describe, expect, it, vi } from 'vitest'
import type { MessageConnection } from 'vscode-jsonrpc/node'
import type { PaneIdentity } from '../control/idRegistry'
import type { Runtime } from './extensionRuntime'
import { ExtensionSlots, type ExtensionSlotsHost } from './extensionSlots'

function runtimeWith(panel: unknown, callers: string[]): Runtime {
  return {
    ext: { manifest: { id: 'demo', contributes: { panel } } },
    callerWorkspaces: new Set(callers),
  } as unknown as Runtime
}

const TOOLBAR = {
  title: 'Demo',
  entry: 'url',
  toolbar: {
    tabs: [
      { id: 'board', title: 'Board' },
      { id: 'vault', title: 'Vault' },
    ],
    actions: [{ id: 'refresh', icon: 'refresh', title: 'Refresh' }],
  },
}

function slotsFor(panel: unknown, callers = ['w1', 'w2', 'w3']) {
  const open = new Set([...callers, 'w4'])
  const broadcast = vi.fn()
  const host = {
    deps: {
      broadcast,
      workDirForWorkspace: (id?: string) => (id && open.has(id) ? '/work' : undefined),
    },
    runtimeOf: () => runtimeWith(panel, callers),
    commandsOf: (): ExtensionCommandContribution[] => [],
  } as unknown as ExtensionSlotsHost
  const slots = new ExtensionSlots(host)
  const set = (params: unknown) =>
    slots.setPanelToolbar({} as PaneIdentity, {} as MessageConnection, params)
  return { slots, broadcast, set }
}

describe('ExtensionSlots panel toolbar', () => {
  it('stores the state per workspace and tells the renderer', () => {
    const { slots, broadcast, set } = slotsFor(TOOLBAR)
    expect(
      set({ workspaceId: 'w1', tab: 'vault', badges: { vault: 2 }, disabled: ['refresh'] }),
    ).toEqual({
      ok: true,
    })
    expect(slots.panelToolbarEntries()).toEqual([
      {
        extId: 'demo',
        workspaceId: 'w1',
        state: { tab: 'vault', badges: { vault: 2 }, disabled: ['refresh'] },
      },
    ])
    expect(broadcast).toHaveBeenLastCalledWith(
      'extensions:panel-toolbar',
      slots.panelToolbarEntries(),
    )
  })

  it('replaces the whole state on every call and forgets an empty one', () => {
    const { slots, set } = slotsFor(TOOLBAR)
    set({ workspaceId: 'w1', tab: 'vault' })
    set({ workspaceId: 'w1', back: 'ACME-41' })
    expect(slots.panelToolbarEntries()[0]?.state).toEqual({ back: 'ACME-41' })
    set({ workspaceId: 'w1' })
    expect(slots.panelToolbarEntries()).toEqual([])
  })

  it('refuses ids the manifest does not declare, bad badges and a missing workspace', () => {
    const { slots, set } = slotsFor(TOOLBAR)
    expect(set({ workspaceId: 'w1', tab: 'nope' })).toMatchObject({ ok: false })
    expect(set({ workspaceId: 'w1', hidden: ['nope'] })).toMatchObject({ ok: false })
    expect(set({ workspaceId: 'w1', badges: { vault: 0 } })).toMatchObject({ ok: false })
    expect(set({ workspaceId: 'w1', badges: { vault: 1.5 } })).toMatchObject({ ok: false })
    expect(set({ workspaceId: 'w1', back: '  ' })).toMatchObject({ ok: false })
    expect(set({ tab: 'board' })).toMatchObject({ ok: false })
    expect(slots.panelToolbarEntries()).toEqual([])
  })

  it('refuses a workspace that is not open or has no caller of the extension, and a null badge map', () => {
    const { slots, set } = slotsFor(TOOLBAR)
    expect(set({ workspaceId: 'gone', tab: 'board' })).toMatchObject({
      ok: false,
      error: 'unknown-workspace',
    })
    expect(set({ workspaceId: 'w4', tab: 'board' })).toMatchObject({
      ok: false,
      error: 'no-caller',
    })
    expect(set({ workspaceId: 'w1', badges: null })).toMatchObject({
      ok: false,
      error: 'invalid-params',
    })
    expect(slots.panelToolbarEntries()).toEqual([])
  })

  it('bounds the entries one extension can keep', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `x${i}`)
    const { slots, set } = slotsFor(TOOLBAR, ids)
    const replies = ids.map((workspaceId) => set({ workspaceId, tab: 'board' }))
    expect(slots.panelToolbarEntries()).toHaveLength(32)
    expect(replies.filter((r) => 'error' in r && r.error === 'too-many-items')).toHaveLength(8)
  })

  it('refuses an extension without a panel', () => {
    const { set } = slotsFor(undefined)
    expect(set({ workspaceId: 'w1', tab: 'board' })).toMatchObject({
      ok: false,
      error: 'not-contributed',
    })
  })

  it('clears the entries of a closed workspace or a stopped extension', () => {
    const { slots, broadcast, set } = slotsFor(TOOLBAR)
    set({ workspaceId: 'w1', tab: 'board' })
    set({ workspaceId: 'w2', tab: 'vault' })
    slots.clearPanelToolbarsWhere((entry) => entry.workspaceId === 'w1')
    expect(slots.panelToolbarEntries().map((e) => e.workspaceId)).toEqual(['w2'])
    slots.clearPanelToolbarsWhere((entry) => entry.extId === 'demo')
    expect(slots.panelToolbarEntries()).toEqual([])
    expect(broadcast).toHaveBeenLastCalledWith('extensions:panel-toolbar', [])
  })
})
