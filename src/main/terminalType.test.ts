import { describe, expect, it } from 'vitest'
import { paneShellEnv } from './terminalType'

const parts = {
  parent: { PATH: '/bin', HOME: '/home/u' },
  integration: { ZDOTDIR: '/tmp/z' },
  pane: { PINE_PANE_ID: 'p1', PINE_TOKEN: 't' },
  agentHooks: undefined as unknown,
}

describe('paneShellEnv', () => {
  it('leaves both hook switches empty when the hooks are on', () => {
    const env = paneShellEnv({ ...parts, agentHooks: { claude: true, codex: true } })
    expect(env.PINE_NO_CLAUDE_HOOKS).toBe('')
    expect(env.PINE_NO_CODEX_HOOKS).toBe('')
  })

  it('sets only the switch of the agent whose hooks are off', () => {
    const claudeOff = paneShellEnv({ ...parts, agentHooks: { claude: false } })
    expect(claudeOff.PINE_NO_CLAUDE_HOOKS).toBe('1')
    expect(claudeOff.PINE_NO_CODEX_HOOKS).toBe('')
    const codexOff = paneShellEnv({ ...parts, agentHooks: { codex: false } })
    expect(codexOff.PINE_NO_CODEX_HOOKS).toBe('1')
    expect(codexOff.PINE_NO_CLAUDE_HOOKS).toBe('')
  })

  it('does not let a parent value turn the integration back on or leave it half off', () => {
    const parent = { ...parts.parent, PINE_NO_CLAUDE_HOOKS: '', PINE_NO_CODEX_HOOKS: '1' }
    const env = paneShellEnv({ ...parts, parent, agentHooks: { claude: false, codex: true } })
    expect(env.PINE_NO_CLAUDE_HOOKS).toBe('1')
    expect(env.PINE_NO_CODEX_HOOKS).toBe('')
  })

  it('changes nothing else in the environment', () => {
    expect(paneShellEnv({ ...parts, agentHooks: { claude: false } })).toEqual({
      PATH: '/bin',
      HOME: '/home/u',
      ZDOTDIR: '/tmp/z',
      PINE_PANE_ID: 'p1',
      PINE_TOKEN: 't',
      OSTIA_NO_CLAUDE_HOOKS: '1',
      PINE_NO_CLAUDE_HOOKS: '1',
      OSTIA_NO_CODEX_HOOKS: '',
      PINE_NO_CODEX_HOOKS: '',
      COLORTERM: 'truecolor',
    })
  })
})
