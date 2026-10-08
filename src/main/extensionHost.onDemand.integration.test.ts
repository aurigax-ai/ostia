import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AssistModelSettings } from '../shared/assist'
import type { CommandResult } from '../shared/types'
import { registerControlServer, stopControlServer } from './controlServer'
import { ExtensionHost, registerExtensionMethods } from './extensionHost'
import { ExtensionStore } from './extensionStore'

const echoFixtures = resolve(__dirname, '../../test/fixtures/extensions')
const assistFixtures = resolve(__dirname, '../../test/fixtures/extensions-assist-models')

async function until<T>(read: () => T | undefined, timeoutMs = 8000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 20))
  }
}

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
    host.stopAll()
    stopControlServer()
    rmSync(dir, { recursive: true, force: true })
  })

  it('does not start a built-in assist extension with the window while it has no provider', async () => {
    host.startEager()
    await new Promise((r) => setTimeout(r, 300))
    expect(host.isRunning('switchboard')).toBe(false)
    expect(status('switchboard')).toBe('idle')
  })

  it('starts a built-in extension with window items with the window', async () => {
    await until(() => (status('echo') === 'running' ? true : undefined))
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
