import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ExtensionCaller } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CommandResult } from '../../shared/control/commands'
import { registerControlServer, stopControlServer } from '../control/controlServer'
import { ExtensionHost } from './extensionHost'
import { ExtensionLaunches } from './extensionLaunches'
import { registerExtensionMethods } from './extensionMethods'
import { ExtensionStore } from './extensionStore'

const POLL = { timeout: 8000, interval: 20 }

const fixtures = resolve(__dirname, '../../../test/fixtures/extensions-launch')
const caller: ExtensionCaller = { kind: 'user', workspaceId: 'w1', capabilities: [] }

describe('a built-in with sidebar items only starts with the window only after it asked to', () => {
  let dir: string
  let socketPath: string
  let host: ExtensionHost | null = null
  const launchesFile = () => join(dir, 'extension-launches.json')

  const launch = (builtin = true): ExtensionHost => {
    host = new ExtensionHost({
      sandboxDomains: () => null,
      isSandboxed: () => false,
      roots: [{ dir: fixtures, builtin }],
      store: new ExtensionStore(join(dir, 'extensions.json')),
      launches: new ExtensionLaunches(launchesFile()),
      socketPath: () => socketPath,
      nodePath: process.execPath,
      workDirForWorkspace: (sid) => (sid ? `/w/${sid}` : undefined),
      broadcast: () => {},
      openPanelIn: () => {},
      notify: () => {},
      restartDelayMs: 20,
      readyTimeoutMs: 8000,
      requestTimeoutMs: 4000,
      log: () => {},
    })
    host.processes.startEager()
    return host
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ostia-ext-launches-'))
    socketPath = join(dir, 'control.sock')
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

  afterEach(() => {
    host?.processes.stopAll()
    host = null
  })

  afterAll(() => {
    stopControlServer()
    rmSync(dir, { recursive: true, force: true })
  })

  const ask = async (h: ExtensionHost, on: unknown) => {
    const res = await h.invoke(
      'tally',
      'call',
      { method: 'ext.startWithWindow', params: { on } },
      caller,
    )
    return res.ok ? res.data : res
  }

  it('does not start at launch, and starts on first use', async () => {
    const h = launch()
    await new Promise((r) => setTimeout(r, 300))
    expect(h.processes.isRunning('tally')).toBe(false)
    expect(await ask(h, 'yes')).toMatchObject({ ok: false, error: 'invalid-params' })
    expect(h.processes.isRunning('tally')).toBe(true)
  })

  it('starts at the next launch once it asked to, and stops doing so once it said no', async () => {
    let h = launch()
    expect(await ask(h, true)).toEqual({ ok: true })
    expect(JSON.parse(readFileSync(launchesFile(), 'utf8'))).toEqual(['tally'])
    h.processes.stopAll()

    h = launch()
    await vi.waitUntil(() => h.processes.isRunning('tally'), POLL)
    expect(await ask(h, false)).toEqual({ ok: true })
    h.processes.stopAll()

    h = launch()
    await new Promise((r) => setTimeout(r, 300))
    expect(h.processes.isRunning('tally')).toBe(false)
  })

  it('leaves a non-built-in with sidebar items starting with the window', async () => {
    const h = launch(false)
    h.processes.approve('tally')
    await vi.waitUntil(() => h.processes.isRunning('tally'), POLL)
  })
})
