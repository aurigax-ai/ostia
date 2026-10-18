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

  it('says hooks-off when the human switched that agent’s hooks off', () => {
    expect(mailPending({ agent: 'codex' }, (agent) => agent !== 'codex')).toBe('hooks-off')
  })

  it('tells a working agent from an idle one that nothing wakes', () => {
    expect(mailPending({ agent: 'claude', agentState: 'working' }, on)).toBe('working')
    for (const agentState of ['done', 'waiting', 'error', undefined]) {
      expect(mailPending({ agent: 'claude', agentState }, on)).toBe('idle-no-wake')
    }
  })
})
