import { describe, expect, it, vi } from 'vitest'
import { en } from '../../../shared/app/dict'

vi.mock('electron', () => ({
  app: {
    getVersion: () => '0',
    getLocale: () => 'en-US',
    getAppPath: () => '/',
    getPath: () => '/tmp',
    isPackaged: false,
  },
}))

vi.mock('../../workspaces/savedScrollback', () => ({
  stashScrollback: () => {},
  takeRestoredScrollback: () => '',
}))

const { createPtyStop } = await import('./ptyStop')
const { createPtyStart } = await import('./ptyStart')

function stopDeps(change: (paneId: string, state: string) => void, hibernated: Set<string>) {
  const entry = {
    pty: { kill: () => {} },
    flow: { dispose: () => {} },
    mirror: { dispose: () => {}, serialize: () => '' },
    stateFile: '/tmp/ostia-lifecycle-test-state',
    subs: new Map(),
  }
  return {
    ptys: new Map([['p1', entry]]),
    recoveryHeld: new Set<string>(),
    closedPanes: new Set<string>(),
    hibernatedPanes: hibernated,
    startedAgents: new Set<string>(),
    terminalState: new Map(),
    keptShells: { removeToken: () => {} },
    agentWork: { clear: () => {} },
    paneWaking: { end: () => {} },
    paneLifecycleEvents: { change },
    telemetry: () => null,
    appLog: () => null,
  } as never
}

describe('pane lifecycle events from the pty layer', () => {
  it('reports a hibernated pane once its terminal is stopped, and nothing for an unknown pane', () => {
    const change = vi.fn()
    const hibernated = new Set<string>()
    const { hibernatePty } = createPtyStop(stopDeps(change, hibernated))
    expect(hibernatePty('p1')).toBe(true)
    expect(change).toHaveBeenCalledWith('p1', 'hibernated')
    expect(hibernated.has('p1')).toBe(true)
    change.mockClear()
    expect(hibernatePty('ghost')).toBe(false)
    expect(change).not.toHaveBeenCalled()
  })

  function start(hibernated: Set<string>, change: (paneId: string, state: string) => void) {
    const session = {
      since: () => ({ data: '', cursor: 0, dropped: 0, startsBefore: 0 }),
      addLiveSubscriber: () => {},
      exit: () => {},
    }
    const entry = { session, exitListeners: new Set(), mirror: { blockSeqBase: 0 } }
    const { startTracked } = createPtyStart({
      keptShells: { removeToken: () => {} },
      workspaceSandboxes: { claimHomeNotice: () => false },
      hibernatedPanes: hibernated,
      paneLifecycleEvents: { change },
      trackPty: () => entry,
      feedPty: () => {},
      releaseMergedSandbox: () => {},
      telemetry: () => null,
      appLog: () => null,
      bannerText: () => en.native.paneBanner,
    } as never)
    const pty = { onData: () => {}, onExit: () => {} }
    const plan = {
      workspaceId: 'w1',
      shell: '/bin/sh',
      cols: 80,
      rows: 24,
      env: {},
      folder: {},
      sandboxed: false,
    }
    return startTracked(
      { sender: { id: 1 } } as never,
      'p1',
      {} as never,
      plan as never,
      { kept: pty as never, keptMeta: null },
      (() => ({})) as never,
    )
  }

  it('reports woken only when the terminal starts again after a hibernation', () => {
    const change = vi.fn()
    start(new Set(['p1']), change)
    expect(change).toHaveBeenCalledWith('p1', 'woken')
    change.mockClear()
    start(new Set(), change)
    expect(change).not.toHaveBeenCalled()
  })
})
