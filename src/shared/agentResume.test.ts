import { describe, expect, it } from 'vitest'
import { parseAgentResume, resumeCommand, resumeFromHookPayload } from './agentResume'

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

  it('keeps an absolute cwd and drops one that is relative, too long or has a control character', () => {
    expect(parseAgentResume({ agent: 'claude', id: 'abc', cwd: '/work/tree' })).toEqual({
      agent: 'claude',
      id: 'abc',
      cwd: '/work/tree',
    })
    for (const cwd of ['work/tree', `/${'a'.repeat(4096)}`, '/work\ntree', '/work\u001btree', 7]) {
      expect(parseAgentResume({ agent: 'claude', id: 'abc', cwd })).toEqual({
        agent: 'claude',
        id: 'abc',
      })
    }
  })
})

describe('resumeCommand', () => {
  it('builds each agent’s own resume command', () => {
    expect(resumeCommand({ agent: 'claude', id: 'abc' })).toBe('claude --resume abc')
    expect(resumeCommand({ agent: 'codex', id: 'abc' })).toBe('codex resume abc')
  })
})

describe('resumeFromHookPayload', () => {
  it('reads session_id from a Claude Code hook event', () => {
    const event = JSON.stringify({ session_id: 'ffe55127-cb1f', hook_event_name: 'SessionStart' })
    expect(resumeFromHookPayload(event)).toEqual({ id: 'ffe55127-cb1f' })
  })

  it('reads session_id from a Codex SessionStart hook event', () => {
    const event = JSON.stringify({
      session_id: '01a0f04c-15fd-7b22-8538-ca8250a46988',
      hook_event_name: 'SessionStart',
      source: 'resume',
    })
    expect(resumeFromHookPayload(event)).toEqual({ id: '01a0f04c-15fd-7b22-8538-ca8250a46988' })
  })

  it('keeps the folder the session belongs to from the event’s cwd', () => {
    const event = JSON.stringify({
      session_id: 'ffe55127-cb1f',
      hook_event_name: 'SessionStart',
      cwd: '/home/u/work/tree',
    })
    expect(resumeFromHookPayload(event)).toEqual({ id: 'ffe55127-cb1f', cwd: '/home/u/work/tree' })
    const relative = JSON.stringify({ session_id: 'ffe55127-cb1f', cwd: 'tree' })
    expect(resumeFromHookPayload(relative)).toEqual({ id: 'ffe55127-cb1f' })
  })

  it('takes a bare id and refuses anything else', () => {
    expect(resumeFromHookPayload('abc-123\n')).toEqual({ id: 'abc-123' })
    expect(resumeFromHookPayload('not an id')).toBeNull()
    expect(resumeFromHookPayload('{broken')).toBeNull()
    expect(resumeFromHookPayload(JSON.stringify({ session_id: 'a b' }))).toBeNull()
  })
})
