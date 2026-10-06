import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AssistModelSettings } from '../shared/assist'
import type { ExtensionCaller, ExtensionSidebarItem } from '../shared/extensions'
import type { CommandResult } from '../shared/types'
import { registerControlServer, stopControlServer } from './controlServer'
import { ExtensionHost, registerExtensionMethods } from './extensionHost'
import { ExtensionStore } from './extensionStore'

const echoFixtures = resolve(__dirname, '../../test/fixtures/extensions')
const assistFixtures = resolve(__dirname, '../../test/fixtures/extensions-assist-models')

const caller: ExtensionCaller = {
  kind: 'pane',
  paneId: 'ext-pane',
  workspaceId: 's1',
  workDir: '/w/s1',
  capabilities: ['read-board'],
}

async function until<T>(read: () => T | undefined, timeoutMs = 8000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('built-in extensions that start on demand', () => {
  let dir: string
  let host: ExtensionHost
  let settings: Partial<AssistModelSettings> = { providers: [] }
  const broadcasts: { channel: string; payload: unknown }[] = []

  const sidebar = (): ExtensionSidebarItem[] =>
    (broadcasts.filter((b) => b.channel === 'extensions:sidebar').at(-1)?.payload ??
      []) as ExtensionSidebarItem[]
  const status = (id: string): string | undefined => host.list().find((e) => e.id === id)?.status
  const coreItem = (): ExtensionSidebarItem | undefined =>
    sidebar().find((i) => i.extId === 'echo' && i.key === 'branch')
  const coreChip = () =>
    host.workspaceChips().find((c) => c.extId === 'echo' && c.id === 'repo' && c.text === 'core')

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ostia-ext-on-demand-'))
    const socketPath = join(dir, 'control.sock')
    host = new ExtensionHost({
      roots: [
        { dir: echoFixtures, builtin: true },
        { dir: assistFixtures, builtin: true },
      ],
      store: new ExtensionStore(join(dir, 'extensions.json')),
      socketPath: () => socketPath,
      nodePath: process.execPath,
      workDirForWorkspace: (sid) => (sid ? `/w/${sid}` : undefined),
      broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
      openPanelIn: () => {},
      notify: () => {},
      readAssistSettings: () => ({ assistant: settings }),
      restartDelayMs: 20,
      readyTimeoutMs: 8000,
      requestTimeoutMs: 4000,
      log: () => {},
      startOnDemand: ['echo', 'switchboard'],
    })
    registerExtensionMethods(() => host)
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

  it('does not start them with the window although they contribute window items or assist', async () => {
    host.startEager()
    await new Promise((r) => setTimeout(r, 300))
    expect(host.isRunning('echo')).toBe(false)
    expect(host.isRunning('switchboard')).toBe(false)
    expect(status('echo')).toBe('idle')
    expect(status('switchboard')).toBe('idle')
  })

  it('lets core show their sidebar item and workspace chip while no process runs', () => {
    expect(
      host.publishSidebarItem('echo', {
        workspaceId: 's1',
        key: 'branch',
        text: 'main',
        icon: 'git-branch',
        kind: 'location',
      }),
    ).toEqual({ ok: true })
    expect(
      host.publishWorkspaceChip('echo', { workspaceId: 's1', id: 'repo', text: 'core' }),
    ).toEqual({ ok: true })
    expect(coreItem()).toMatchObject({ text: 'main', workspaceId: 's1', kind: 'location' })
    expect(coreChip()).toBeDefined()
    expect(
      host.publishWorkspaceChip('echo', { workspaceId: 's1', id: 'nope', text: 'x' }),
    ).toMatchObject({ ok: false, error: 'not-contributed' })
    expect(host.isRunning('echo')).toBe(false)
  })

  it('starts on the first command, and its exit keeps what core published', async () => {
    const pid = (res: Awaited<ReturnType<ExtensionHost['invoke']>>): number =>
      res.ok ? (res.data as { pid: number }).pid : 0
    const first = await host.invoke('echo', 'echo', null, caller)
    expect(first.ok).toBe(true)
    expect(host.isRunning('echo')).toBe(true)
    await host.invoke('echo', 'crash', null, caller)
    const again = await host.invoke('echo', 'echo', null, caller)
    expect(again.ok).toBe(true)
    expect(pid(again)).not.toBe(pid(first))
    expect(coreItem()?.text).toBe('main')
    expect(coreChip()).toBeDefined()
  })

  it('clears what core published when disabled, refuses more, and stays down when re-enabled', async () => {
    host.setEnabled('echo', false)
    expect(coreItem()).toBeUndefined()
    expect(coreChip()).toBeUndefined()
    expect(
      host.publishSidebarItem('echo', { workspaceId: 's1', key: 'branch', text: 'x' }),
    ).toMatchObject({ ok: false, error: 'extension-disabled' })
    await until(() => (host.isRunning('echo') ? undefined : true))
    host.setEnabled('echo', true)
    await new Promise((r) => setTimeout(r, 200))
    expect(host.isRunning('echo')).toBe(false)
    expect(
      host.publishSidebarItem('echo', { workspaceId: 's1', key: 'branch', text: 'b' }),
    ).toEqual({
      ok: true,
    })
    expect(coreItem()?.text).toBe('b')
  })

  it('wakes an assist extension when its UI asks for it', async () => {
    expect(host.isRunning('switchboard')).toBe(false)
    host.wakeAssist()
    await until(() => (status('switchboard') === 'running' ? true : undefined))
  })

  it('starts an assist extension with the window once it has a provider to serve', async () => {
    host.setEnabled('switchboard', false)
    await until(() => (host.isRunning('switchboard') ? undefined : true))
    host.setEnabled('switchboard', true)
    await new Promise((r) => setTimeout(r, 200))
    expect(host.isRunning('switchboard')).toBe(false)
    settings = {
      providers: [
        {
          id: 'local',
          extId: 'switchboard',
          kind: 'plain',
          name: 'Local',
          baseUrl: '',
          enabled: true,
          models: ['small'],
        },
      ],
    }
    host.reloadAssistSettings()
    await until(() => (status('switchboard') === 'running' ? true : undefined))
  })
})
