import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ExtensionCaller, ExtensionSidebarItem } from '../shared/extensions'
import type { CommandResult } from '../shared/types'
import { registerControlServer, stopControlServer } from './controlServer'
import { ExtensionHost, MAX_RESTARTS, registerExtensionMethods } from './extensionHost'
import { ExtensionStore } from './extensionStore'
import { registerPaneListMethods } from './paneList'

const fixtures = resolve(__dirname, '../../test/fixtures/extensions')

const caller: ExtensionCaller = {
  kind: 'pane',
  paneId: 'ext-pane',
  sessionId: 's1',
  workDir: '/w/s1',
  capabilities: ['read-board'],
}

async function until<T>(read: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('ExtensionHost over a real control socket with a fixture extension process', () => {
  let dir: string
  let host: ExtensionHost
  const broadcasts: { channel: string; payload: unknown }[] = []
  const notify = vi.fn()
  const openPanelIn = vi.fn()
  const openDiffIn = vi.fn()

  const sidebar = (): ExtensionSidebarItem[] =>
    (broadcasts.filter((b) => b.channel === 'extensions:sidebar').at(-1)?.payload ??
      []) as ExtensionSidebarItem[]
  const status = (): string | undefined => host.list().find((e) => e.id === 'echo')?.status

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'pine-ext-int-'))
    const socketPath = join(dir, 'control.sock')
    host = new ExtensionHost({
      roots: [{ dir: fixtures, builtin: true }],
      store: new ExtensionStore(join(dir, 'extensions.json')),
      socketPath: () => socketPath,
      nodePath: process.execPath,
      workDirForSession: (sid) => (sid ? `/w/${sid}` : undefined),
      broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
      openPanelIn,
      openDiffIn,
      notify,
      restartDelayMs: 20,
      readyTimeoutMs: 8000,
      requestTimeoutMs: 4000,
      log: () => {},
    })
    registerExtensionMethods(() => host)
    registerPaneListMethods({
      execCommand: async (_target, id) =>
        ({
          ok: true,
          result:
            id === 'session.list'
              ? [{ sessionId: 's1', name: 'a', kind: 'terminal', workDir: '/w/s1', state: 'idle' }]
              : [],
        }) as CommandResult,
      getTerminalState: () => undefined,
    })
    registerControlServer(
      {
        execCommand: async () => ({ ok: true, result: null }) as CommandResult,
        listCommandsFor: () => [],
        getTerminalState: () => undefined,
      },
      socketPath,
    )
  })

  afterAll(() => {
    host.stopAll()
    stopControlServer()
    rmSync(dir, { recursive: true, force: true })
  })

  it('lazy-starts on first invoke, routes the command, and returns the result', async () => {
    expect(status()).toBe('idle')
    const res = await host.invoke('echo', 'echo', { argv: ['a', 'b'] }, caller)
    expect(res).toMatchObject({
      ok: true,
      text: 'echoed',
      data: { args: { argv: ['a', 'b'] }, caller },
    })
    expect(status()).toBe('running')
  })

  it('never lets the extension identity call pane-only control methods', async () => {
    const res = await host.invoke('echo', 'probe', null, caller)
    expect(res).toMatchObject({ ok: false, error: 'rejected' })
    expect(res.ok === false && res.message).toContain('not-available-to-extension')
  })

  it('delivers subscribed events as notifications and ignores unsubscribed ones', async () => {
    host.emitEvent('pane.closed', { paneId: 'p-closed', sessionId: 's1' })
    host.emitEvent('pane.created', { paneId: 'p-new', sessionId: 's1' })
    const item = await until(() => sidebar().find((i) => i.key === 'pane.created'))
    expect(item).toEqual({
      extId: 'echo',
      key: 'pane.created',
      text: 'pane.created:p-new',
      tone: 'neutral',
    })
    expect(sidebar().some((i) => i.key === 'pane.closed')).toBe(false)
  })

  it('routes ext.notify through the notification sink, tagged with the extension', async () => {
    const res = await host.invoke('echo', 'notify', null, caller)
    expect(res.ok).toBe(true)
    expect(notify).toHaveBeenCalledWith({ title: 'from echo', body: 'hi', from: 'extension:echo' })
  })

  it('lets an extension list sessions (read-board) through the shared session.list method', async () => {
    const res = await host.invoke('echo', 'sessions', null, caller)
    expect(res).toMatchObject({
      ok: true,
      data: [{ sessionId: 's1', workDir: '/w/s1' }],
    })
  })

  it('forwards a valid ext.openDiff to the window, tagged with the extension', async () => {
    const res = await host.invoke(
      'echo',
      'diff',
      { sessionId: 's1', title: 'a.ts', original: 'a', modified: 'b', path: '/r/a.ts' },
      caller,
    )
    expect(res).toEqual({ ok: true })
    expect(openDiffIn).toHaveBeenCalledWith({
      extId: 'echo',
      sessionId: 's1',
      title: 'a.ts',
      original: 'a',
      modified: 'b',
      path: '/r/a.ts',
    })
  })

  it('rejects an openDiff with a relative path, missing sides, or no title', async () => {
    openDiffIn.mockClear()
    const rel = await host.invoke(
      'echo',
      'diff',
      { title: 'a', original: '', modified: '', path: 'a.ts' },
      caller,
    )
    const sides = await host.invoke('echo', 'diff', { title: 'a', original: 'x' }, caller)
    const untitled = await host.invoke('echo', 'diff', { original: '', modified: '' }, caller)
    expect(rel).toMatchObject({ ok: false, error: 'invalid-params' })
    expect(sides).toMatchObject({ ok: false, error: 'invalid-params' })
    expect(untitled).toMatchObject({ ok: false, error: 'missing-title' })
    expect(openDiffIn).not.toHaveBeenCalled()
  })

  it('resolves a url panel from the process and allows only that loopback origin', async () => {
    const res = await host.resolvePanel('echo', { sessionId: 's9', locale: 'en' })
    expect(res).toEqual({ ok: true, src: 'http://127.0.0.1:9/?session=s9' })
    expect(host.isAllowedPanelUrl('echo', 'http://127.0.0.1:9/other')).toBe(true)
    expect(host.isAllowedPanelUrl('echo', 'http://127.0.0.1:10/')).toBe(false)
  })

  it('restarts a crashed process and keeps serving commands', async () => {
    const before = await host.invoke('echo', 'echo', null, caller)
    const pidBefore = before.ok ? (before.data as { pid: number }).pid : 0
    const crashed = await host.invoke('echo', 'crash', null, caller)
    expect(crashed).toMatchObject({ ok: false, error: 'extension-unavailable' })
    expect(sidebar()).toEqual([])
    const after = await host.invoke('echo', 'echo', null, caller)
    expect(after.ok).toBe(true)
    expect(after.ok && (after.data as { pid: number }).pid).not.toBe(pidBefore)
    expect(status()).toBe('running')
  })

  it(`gives up after ${MAX_RESTARTS} restarts and reports the extension as crashed`, async () => {
    for (let i = 0; i < MAX_RESTARTS; i++) {
      await host.invoke('echo', 'crash', null, caller)
      if (status() === 'crashed') break
    }
    await until(() => (status() === 'crashed' ? true : undefined))
    expect(await host.invoke('echo', 'echo', null, caller)).toMatchObject({
      ok: false,
      error: 'extension-unavailable',
      message: 'extension crashed',
    })
  })

  it('re-enabling resets the crash budget; disabling stops it and blocks commands', async () => {
    host.setEnabled('echo', false)
    host.setEnabled('echo', true)
    expect((await host.invoke('echo', 'echo', null, caller)).ok).toBe(true)
    host.setEnabled('echo', false)
    await until(() => (status() === 'disabled' ? true : undefined))
    expect(await host.invoke('echo', 'echo', null, caller)).toMatchObject({
      ok: false,
      error: 'extension-disabled',
    })
  })
})
