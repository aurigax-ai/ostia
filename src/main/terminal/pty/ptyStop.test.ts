import { describe, expect, it, vi } from 'vitest'
import { claimName, forgetNames, paneNamed } from '../../panes/paneNames'
import { releaseAgentDir } from '../shellIntegration'
import type { PtyEntry } from './ptyRegistry'
import { createPtyStop } from './ptyStop'

vi.mock('../../workspaces/savedScrollback', () => ({ stashScrollback: vi.fn() }))
vi.mock('./ptyRegistry', () => ({ removeStateFile: vi.fn() }))
vi.mock('../shellIntegration', () => ({ releaseAgentDir: vi.fn() }))

function stop(paneId: string) {
  const entry = {
    killTimer: null,
    pty: { kill: vi.fn() },
    flow: { dispose: vi.fn() },
    mirror: { dispose: vi.fn(), serialize: () => '' },
    subs: new Map(),
  } as unknown as PtyEntry
  const ptys = new Map([[paneId, entry]])
  return createPtyStop({
    ptys,
    recoveryHeld: new Set(),
    closedPanes: new Set(),
    hibernatedPanes: new Set(),
    startedAgents: new Set(),
    terminalState: new Map(),
    keptShells: { removeToken: vi.fn() },
    agentWork: { clear: vi.fn() },
    paneWaking: { end: vi.fn() },
    paneLifecycleEvents: { change: vi.fn() },
    telemetry: () => null,
    appLog: () => null,
  } as never)
}

describe('a bus name and the pty', () => {
  it.each(['closed', 'restart', 'process-kill', 'grace-expired', 'quit'] as const)(
    'is dropped when the pty is stopped for %s',
    (reason) => {
      forgetNames()
      claimName('p1', 'boss', undefined)
      stop('p1').killPty('p1', reason)
      expect(paneNamed('boss')).toBeUndefined()
    },
  )

  it('is kept when the pane hibernates, so mail to it can wake the agent', () => {
    forgetNames()
    claimName('p1', 'boss', undefined)
    expect(stop('p1').hibernatePty('p1')).toBe(true)
    expect(paneNamed('boss')).toBe('p1')
  })
})

describe('the agent generation of a stopped pty', () => {
  it.each(['closed', 'restart', 'hibernated'] as const)(
    'is released when the pty is stopped for %s',
    (reason) => {
      vi.mocked(releaseAgentDir).mockClear()
      stop('p1').killPty('p1', reason)
      expect(releaseAgentDir).toHaveBeenCalledWith('p1')
    },
  )
})
