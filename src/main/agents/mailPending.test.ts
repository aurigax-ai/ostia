import { describe, expect, it } from 'vitest'
import { mailPending } from './mailPending'

const on = () => true

describe('mailPending', () => {
  it('says hibernated before anything else, even for a pane with hooks off', () => {
    expect(mailPending({ agent: 'claude', hibernated: true }, () => false)).toBe('hibernated')
  })

  it('says no-agent for a pane without an agent and for a pane nobody lists', () => {
    expect(mailPending({}, on)).toBe('no-agent')
    expect(mailPending(undefined, on)).toBe('no-agent')
  })

  it('says agent-pane for an Agent pane, never no-agent, even with no agent state', () => {
    expect(mailPending({ kind: 'agent' }, on)).toBe('agent-pane')
    expect(mailPending({ kind: 'agent', hibernated: true }, on)).toBe('hibernated')
  })

  it('says hooks-off when the human switched that agent’s hooks off', () => {
    expect(mailPending({ agent: 'codex' }, (agent) => agent !== 'codex')).toBe('hooks-off')
  })

  it('says the mod will start a turn in an idle agent whose mailer is ready, unless the human is typing or turns ran out', () => {
    const idle = { agent: 'claude', agentState: 'done' }
    expect(mailPending(idle, on, { state: { draft: false }, limited: false })).toBe(
      'idle-will-wake',
    )
    expect(mailPending(idle, on, { state: { draft: true }, limited: false })).toBe('draft')
    expect(mailPending(idle, on, { state: { draft: false }, limited: true })).toBe('rate-limited')
    expect(mailPending(idle, on, { state: undefined, limited: false })).toBe('idle-no-wake')
  })

  it('says working for a working agent whatever its mailer, and keeps hibernated and hooks-off first', () => {
    const mailer = { state: { draft: false }, limited: false }
    expect(mailPending({ agent: 'claude', agentState: 'working' }, on, mailer)).toBe('working')
    expect(mailPending({ agent: 'claude', hibernated: true }, on, mailer)).toBe('hibernated')
    expect(mailPending({ agent: 'claude' }, () => false, mailer)).toBe('hooks-off')
  })

  it('tells a working agent from an idle one that nothing wakes', () => {
    expect(mailPending({ agent: 'claude', agentState: 'working' }, on)).toBe('working')
    for (const agentState of ['done', 'waiting', 'error', undefined]) {
      expect(mailPending({ agent: 'claude', agentState }, on)).toBe('idle-no-wake')
    }
  })
})
