import { describe, expect, it } from 'vitest'
import { claudeAttention } from './claudeAttention'

const notification = (payload: object) => claudeAttention('Notification', JSON.stringify(payload))

describe('claudeAttention', () => {
  it('marks a permission prompt as waiting with its message', () => {
    expect(
      notification({
        notification_type: 'permission_prompt',
        message: 'Claude needs your permission to use Bash',
      }),
    ).toEqual({ state: 'waiting', message: 'Claude needs your permission to use Bash' })
  })

  it('never turns the idle reminder after a finished turn into waiting', () => {
    expect(
      notification({
        notification_type: 'idle_prompt',
        message: 'Claude is waiting for your input',
      }),
    ).toBeNull()
    expect(notification({ message: 'Claude is waiting for your input' })).toBeNull()
  })

  it('never turns a finished subagent into waiting while the parent still works', () => {
    expect(
      notification({ notification_type: 'agent_completed', message: 'Agent finished' }),
    ).toBeNull()
  })

  it('keeps an unknown notification as waiting', () => {
    expect(notification({ notification_type: 'elicitation_dialog', message: 'Pick one' })).toEqual({
      state: 'waiting',
      message: 'Pick one',
    })
  })

  it('marks a question or a plan for review as waiting, and ignores other tools', () => {
    const question = JSON.stringify({
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Which database?' }] },
    })
    expect(claudeAttention('PreToolUse', question)).toEqual({
      state: 'waiting',
      message: 'Which database?',
    })
    expect(claudeAttention('PreToolUse', JSON.stringify({ tool_name: 'ExitPlanMode' }))).toEqual({
      state: 'waiting',
      message: 'Plan ready for review',
    })
    expect(claudeAttention('PreToolUse', JSON.stringify({ tool_name: 'Bash' }))).toBeNull()
  })

  it('ends a turn as done, and a failed turn as an error', () => {
    expect(claudeAttention('Stop', '{}')).toEqual({ state: 'done', message: '' })
    expect(claudeAttention('StopFailure', JSON.stringify({ error: 'rate_limit' }))).toEqual({
      state: 'error',
      message: 'rate_limit',
    })
  })

  it('survives a payload that is not JSON', () => {
    expect(claudeAttention('Notification', 'not json')).toEqual({ state: 'waiting', message: '' })
    expect(claudeAttention('PreToolUse', '')).toBeNull()
  })
})
