import { describe, expect, it } from 'vitest'
import { agentHooksEnv, parseAgentHooks } from './agentHooks'

describe('agent hook switches', () => {
  it('keeps both agents on unless a switch is exactly false', () => {
    expect(parseAgentHooks(undefined)).toEqual({ claude: true, codex: true })
    expect(parseAgentHooks({ claude: false, codex: 'no' })).toEqual({ claude: false, codex: true })
  })

  it('marks the agents turned off in the spawn environment and clears an inherited mark', () => {
    expect(agentHooksEnv({})).toEqual({
      OSTIA_NO_CLAUDE_HOOKS: '',
      PINE_NO_CLAUDE_HOOKS: '',
      OSTIA_NO_CODEX_HOOKS: '',
      PINE_NO_CODEX_HOOKS: '',
    })
    expect(agentHooksEnv({ codex: false })).toEqual({
      OSTIA_NO_CLAUDE_HOOKS: '',
      PINE_NO_CLAUDE_HOOKS: '',
      OSTIA_NO_CODEX_HOOKS: '1',
      PINE_NO_CODEX_HOOKS: '1',
    })
    expect(agentHooksEnv({ claude: false, codex: false })).toEqual({
      OSTIA_NO_CLAUDE_HOOKS: '1',
      PINE_NO_CLAUDE_HOOKS: '1',
      OSTIA_NO_CODEX_HOOKS: '1',
      PINE_NO_CODEX_HOOKS: '1',
    })
  })
})
