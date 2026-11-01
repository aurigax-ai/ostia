import type { OpenTerminalResult } from '@aurigax-ai/ostia-extension-sdk'
import { describe, expect, it, vi } from 'vitest'
import { HelperConsent } from '../consent'
import { planConnect } from '../plan'
import { remoteCommands } from './commands'
import { RemoteRegistry } from './registry'
import { RemoteFailure, type RunnerClient } from './runnerClient'
import { openRemoteTab } from './tab'

const jobs = [
  {
    pane: '0123abcd',
    name: 'worker',
    agent: 'claude',
    folder: '/w/a\tb',
    state: 'working',
    startedAt: '',
  },
  { pane: '4567ef01', agent: 'shell', folder: '/w', state: 'idle', startedAt: '' },
]

function commands() {
  const registry = new RemoteRegistry(null)
  registry.addWorkspace('w1', { host: 'box', folder: '~', agent: 'claude' })
  const client = {
    ensure: async () => ({ version: 'v' }),
    jobs: async () => jobs,
  } as unknown as RunnerClient
  return remoteCommands({
    translate: () => (key) => key,
    confirm: async () => true,
    openTerminal: async () => ({ ok: false, error: 'x' }),
    client: () => client,
    bundle: { version: 'v' } as never,
    consent: new HelperConsent(null),
    registry,
  })
}

const caller = { kind: 'user' as const, capabilities: [], workspaceId: 'w1' }

describe('remote-jobs', () => {
  it('REM-U9 prints each pane as its full remote ref with its name, one tab-separated line', async () => {
    const res = await commands()['remote-jobs']({ argv: [] }, caller)
    expect(res).toEqual({
      ok: true,
      text: 'remote:box:0123abcd\tworker\tclaude\tworking\t/w/a b\nremote:box:4567ef01\t-\tshell\tidle\t/w',
    })
  })

  it('REM-U10 answers JSON with the refs and the names for --json and for the dialog', async () => {
    const expected = [
      expect.objectContaining({ ref: 'remote:box:0123abcd', name: 'worker' }),
      expect.objectContaining({ ref: 'remote:box:4567ef01' }),
    ]
    for (const argv of [['--json'], ['{}']]) {
      const res = await commands()['remote-jobs']({ argv }, caller)
      expect(res).toMatchObject({ ok: true, data: { host: 'box', jobs: expected } })
    }
  })

  it('REM-U11 names the host on the command line when the workspace is not remote', async () => {
    const res = await commands()['remote-jobs'](
      { argv: ['other'] },
      { ...caller, workspaceId: 'w9' },
    )
    expect(res).toMatchObject({ ok: true })
  })
})

describe('remote-terminal', () => {
  function shellSetup(opened: OpenTerminalResult = { ok: true, paneId: 'tab-1' }) {
    const registry = new RemoteRegistry(null)
    registry.addWorkspace('w1', { host: 'box', folder: '/srv/app', agent: 'claude' })
    const stop = vi.fn(async () => ({}))
    const paneNew = vi.fn(async () => '0123abcd')
    const openTerminal = vi.fn(async () => opened)
    const client = {
      ensure: async () => ({ version: 'v' }),
      paneNew,
      stop,
    } as unknown as RunnerClient
    const handlers = remoteCommands({
      translate: () => (key) => key,
      confirm: async () => true,
      openTerminal,
      client: () => client,
      bundle: { version: 'v' } as never,
      consent: new HelperConsent(null),
      registry,
    })
    return { handlers, registry, stop, paneNew, openTerminal }
  }

  const args = (place: string) => ({ argv: [JSON.stringify({ place })] })

  it('REM-U39 starts a shell job in the workspace folder and opens it where it was asked', async () => {
    const { handlers, registry, paneNew, openTerminal } = shellSetup()

    const res = await handlers['remote-terminal'](args('vertical'), {
      ...caller,
      paneId: 'beside',
    })

    expect(res).toMatchObject({ ok: true, data: { paneId: 'tab-1', pane: '0123abcd' } })
    expect(paneNew).toHaveBeenCalledWith({ agent: 'shell', folder: '/srv/app' })
    expect(openTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'w1',
        afterPaneId: 'beside',
        place: 'vertical',
        replaceShell: true,
        title: 'box',
      }),
    )
    expect(registry.tab('tab-1')).toEqual({
      workspaceId: 'w1',
      host: 'box',
      pane: '0123abcd',
      shell: true,
    })
  })

  it('REM-U40 stops the new job when no tab could open', async () => {
    const { handlers, registry, stop } = shellSetup({ ok: false, error: 'no-window' })

    const res = await handlers['remote-terminal'](args('tab'), caller)

    expect(res).toMatchObject({ ok: false, error: 'not-opened' })
    expect(stop).toHaveBeenCalledWith('0123abcd')
    expect(registry.tab('tab-1')).toBeUndefined()
  })

  it('REM-U41 refuses a workspace that is not remote and a place it does not know', async () => {
    const { handlers, paneNew } = shellSetup()

    expect(
      await handlers['remote-terminal'](args('tab'), { ...caller, workspaceId: 'w2' }),
    ).toMatchObject({ ok: false, error: 'invalid-args' })
    expect(await handlers['remote-terminal'](args('left'), caller)).toMatchObject({
      ok: false,
      error: 'invalid-args',
    })
    expect(paneNew).not.toHaveBeenCalled()
  })

  it("REM-U42 is the human's, like the other remote commands", async () => {
    const { handlers, paneNew } = shellSetup()

    const res = await handlers['remote-terminal'](args('tab'), { ...caller, kind: 'pane' })

    expect(res).toMatchObject({ ok: false, error: 'human-only' })
    expect(paneNew).not.toHaveBeenCalled()
  })
})

describe('an agent tab', () => {
  it('REM-U43 also replaces the local shell, so it never drops back to a local prompt', async () => {
    const opened: unknown[] = []
    const plan = planConnect(['box'])
    if (!plan) throw new Error('no plan')
    await openRemoteTab(
      {
        openTerminal: async (opts) => {
          opened.push(opts)
          return { ok: true, paneId: 'tab-1' }
        },
        registry: new RemoteRegistry(null),
      },
      (key) => key,
      { plan, host: 'box', pane: '0123abcd' },
    )
    expect(opened).toEqual([expect.objectContaining({ replaceShell: true })])
  })
})

describe('the install step with an older runner', () => {
  function setup(ensure: (replace?: boolean) => Promise<unknown>) {
    const registry = new RemoteRegistry(null)
    registry.addWorkspace('w1', { host: 'box', folder: '~', agent: 'claude' })
    const client = { ensure, install: async () => {} } as unknown as RunnerClient
    const handlers = remoteCommands({
      translate: () => (key) => key,
      confirm: async () => true,
      openTerminal: async () => ({ ok: false, error: 'x' }),
      client: () => client,
      bundle: { version: 'v' } as never,
      consent: new HelperConsent(null),
      registry,
    })
    return () => handlers['remote-step']({ argv: ['{"host":"box","step":"install"}'] }, caller)
  }

  it('RPF-C28 replaces an older runner in the one install step', async () => {
    const replaced: (boolean | undefined)[] = []
    const run = setup(async (replace) => {
      replaced.push(replace)
      if (!replace) throw new RemoteFailure('incompatible', 'old')
      return { version: 'v' }
    })
    expect(await run()).toMatchObject({ ok: true, data: { id: 'install', state: 'done' } })
    expect(replaced).toEqual([undefined, true])
  })

  it('RPF-C29 shows the reason when the update fails', async () => {
    const run = setup(async (replace) => {
      throw replace
        ? new RemoteFailure('runner-stopped', 'would not start')
        : new RemoteFailure('incompatible', 'old')
    })
    expect(await run()).toMatchObject({
      ok: true,
      data: { state: 'failed', error: 'runner-stopped', detail: 'would not start' },
    })
  })
})
