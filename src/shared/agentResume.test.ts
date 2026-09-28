import { describe, expect, it } from 'vitest'
import { parseAgentResume, resumeCommand, resumeIdFromHookPayload } from './agentResume'

describe('parseAgentResume', () => {
  it('accepts a known agent with a plain id', () => {
    expect(parseAgentResume({ agent: 'claude', id: 'ffe55127-cb1f-4efd' })).toEqual({
      agent: 'claude',
      id: 'ffe55127-cb1f-4efd',
    })
  })

  it('rejects an unknown agent or an id that could smuggle shell syntax', () => {
    expect(parseAgentResume({ agent: 'bash', id: 'abc' })).toBeNull()
    expect(parseAgentResume({ agent: 'claude', id: 'abc; rm -rf ~' })).toBeNull()
    expect(parseAgentResume({ agent: 'claude', id: '$(whoami)' })).toBeNull()
    expect(parseAgentResume({ agent: 'claude', id: '-x' })).toBeNull()
    expect(parseAgentResume(null)).toBeNull()
  })
})

describe('resumeCommand', () => {
  it('builds each agent’s own resume command', () => {
    expect(resumeCommand({ agent: 'claude', id: 'abc' })).toBe('claude --resume abc')
    expect(resumeCommand({ agent: 'codex', id: 'abc' })).toBe('codex resume abc')
  })
})

describe('resumeIdFromHookPayload', () => {
  it('reads session_id from a Claude Code hook event', () => {
    const event = JSON.stringify({ session_id: 'ffe55127-cb1f', hook_event_name: 'SessionStart' })
    expect(resumeIdFromHookPayload(event)).toBe('ffe55127-cb1f')
  })

  it('reads thread-id from a Codex notify event', () => {
    const event = JSON.stringify({ type: 'agent-turn-complete', 'thread-id': 'th_123' })
    expect(resumeIdFromHookPayload(event)).toBe('th_123')
  })

  it('takes a bare id and refuses anything else', () => {
    expect(resumeIdFromHookPayload('abc-123\n')).toBe('abc-123')
    expect(resumeIdFromHookPayload('not an id')).toBeNull()
    expect(resumeIdFromHookPayload('{broken')).toBeNull()
    expect(resumeIdFromHookPayload(JSON.stringify({ session_id: 'a b' }))).toBeNull()
  })
})
