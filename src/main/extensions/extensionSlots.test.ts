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

const INBOX_PANEL = {
  title: 'Demo',
  entry: 'url',
  toolbar: { tabs: [{ id: 'inbox', title: 'Inbox', surface: 'inbox' }], actions: [] },
}

function inboxSlots(options: { builtin?: boolean; panel?: unknown; callers?: string[] } = {}) {
  const publishInbox = vi.fn()
  const sendEvent = vi.fn(() => true)
  const host = {
    deps: {
      publishInbox,
      workDirForWorkspace: (id?: string) => (id === 'w1' || id === 'w2' ? '/work' : undefined),
    },
    sendEvent,
    runtimeOf: () =>
      ({
        ext: {
          builtin: options.builtin ?? true,
          manifest: { id: 'demo', contributes: { panel: options.panel ?? INBOX_PANEL } },
        },
        callerWorkspaces: new Set<string>(options.callers ?? ['w1', 'w2']),
      }) as unknown as Runtime,
    commandsOf: (): ExtensionCommandContribution[] => [],
  } as unknown as ExtensionSlotsHost
  const slots = new ExtensionSlots(host)
  const set = (params: unknown) =>
    slots.setInboxItems({} as PaneIdentity, {} as MessageConnection, params)
  return { slots, publishInbox, set, sendEvent }
}

const ITEM = { id: 'abcdefghij', text: 'Set the key', at: 5 }

describe('ExtensionSlots inbox items', () => {
  it('keeps the items per workspace, tells the renderer and answers whether it holds one', () => {
    const { slots, publishInbox, set } = inboxSlots()
    expect(set({ workspaceId: 'w1', items: [ITEM] })).toEqual({ ok: true })
    expect(slots.inboxEntries()).toEqual([{ extId: 'demo', workspaceId: 'w1', items: [ITEM] }])
    expect(publishInbox).toHaveBeenLastCalledWith(slots.inboxEntries())
    expect(slots.holdsInboxItem('demo', 'w1', 'abcdefghij')).toBe(true)
    expect(slots.holdsInboxItem('demo', 'w2', 'abcdefghij')).toBe(false)
    expect(slots.holdsInboxItem('other', 'w1', 'abcdefghij')).toBe(false)
  })

  it('forwards a done action to the extension only for an item it holds in that workspace', () => {
    const { slots, set, sendEvent } = inboxSlots()
    set({ workspaceId: 'w1', items: [ITEM] })
    expect(slots.inboxAction('demo', 'w1', 'abcdefghij')).toBe(true)
    expect(sendEvent).toHaveBeenCalledWith('demo', 'inbox.action', {
      workspaceId: 'w1',
      id: 'abcdefghij',
      action: 'done',
    })
    sendEvent.mockClear()
    expect(slots.inboxAction('demo', 'w2', 'abcdefghij')).toBe(false)
    expect(slots.inboxAction('demo', 'w1', 'bcdefghijk')).toBe(false)
    expect(slots.inboxAction('other', 'w1', 'abcdefghij')).toBe(false)
    expect(sendEvent).not.toHaveBeenCalled()
  })

  it('replaces the list on every call and forgets an empty one', () => {
    const { slots, set } = inboxSlots()
    set({ workspaceId: 'w1', items: [ITEM] })
    set({ workspaceId: 'w1', items: [{ ...ITEM, id: 'bcdefghijk' }] })
    expect(slots.inboxEntries()[0]?.items.map((i) => i.id)).toEqual(['bcdefghijk'])
    set({ workspaceId: 'w1', items: [] })
    expect(slots.inboxEntries()).toEqual([])
  })

  it('collapses the text to one line, cuts it at the limit and drops a pane of another workspace', () => {
    const { slots, set } = inboxSlots()
    set({
      workspaceId: 'w1',
      items: [{ ...ITEM, text: `  a\n\n b ${'x'.repeat(600)}`, paneId: 'not-a-pane' }],
    })
    const item = slots.inboxEntries()[0]?.items[0]
    expect(item?.text.startsWith('a b xxx')).toBe(true)
    expect([...(item?.text ?? '')]).toHaveLength(500)
    expect(item?.paneId).toBeUndefined()
  })

  it('refuses a workspace the extension has no caller in, however it is open', () => {
    const { slots, set } = inboxSlots({ callers: ['w2'] })
    expect(set({ workspaceId: 'w1', items: [ITEM] })).toMatchObject({
      ok: false,
      error: 'no-caller',
    })
    expect(slots.inboxEntries()).toEqual([])
    expect(set({ workspaceId: 'w2', items: [ITEM] })).toEqual({ ok: true })
  })

  it('refuses a caller that is not a built-in extension, a manifest without an inbox tab and a closed workspace', () => {
    expect(inboxSlots({ builtin: false }).set({ workspaceId: 'w1', items: [ITEM] })).toMatchObject({
      ok: false,
      error: 'builtin-only',
    })
    const plain = {
      title: 'Demo',
      entry: 'url',
      toolbar: { tabs: [{ id: 'a', title: 'A' }], actions: [] },
    }
    expect(inboxSlots({ panel: plain }).set({ workspaceId: 'w1', items: [ITEM] })).toMatchObject({
      ok: false,
      error: 'not-contributed',
    })
    expect(inboxSlots().set({ workspaceId: 'w9', items: [ITEM] })).toMatchObject({
      ok: false,
      error: 'unknown-workspace',
    })
  })

  it('refuses malformed items: a bad id, empty text, no time, duplicates and too many', () => {
    const { slots, set } = inboxSlots()
    const bad = (items: unknown) => set({ workspaceId: 'w1', items })
    expect(bad([{ ...ITEM, id: 'short' }])).toMatchObject({ ok: false })
    expect(bad([{ ...ITEM, text: '   ' }])).toMatchObject({ ok: false })
    expect(bad([{ ...ITEM, at: 'now' }])).toMatchObject({ ok: false })
    expect(bad([ITEM, ITEM])).toMatchObject({ ok: false })
    expect(bad('x')).toMatchObject({ ok: false })
    expect(
      bad(
        Array.from({ length: 51 }, (_, i) => ({
          ...ITEM,
          id: `${'a'.repeat(9)}${'abcdefghijklmnopqrstuvwxyz'[i % 26]}`,
        })),
      ),
    ).toMatchObject({ ok: false })
    expect(slots.inboxEntries()).toEqual([])
  })

  it('clears the entries of a closed workspace or a stopped extension', () => {
    const { slots, publishInbox, set } = inboxSlots()
    set({ workspaceId: 'w1', items: [ITEM] })
    set({ workspaceId: 'w2', items: [ITEM] })
    slots.clearInboxWhere((entry) => entry.workspaceId === 'w1')
    expect(slots.inboxEntries().map((e) => e.workspaceId)).toEqual(['w2'])
    slots.clearInboxWhere((entry) => entry.extId === 'demo')
    expect(slots.inboxEntries()).toEqual([])
    expect(publishInbox).toHaveBeenLastCalledWith([])
  })
})

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
