import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalOutcome } from '../../shared/approvals'
import type { PackageRef } from '../../shared/packages'
import { type PackageAsk, PackageRequests } from './packageRequests'

const pkg = (name: string, version = '1.0.0'): PackageRef => ({ ecosystem: 'npm', name, version })

function setup(outcome: ApprovalOutcome = 'workspace') {
  const asks: PackageAsk[] = []
  const stored: string[] = []
  const session: string[] = []
  const requests = new PackageRequests({
    ask: async (ask) => {
      asks.push(ask)
      return outcome
    },
    allowWorkspace: (_ws, key) => stored.push(key),
    allowUntilRestart: (_ws, key) => session.push(key),
    batchMs: 100,
  })
  return { requests, asks, stored, session }
}

describe('PackageRequests', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('SBX-C84 stores an Allow in this workspace so the retry and later installs pass', async () => {
    const { requests, asks, stored } = setup('workspace')
    requests.blocked('ws', pkg('fresh'), 'cooldown')
    await vi.advanceTimersByTimeAsync(150)
    expect(asks).toHaveLength(1)
    expect(stored).toEqual(['npm:fresh@1.0.0'])
    requests.blocked('ws', pkg('fresh'), 'cooldown')
    await vi.advanceTimersByTimeAsync(150)
    expect(asks).toHaveLength(1)
  })

  it('SBX-C85 warns about malware and never stores a lasting allowance for it', async () => {
    const { requests, asks, stored, session } = setup('workspace')
    requests.blocked('ws', pkg('evil'), 'malware')
    await vi.advanceTimersByTimeAsync(150)
    expect(asks[0]).toMatchObject({ malware: true, kind: 'package-malware' })
    expect(stored).toEqual([])
    expect(session).toEqual([])
  })

  it('SBX-C86 groups many downloads blocked at once into one card listing them', async () => {
    const { requests, asks } = setup('deny')
    for (let i = 0; i < 30; i++) requests.blocked('ws', pkg(`dep-${i}`), 'cooldown')
    await vi.advanceTimersByTimeAsync(150)
    expect(asks).toHaveLength(1)
    expect(asks[0].packages).toHaveLength(30)
    expect(asks[0].kind).toBe('package')
  })
})
