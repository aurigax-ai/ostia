import { describe, expect, it } from 'vitest'
import { codexAttention } from './codexAttention'

const call = (tool: string, input?: object) =>
  JSON.stringify({ tool_name: tool, ...(input ? { tool_input: input } : {}) })

describe('codexAttention', () => {
  it('waits with the first question when Codex asks one', () => {
    const input = { questions: [{ id: 'db', question: 'Which database?' }] }
    expect(codexAttention('PreToolUse', call('request_user_input', input))).toEqual({
      state: 'waiting',
      message: 'Which database?',
    })
  })

  it('waits with a generic message when the question text is missing', () => {
    expect(codexAttention('PreToolUse', call('request_user_input'))).toEqual({
      state: 'waiting',
      message: 'Has a question',
    })
  })

  it('goes back to working once the question is answered', () => {
    expect(codexAttention('PostToolUse', call('request_user_input'))).toEqual({
      state: 'working',
      message: '',
    })
  })

  it('ignores every other tool and unreadable input', () => {
    expect(codexAttention('PreToolUse', call('Bash'))).toBeNull()
    expect(codexAttention('PostToolUse', call('update_plan'))).toBeNull()
    expect(codexAttention('PreToolUse', 'not json')).toBeNull()
  })
})
