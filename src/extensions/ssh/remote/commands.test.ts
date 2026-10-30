import { describe, expect, it } from 'vitest'
import { HelperConsent } from '../consent'
import { remoteCommands } from './commands'
import { RemoteRegistry } from './registry'
import type { RunnerClient } from './runnerClient'

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
