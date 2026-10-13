import { describe, expect, it } from 'vitest'
import { type HibernationCandidate, commandAgent, planHibernation } from './hibernation'

describe('commandAgent', () => {
  it('names the agent a command line starts, by program basename', () => {
    expect(commandAgent('claude')).toBe('claude')
    expect(commandAgent('claude --resume abc')).toBe('claude')
    expect(commandAgent('/home/me/.local/bin/codex resume x')).toBe('codex')
    expect(commandAgent('FOO=1 env BAR=2 exec claude')).toBe('claude')
  })

  it('does not treat other programs as agents', () => {
    expect(commandAgent('npm test')).toBeNull()
    expect(commandAgent('echo claude')).toBeNull()
    expect(commandAgent('claude-code-helper')).toBeNull()
    expect(commandAgent('')).toBeNull()
  })
})

const candidate = (
  paneId: string,
  over: Partial<HibernationCandidate> = {},
): HibernationCandidate => ({
  paneId,
  workspaceId: 's1',
  agentRunning: true,
  visible: false,
  idleMs: 3_600_000,
  ...over,
})

describe('planHibernation', () => {
  const policy = { idleSeconds: 600, maxLiveTerminals: 2 }

  it('plans nothing while the live agents fit under the limit', () => {
    expect(planHibernation([candidate('a'), candidate('b')], policy)).toEqual({
      excess: 0,
      longestIdleFirst: [],
    })
  })

  it('orders the idle hidden agents longest idle first, with how many are over the limit', () => {
    const plan = planHibernation(
      [
        candidate('a', { idleMs: 700_000 }),
        candidate('b', { idleMs: 5_000_000 }),
        candidate('c', { idleMs: 900_000 }),
        candidate('d', { idleMs: 800_000 }),
      ],
      policy,
    )
    expect(plan.excess).toBe(2)
    expect(plan.longestIdleFirst.map((c) => c.paneId)).toEqual(['b', 'c', 'd', 'a'])
  })

  it('never offers a visible pane or one idle for less than the threshold', () => {
    const plan = planHibernation(
      [
        candidate('shown', { visible: true }),
        candidate('busy', { idleMs: 599_000 }),
        candidate('idle'),
        candidate('also-idle', { idleMs: 1_000_000 }),
      ],
      policy,
    )
    expect(plan.excess).toBe(2)
    expect(plan.longestIdleFirst.map((c) => c.paneId)).toEqual(['idle', 'also-idle'])
  })

  it('counts only panes where the agent itself is running', () => {
    const plan = planHibernation(
      [
        candidate('shell', { agentRunning: false }),
        candidate('other-cmd', { agentRunning: false }),
        candidate('a'),
        candidate('b'),
      ],
      policy,
    )
    expect(plan).toEqual({ excess: 0, longestIdleFirst: [] })
  })

  it('offers every idle hidden agent when the limit is zero', () => {
    const plan = planHibernation([candidate('a'), candidate('b', { visible: true })], {
      idleSeconds: 600,
      maxLiveTerminals: 0,
    })
    expect(plan.excess).toBe(2)
    expect(plan.longestIdleFirst.map((c) => c.paneId)).toEqual(['a'])
  })
})
