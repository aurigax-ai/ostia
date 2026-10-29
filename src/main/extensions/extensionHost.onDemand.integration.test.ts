import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AssistModelSettings } from '@aurigax-ai/ostia-extension-sdk/contract/assist'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CommandResult } from '../../shared/control/commands'
import { registerControlServer, stopControlServer } from '../control/controlServer'
import { ExtensionHost } from './extensionHost'
import { ExtensionLaunches } from './extensionLaunches'
import { registerExtensionMethods } from './extensionMethods'
import { ExtensionStore } from './extensionStore'

const POLL = { timeout: 8000, interval: 20 }

const echoFixtures = resolve(__dirname, '../../../test/fixtures/extensions')
const assistFixtures = resolve(__dirname, '../../../test/fixtures/extensions-assist-models')
const builtinExtensions = resolve(__dirname, '../../../out/extensions')

describe('a built-in assist extension starts on demand', () => {
  let dir: string
  let host: ExtensionHost
  let settings: Partial<AssistModelSettings> = { providers: [] }
  const broadcasts: { channel: string; payload: unknown }[] = []

  const status = (id: string): string | undefined => host.list().find((e) => e.id === id)?.status

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ostia-ext-on-demand-'))
    const socketPath = join(dir, 'control.sock')
    host = new ExtensionHost({
      sandboxDomains: () => null,
      isSandboxed: () => false,
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
    })
    registerExtensionMethods(() => host)
    registerControlServer(
      {
        execCommand: async () => ({ ok: true, result: null }) as CommandResult,
        listCommandsFor: () => [],
        getTerminalState: () => undefined,
        isSandboxed: () => false,
      },
      socketPath,
    )
  })

  afterAll(() => {
    host.processes.stopAll()
    stopControlServer()
    rmSync(dir, { recursive: true, force: true })
  })

  it('does not start a built-in assist extension with the window while it has no provider', async () => {
    host.processes.startEager()
    await new Promise((r) => setTimeout(r, 300))
    expect(host.processes.isRunning('switchboard')).toBe(false)
    expect(status('switchboard')).toBe('idle')
  })

  it('starts a built-in extension with window items with the window', async () => {
    await vi.waitUntil(() => status('echo') === 'running', POLL)
  })

  it('wakes an assist extension when its UI asks for it', async () => {
    expect(host.processes.isRunning('switchboard')).toBe(false)
    host.assistant.wakeAssist()
    await vi.waitUntil(() => status('switchboard') === 'running', POLL)
  })

  it('starts an assist extension with the window once it has a provider to serve', async () => {
    host.processes.setEnabled('switchboard', false)
    await vi.waitUntil(() => !host.processes.isRunning('switchboard'), POLL)
    host.processes.setEnabled('switchboard', true)
    await new Promise((r) => setTimeout(r, 200))
    expect(host.processes.isRunning('switchboard')).toBe(false)
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
    host.assistant.reloadAssistSettings()
    await vi.waitUntil(() => status('switchboard') === 'running', POLL)
  })

  it('runs a command asked for while the extension is still exiting, once the old process is gone', async () => {
    await vi.waitUntil(() => status('echo') === 'running', POLL)
    host.processes.stopAll()
    expect(host.processes.isRunning('echo')).toBe(true)
    const caller = { kind: 'user' as const, capabilities: [] }
    expect(await host.invoke('echo', 'echo', { argv: ['again'] }, caller)).toMatchObject({
      ok: true,
    })
  })
})

describe('the real built-in extensions', () => {
  it('start only ssh with the window, for its remote Online or Offline row, so the branch, the diff stats and the Git panel run without a host', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ostia-ext-builtins-'))
    const host = new ExtensionHost({
      sandboxDomains: () => null,
      isSandboxed: () => false,
      roots: [{ dir: builtinExtensions, builtin: true }],
      store: new ExtensionStore(join(dir, 'extensions.json')),
      launches: new ExtensionLaunches(join(dir, 'extension-launches.json')),
      socketPath: () => join(dir, 'control.sock'),
      nodePath: process.execPath,
      dataDir: join(dir, 'extension-data'),
      workDirForWorkspace: () => undefined,
      broadcast: () => {},
      openPanelIn: () => {},
      notify: () => {},
      readAssistSettings: () => ({ assistant: { providers: [] } }),
      log: () => {},
    })
    try {
      expect(host.list().map((e) => e.id)).toEqual(
        expect.arrayContaining(['activity', 'assistant', 'graphs', 'ssh', 'system']),
      )
      host.processes.startEager()
      await new Promise((r) => setTimeout(r, 300))
      expect(
        host
          .list()
          .filter((e) => e.status !== 'idle')
          .map((e) => e.id),
      ).toEqual(['ssh'])
    } finally {
      host.processes.stopAll()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
