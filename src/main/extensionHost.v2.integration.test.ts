import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtensionCaller, PaneChip, WorkspaceChip } from '../shared/extensions'
import type { CommandResult, CommandTarget } from '../shared/types'
import { registerAttentionMethods } from './attention'
import { registerBrowseMethods } from './browse'
import { registerControlServer, stopControlServer } from './controlServer'
import { ExtensionHost, registerExtensionMethods } from './extensionHost'
import { ExtensionStore } from './extensionStore'
import { registerExtension, registerPane } from './idRegistry'

const fixtures = resolve(__dirname, '../../test/fixtures/extensions')

const caller: ExtensionCaller = { kind: 'user', workspaceId: 's1', capabilities: [] }

async function untilAsync<T>(read: () => Promise<T | undefined>, timeoutMs = 5000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('Extension API v2 over a real control socket with the echo fixture', () => {
  let dir: string
  let host: ExtensionHost
  let store: ExtensionStore
  let stored: unknown = {}
  const broadcasts: { channel: string; payload: unknown }[] = []
  const openPanelIn = vi.fn()
  const notify = vi.fn()
  const notifyPanel = vi.fn()
  const execCommand = vi.fn(
    async (_target: CommandTarget, _id: string, _args?: unknown) =>
      ({ ok: true, result: null }) as CommandResult,
  )
  const pane = registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'p1' })
  const other = registerPane({ windowId: 'w1', workspaceId: 's2', paneId: 'p2' })

  const openWorkspaces = new Set<string>()
  const publishedWorkspaceChips: WorkspaceChip[][] = []
  const lastWorkspaceChips = (): WorkspaceChip[] => publishedWorkspaceChips.at(-1) ?? []
  const chipBroadcast = (): PaneChip[] =>
    (broadcasts.filter((b) => b.channel === 'extensions:chips').at(-1)?.payload ?? []) as PaneChip[]
  const call = (method: string, params?: unknown) =>
    host.invoke('echo', 'call', { method, params }, caller)
  const echo = () => {
    const info = host.list().find((e) => e.id === 'echo')
    if (!info) throw new Error('echo missing')
    return info
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'pine-ext-v2-'))
    const socketPath = join(dir, 'control.sock')
    store = new ExtensionStore(join(dir, 'extensions.json'))
    host = new ExtensionHost({
      roots: [{ dir: fixtures, builtin: true }],
      store,
      socketPath: () => socketPath,
      nodePath: process.execPath,
      workDirForWorkspace: (id) => (id && openWorkspaces.has(id) ? '/w' : undefined),
      readExtensionSettings: () => stored,
      broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
      publishWorkspaceChips: (chips) => publishedWorkspaceChips.push(chips),
      openPanelIn,
      notify,
      notifyPanel,
      restartDelayMs: 20,
      readyTimeoutMs: 8000,
      requestTimeoutMs: 4000,
      log: () => {},
    })
    registerExtensionMethods(() => host)
    registerAttentionMethods({ execCommand })
    registerBrowseMethods({
      browserPanes: new Map(),
      isSharedPane: () => false,
      execCommand,
      screenshotRoots: [dir],
      consoleBuffers: new Map(),
      errorBuffers: new Map(),
    })
    registerControlServer(
      { execCommand, listCommandsFor: () => [], getTerminalState: () => undefined },
      socketPath,
    )
  })

  afterAll(() => {
    host.stopAll()
    stopControlServer()
    rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(() => {
    openPanelIn.mockClear()
    notify.mockClear()
    notifyPanel.mockClear()
    execCommand.mockClear()
  })

  describe('pane chips', () => {
    it('shows a chip on the renderer pane its external id names', async () => {
      const res = await host.invoke(
        'echo',
        'chip',
        {
          paneId: pane.externalId,
          id: 'status',
          text: '  main  ',
          tooltip: 'branch',
          tone: 'ok',
          command: 'echo',
        },
        caller,
      )
      expect(res).toEqual({ ok: true })
      const chip = { extId: 'echo', id: 'status', paneId: 'p1', text: 'main', tone: 'ok' }
      expect(chipBroadcast()).toEqual([{ ...chip, tooltip: 'branch', command: 'echo' }])
      expect(host.paneChips()).toEqual(chipBroadcast())
      expect(echo().paneChips).toEqual([{ id: 'status', title: 'Echo status' }])
    })

    it('replaces the value of the same chip instead of adding a second one', async () => {
      await host.invoke(
        'echo',
        'chip',
        { paneId: pane.externalId, id: 'status', text: 'a' },
        caller,
      )
      await host.invoke(
        'echo',
        'chip',
        { paneId: pane.externalId, id: 'status', text: 'b' },
        caller,
      )
      expect(host.paneChips()).toEqual([
        { extId: 'echo', id: 'status', paneId: 'p1', text: 'b', tone: 'neutral' },
      ])
    })

    it('refuses undeclared chips, non-panes and commands that are not palette commands', async () => {
      const undeclared = await host.invoke(
        'echo',
        'chip',
        { paneId: pane.externalId, id: 'other', text: 'x' },
        caller,
      )
      const extIdentity = registerExtension('someone-else')
      const notPane = await host.invoke(
        'echo',
        'chip',
        { paneId: extIdentity.externalId, id: 'status', text: 'x' },
        caller,
      )
      const unknown = await host.invoke(
        'echo',
        'chip',
        { paneId: 'nope', id: 'status', text: 'x' },
        caller,
      )
      const hidden = await host.invoke(
        'echo',
        'chip',
        { paneId: other.externalId, id: 'status', text: 'x', command: 'probe' },
        caller,
      )
      expect(undeclared).toMatchObject({ ok: false, error: 'not-contributed' })
      expect(notPane).toMatchObject({ ok: false, error: 'unknown-pane' })
      expect(unknown).toMatchObject({ ok: false, error: 'unknown-pane' })
      expect(hidden).toMatchObject({ ok: false, error: 'invalid-params' })
      expect(host.paneChips().some((c) => c.paneId === 'p2')).toBe(false)
    })

    it('clears a chip on request and when its pane closes', async () => {
      await host.invoke(
        'echo',
        'chip',
        { paneId: other.externalId, id: 'status', text: 'x' },
        caller,
      )
      expect(host.paneChips().map((c) => c.paneId)).toEqual(['p1', 'p2'])
      await host.invoke('echo', 'unchip', { paneId: pane.externalId, id: 'status' }, caller)
      expect(chipBroadcast().map((c) => c.paneId)).toEqual(['p2'])
      host.clearPaneChips('p2')
      expect(chipBroadcast()).toEqual([])
    })

    it('clears every chip of an extension when it stops', async () => {
      await host.invoke(
        'echo',
        'chip',
        { paneId: pane.externalId, id: 'status', text: 'x' },
        caller,
      )
      expect(host.paneChips()).toHaveLength(1)
      host.setEnabled('echo', false)
      expect(chipBroadcast()).toEqual([])
      host.setEnabled('echo', true)
      expect(await host.invoke('echo', 'echo', null, caller)).toMatchObject({ ok: true })
    })

    it('keeps an http(s) url on a chip and refuses other schemes or a url with a command', async () => {
      const res = await host.invoke(
        'echo',
        'chip',
        { paneId: pane.externalId, id: 'status', text: ':3000', url: 'http://localhost:3000/' },
        caller,
      )
      expect(res).toEqual({ ok: true })
      expect(host.paneChips()).toEqual([
        {
          extId: 'echo',
          id: 'status',
          paneId: 'p1',
          text: ':3000',
          tone: 'neutral',
          url: 'http://localhost:3000/',
        },
      ])
      const file = await host.invoke(
        'echo',
        'chip',
        { paneId: pane.externalId, id: 'status', text: 'x', url: 'file:///etc/passwd' },
        caller,
      )
      const both = await host.invoke(
        'echo',
        'chip',
        { paneId: pane.externalId, id: 'status', text: 'x', url: 'http://a/', command: 'echo' },
        caller,
      )
      expect(file).toMatchObject({ ok: false, error: 'invalid-params' })
      expect(both).toMatchObject({ ok: false, error: 'invalid-params' })
      expect(host.paneChips()[0]?.text).toBe(':3000')
      await host.invoke('echo', 'unchip', { paneId: pane.externalId, id: 'status' }, caller)
    })
  })

  describe('workspace chips', () => {
    const setChip = (params: Record<string, unknown>) =>
      call('ext.setWorkspaceChip', { workspaceId: 's1', id: 'repo', text: 'main', ...params })

    it('publishes a declared chip for an open workspace, validated like a pane chip', async () => {
      openWorkspaces.add('s1')
      expect(await setChip({ tone: 'ok', command: 'echo' })).toEqual({
        ok: true,
        data: { ok: true },
      })
      const chip = {
        extId: 'echo',
        id: 'repo',
        workspaceId: 's1',
        text: 'main',
        tone: 'ok',
        command: 'echo',
      }
      expect(lastWorkspaceChips()).toEqual([chip])
      expect(host.workspaceChips()).toEqual([chip])
      expect(echo().workspaceChips).toEqual([{ id: 'repo', title: 'Echo repo' }])
      await call('ext.clearWorkspaceChip', { workspaceId: 's1', id: 'repo' })
      expect(lastWorkspaceChips()).toEqual([])
    })

    it('refuses an unknown workspace, an undeclared chip and a bad url or icon', async () => {
      openWorkspaces.add('s1')
      const refused = async (params: Record<string, unknown>, error: string) =>
        expect((await setChip(params)) as { data: unknown }).toMatchObject({
          data: { ok: false, error },
        })
      await refused({ workspaceId: 'nope' }, 'unknown-workspace')
      await refused({ workspaceId: '' }, 'unknown-workspace')
      await refused({ id: 'status' }, 'not-contributed')
      await refused({ url: 'file:///etc/passwd' }, 'invalid-params')
      await refused({ icon: 'rocket' }, 'invalid-params')
      await refused({ command: 'probe' }, 'invalid-params')
      expect(host.workspaceChips()).toEqual([])
    })

    it('clears a workspace chip when its workspace closes or the extension stops', async () => {
      openWorkspaces.add('s1')
      openWorkspaces.add('s2')
      await setChip({})
      await setChip({ workspaceId: 's2', text: 'dev' })
      expect(host.workspaceChips().map((c) => c.workspaceId)).toEqual(['s1', 's2'])
      host.clearWorkspaceChips('s1')
      expect(lastWorkspaceChips().map((c) => c.workspaceId)).toEqual(['s2'])
      host.setEnabled('echo', false)
      expect(lastWorkspaceChips()).toEqual([])
      host.setEnabled('echo', true)
      expect(await host.invoke('echo', 'echo', null, caller)).toMatchObject({ ok: true })
    })
  })

  describe('icon chips with items', () => {
    it('keeps an allowed icon and a list of http(s) items', async () => {
      const res = await host.invoke(
        'echo',
        'chip',
        {
          paneId: pane.externalId,
          id: 'status',
          text: '2',
          icon: 'plugs',
          items: [{ text: ':3000', url: 'http://localhost:3000/' }, { text: 'idle' }],
        },
        caller,
      )
      expect(res).toEqual({ ok: true })
      expect(host.paneChips()[0]).toMatchObject({
        icon: 'plugs',
        text: '2',
        items: [{ text: ':3000', url: 'http://localhost:3000/' }, { text: 'idle' }],
      })
      await host.invoke('echo', 'unchip', { paneId: pane.externalId, id: 'status' }, caller)
    })

    it('refuses an unknown icon, bad items, and items next to a url or command', async () => {
      const set = (extra: Record<string, unknown>) =>
        host.invoke(
          'echo',
          'chip',
          { paneId: pane.externalId, id: 'status', text: 'x', ...extra },
          caller,
        )
      const tooMany = Array.from({ length: 21 }, (_, i) => ({ text: `:${3000 + i}` }))
      for (const extra of [
        { icon: 'rocket' },
        { items: [] },
        { items: tooMany },
        { items: [{ text: '' }] },
        { items: [{ text: 'a', url: 'file:///etc/passwd' }] },
        { items: [{ text: 'a' }], url: 'http://a/' },
        { items: [{ text: 'a' }], command: 'echo' },
      ]) {
        expect(await set(extra)).toMatchObject({ ok: false, error: 'invalid-params' })
      }
      expect(host.paneChips()).toEqual([])
    })
  })

  describe('palette arguments', () => {
    it('lists the argument label of a command that asks for one', () => {
      expect(echo().commands.find((c) => c.id === 'echo')?.argument).toBe('What to echo')
    })

    it('passes the typed value as the only argv entry, trimmed', () => {
      expect(host.paletteArgs('echo', 'echo', '  SHOP-12 ')).toEqual({ argv: ['SHOP-12'] })
    })

    it('passes nothing for a command without an argument, or a value that is not plain text', () => {
      expect(host.paletteArgs('echo', 'guarded', 'x')).toBeNull()
      expect(host.paletteArgs('echo', 'echo', '')).toBeNull()
      expect(host.paletteArgs('echo', 'echo', 'a\nb')).toBeNull()
      expect(host.paletteArgs('echo', 'echo', 42)).toBeNull()
      expect(host.paletteArgs('echo', 'echo', 'x'.repeat(1001))).toBeNull()
    })
  })

  describe('settings', () => {
    it('gives the extension its defaults when nothing is stored', async () => {
      const res = await host.invoke('echo', 'settings', null, caller)
      expect(res).toEqual({
        ok: true,
        data: { ok: true, values: { greeting: 'hi', count: 3, loud: false, level: 'low' } },
      })
      expect(echo().settings.map((s) => s.key)).toEqual(['greeting', 'count', 'loud', 'level'])
    })

    it('validates a change in main, stores it and tells the running extension', async () => {
      await host.invoke('echo', 'echo', null, caller)
      const res = host.setSetting('echo', 'level', 'high')
      expect(res).toMatchObject({ ok: true, stored: { level: 'high' } })
      const event = await untilAsync(async () => {
        const seen = await host.invoke('echo', 'seen-settings', null, caller)
        return seen.ok && seen.data ? seen.data : undefined
      })
      expect(event).toEqual({ greeting: 'hi', count: 3, loud: false, level: 'high' })
      expect(echo().settingValues.level).toBe('high')
    })

    it('refuses a value of the wrong type or outside the enum and keeps the old one', () => {
      expect(host.setSetting('echo', 'count', '4')).toEqual({ ok: false, error: 'invalid-value' })
      expect(host.setSetting('echo', 'level', 'max')).toEqual({ ok: false, error: 'invalid-value' })
      expect(host.setSetting('echo', 'count', Number.NaN)).toEqual({
        ok: false,
        error: 'invalid-value',
      })
      expect(host.setSetting('echo', 'nope', 1)).toEqual({ ok: false, error: 'unknown-setting' })
      expect(host.setSetting('ghost', 'count', 1)).toEqual({
        ok: false,
        error: 'unknown-extension',
      })
      expect(echo().settingValues).toMatchObject({ count: 3, level: 'high' })
    })

    it('resets a key to its default when set to null', () => {
      const res = host.setSetting('echo', 'level', null)
      expect(res).toMatchObject({ ok: true, stored: {} })
      expect(echo().settingValues.level).toBe('low')
    })

    it('reloads stored values from settings.json and ignores ones of the wrong type', async () => {
      stored = { echo: { greeting: 'yo', count: 'many', loud: true } }
      host.reloadSettings()
      expect(echo().settingValues).toEqual({ greeting: 'yo', count: 3, loud: true, level: 'low' })
      const res = await host.invoke('echo', 'settings', null, caller)
      expect(res).toMatchObject({ data: { values: { greeting: 'yo', loud: true } } })
      stored = {}
      host.reloadSettings()
    })
  })

  describe('panels with a path', () => {
    it('asks the window to open or navigate the panel at that path', async () => {
      const res = await host.invoke(
        'echo',
        'open-panel',
        { workspaceId: 's1', path: '/cards/7?tab=a' },
        caller,
      )
      expect(res).toEqual({ ok: true })
      expect(openPanelIn).toHaveBeenCalledWith({
        extId: 'echo',
        workspaceId: 's1',
        path: '/cards/7?tab=a',
      })
    })

    it('refuses a path that is not an absolute in-panel path', async () => {
      for (const path of ['cards', '//evil.test/x', '/a b', 'http://127.0.0.1:9/']) {
        const res = await host.invoke('echo', 'open-panel', { path }, caller)
        expect(res).toMatchObject({ ok: false, error: 'invalid-params' })
      }
      expect(openPanelIn).not.toHaveBeenCalled()
    })

    it('makes a notification click open the panel at the given path', async () => {
      const res = await host.invoke('echo', 'notify-panel', { openPanel: '/cards/9' }, caller)
      expect(res).toEqual({ ok: true })
      const [n, open] = notifyPanel.mock.calls[0]
      expect(n).toMatchObject({ title: 'look', extId: 'echo', panelPath: '/cards/9' })
      open()
      expect(openPanelIn).toHaveBeenCalledWith({ extId: 'echo', path: '/cards/9' })
      const bad = await host.invoke('echo', 'notify-panel', { openPanel: 'cards' }, caller)
      expect(bad).toMatchObject({ ok: false, error: 'invalid-params' })
    })

    it('asks the process for the url of a path and keeps it on the reported origin', async () => {
      const res = await host.resolvePanel('echo', {
        workspaceId: 's1',
        locale: 'en',
        path: '/cards/7',
      })
      expect(res).toEqual({ ok: true, src: 'http://127.0.0.1:9/cards/7?workspace=s1' })
      expect(host.isAllowedPanelUrl('echo', 'http://127.0.0.1:9/cards/8')).toBe(true)
      expect(
        await host.resolvePanel('echo', { workspaceId: 's1', locale: 'en', path: 'x' }),
      ).toEqual({ ok: false, error: 'invalid-panel-path' })
    })
  })

  describe('pane-scoped methods with an explicit target', () => {
    it('runs a targetable method as the target pane', async () => {
      const res = await call('pane.setAttention', {
        targetPaneId: pane.externalId,
        state: 'waiting',
        message: 'look',
      })
      expect(res).toEqual({ ok: true, data: { ok: true } })
      expect(execCommand).toHaveBeenCalledWith(
        { windowId: 'w1', workspaceId: 's1', paneId: 'p1' },
        'attention.set',
        { state: 'waiting', message: 'look' },
      )
    })

    it('reaches browse methods in the target pane workspace', async () => {
      const res = await call('browse.read', { targetPaneId: other.externalId })
      expect(res).toEqual({ ok: true, data: { ok: false, error: 'no-browser-pane' } })
    })

    it('refuses a call without a target, or with one that is not a pane', async () => {
      const none = await call('pane.setAttention', { state: 'waiting' })
      const bogus = await call('pane.setAttention', { targetPaneId: 'nope', state: 'waiting' })
      expect(none).toMatchObject({ ok: false, message: expect.stringContaining('needs-target') })
      expect(bogus).toMatchObject({ ok: false, message: expect.stringContaining('unknown-target') })
      expect(execCommand).not.toHaveBeenCalled()
    })

    it('keeps pane-only methods that are not targetable closed to extensions', async () => {
      const res = await call('command.list', { targetPaneId: pane.externalId })
      expect(res).toMatchObject({ ok: false, message: expect.stringContaining('not-available') })
    })

    it('needs all-workspaces and the method capability, both approved by the human', async () => {
      store.set('echo', {
        enabled: true,
        approved: ['read-board', 'notify', 'browse', 'process', 'drive-self'],
      })
      host.reloadRecords()
      const noScope = await call('pane.setAttention', {
        targetPaneId: pane.externalId,
        state: 'done',
      })
      expect(noScope).toMatchObject({ ok: false, message: 'needs-elevation: all-workspaces' })
      store.set('echo', { enabled: true, approved: ['read-board', 'notify', 'all-workspaces'] })
      host.reloadRecords()
      const noCap = await call('pane.setAttention', {
        targetPaneId: pane.externalId,
        state: 'done',
      })
      expect(noCap).toMatchObject({ ok: false, message: 'needs-elevation: drive-self' })
      expect(execCommand).not.toHaveBeenCalled()
    })
  })
})
