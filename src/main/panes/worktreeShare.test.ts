import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneIdentity } from '../control/idRegistry'
import type { PaneEntry } from './paneList'
import { WorktreeShare } from './worktreeShare'

const entries = new Map<string, Partial<PaneEntry>>()
const keyOf = vi.fn(async (cwd: string): Promise<string | undefined> => {
  if (cwd.startsWith('/repo')) return '/repo\0/repo/.git'
  if (cwd.startsWith('/wt')) return '/wt\0/repo/.git/worktrees/wt'
  return undefined
})
const remote = new Set<string>()

const share = new WorktreeShare({
  panes: async () =>
    [...entries].map(
      ([paneId, entry]) =>
        ({
          paneId,
          workspaceId: 'ws1',
          kind: 'terminal',
          title: paneId,
          running: true,
          blockCount: 0,
          ...entry,
        }) as PaneEntry,
    ),
  key: keyOf,
  identity: (externalId) =>
    externalId.startsWith('x-')
      ? ({ kind: 'pane', externalId, paneId: `p-${externalId}` } as PaneIdentity)
      : undefined,
  remote: (paneId) => remote.has(paneId),
})

const agent = (cwd: string, over: Partial<PaneEntry> = {}) => ({ agent: 'claude', cwd, ...over })

beforeEach(() => {
  entries.clear()
  remote.clear()
  keyOf.mockClear()
})

describe('WorktreeShare', () => {
  it('pairs two running agents in the same worktree', async () => {
    entries.set('x-a', agent('/repo/src'))
    entries.set('x-b', agent('/repo'))
    await share.check()
    expect(share.others('x-a')).toEqual(['x-b'])
    expect(share.others('x-b')).toEqual(['x-a'])
  })

  it('does not pair agents in different worktrees of one repository, or one agent alone', async () => {
    entries.set('x-a', agent('/repo'))
    entries.set('x-b', agent('/wt'))
    await share.check()
    expect(share.others('x-a')).toEqual([])
  })

  it('leaves out shells, hibernated agents, panes without a folder or a git repository and remote panes', async () => {
    entries.set('x-a', agent('/repo'))
    entries.set('x-shell', { cwd: '/repo' })
    entries.set('x-asleep', agent('/repo', { hibernated: true }))
    entries.set('x-nofolder', { agent: 'codex' })
    entries.set('x-nogit', agent('/elsewhere'))
    entries.set('x-remote', agent('/repo'))
    remote.add('p-x-remote')
    await share.check()
    expect(share.others('x-a')).toEqual([])
  })

  it('reads a pane’s git state once, and again only when its folder or session changed', async () => {
    entries.set('x-a', agent('/repo', { agentSessionId: 's1' }))
    entries.set('x-b', agent('/repo'))
    await share.check()
    await share.check()
    expect(keyOf).toHaveBeenCalledTimes(2)
    entries.set('x-a', agent('/wt', { agentSessionId: 's1' }))
    await share.check()
    expect(keyOf).toHaveBeenCalledTimes(3)
    expect(share.others('x-a')).toEqual([])
    entries.set('x-a', agent('/wt', { agentSessionId: 's2' }))
    await share.check()
    expect(keyOf).toHaveBeenCalledTimes(4)
  })

  it('clears the pairing when an agent leaves', async () => {
    entries.set('x-a', agent('/repo'))
    entries.set('x-b', agent('/repo'))
    await share.check()
    entries.delete('x-b')
    await share.check()
    expect(share.others('x-a')).toEqual([])
  })

  it('pairs three agents with each of the others', async () => {
    for (const id of ['x-a', 'x-b', 'x-c']) entries.set(id, agent('/repo'))
    await share.check()
    expect(share.others('x-a')).toEqual(['x-b', 'x-c'])
  })

  it('waits out a burst of changes and checks once', async () => {
    vi.useFakeTimers()
    try {
      entries.set('x-a', agent('/repo'))
      entries.set('x-b', agent('/repo'))
      share.schedule()
      share.schedule()
      share.schedule()
      await vi.advanceTimersByTimeAsync(500)
      expect(share.others('x-a')).toEqual(['x-b'])
    } finally {
      vi.useRealTimers()
    }
  })
})
