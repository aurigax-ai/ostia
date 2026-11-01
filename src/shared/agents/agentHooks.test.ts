import { describe, expect, it } from 'vitest'
import { agentHooksEnv, parseAgentHooks } from './agentHooks'

describe('agent hook switches', () => {
  it('keeps every agent on unless a switch is exactly false', () => {
    expect(parseAgentHooks(undefined)).toEqual({ claude: true, codex: true, agy: true })
    expect(parseAgentHooks({ claude: false, codex: 'no', agy: 0 })).toEqual({
      claude: false,
      codex: true,
      agy: true,
    })
    expect(parseAgentHooks({ agy: false }).agy).toBe(false)
  })

  it('marks the agents turned off in the spawn environment and clears an inherited mark', () => {
    expect(agentHooksEnv({})).toEqual({
      OSTIA_NO_CLAUDE_HOOKS: '',
      OSTIA_NO_CODEX_HOOKS: '',
      OSTIA_NO_AGY_HOOKS: '',
    })
    expect(agentHooksEnv({ codex: false })).toEqual({
      OSTIA_NO_CLAUDE_HOOKS: '',
      OSTIA_NO_CODEX_HOOKS: '1',
      OSTIA_NO_AGY_HOOKS: '',
    })
    expect(agentHooksEnv({ claude: false, codex: false, agy: false })).toEqual({
      OSTIA_NO_CLAUDE_HOOKS: '1',
      OSTIA_NO_CODEX_HOOKS: '1',
      OSTIA_NO_AGY_HOOKS: '1',
    })
  })
})
