import { describe, expect, it } from 'vitest'
import { agentProblem } from './agentProblem'

describe('agentProblem', () => {
  it('shows the translated text for a missing model and a sandboxed workspace', () => {
    expect(agentProblem({ ok: false, error: 'no-model' })).toMatch(/agent\.providers/)
    expect(agentProblem({ ok: false, error: 'sandboxed' })).toMatch(/sandboxed/)
  })

  it('shows the message, then the code, for anything else', () => {
    expect(agentProblem({ ok: false, error: 'failed', message: 'boom' })).toBe('boom')
    expect(agentProblem({ ok: false, error: 'failed' })).toBe('failed')
  })
})
