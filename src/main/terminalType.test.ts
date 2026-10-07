import { delimiter } from 'node:path'
import { describe, expect, it } from 'vitest'
import { paneShellEnv } from './terminalType'
import { newWindowCommand } from './tmux/tmuxCommand'

const parts = {
  version: '1.2.3',
  parent: { PATH: '/bin', HOME: '/home/u' },
  integration: { ZDOTDIR: '/tmp/z' },
  pane: { OSTIA_PANE_ID: 'p1', OSTIA_TOKEN: 't' },
  agentHooks: undefined as unknown,
}

describe('paneShellEnv', () => {
  it('leaves both hook switches empty when the hooks are on', () => {
    const env = paneShellEnv({ ...parts, agentHooks: { claude: true, codex: true } })
    expect(env.OSTIA_NO_CLAUDE_HOOKS).toBe('')
    expect(env.OSTIA_NO_CODEX_HOOKS).toBe('')
  })

  it('sets only the switch of the agent whose hooks are off', () => {
    const claudeOff = paneShellEnv({ ...parts, agentHooks: { claude: false } })
    expect(claudeOff.OSTIA_NO_CLAUDE_HOOKS).toBe('1')
    expect(claudeOff.OSTIA_NO_CODEX_HOOKS).toBe('')
    const codexOff = paneShellEnv({ ...parts, agentHooks: { codex: false } })
    expect(codexOff.OSTIA_NO_CODEX_HOOKS).toBe('1')
    expect(codexOff.OSTIA_NO_CLAUDE_HOOKS).toBe('')
  })

  it('does not let a parent value turn the integration back on or leave it half off', () => {
    const parent = { ...parts.parent, OSTIA_NO_CLAUDE_HOOKS: '', OSTIA_NO_CODEX_HOOKS: '1' }
    const env = paneShellEnv({ ...parts, parent, agentHooks: { claude: false, codex: true } })
    expect(env.OSTIA_NO_CLAUDE_HOOKS).toBe('1')
    expect(env.OSTIA_NO_CODEX_HOOKS).toBe('')
  })

  it('changes nothing else in the environment', () => {
    expect(paneShellEnv({ ...parts, agentHooks: { claude: false } })).toEqual({
      PATH: '/bin',
      HOME: '/home/u',
      ZDOTDIR: '/tmp/z',
      OSTIA_PANE_ID: 'p1',
      OSTIA_TOKEN: 't',
      OSTIA_NO_CLAUDE_HOOKS: '1',
      OSTIA_NO_CODEX_HOOKS: '',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'ostia',
      TERM_PROGRAM_VERSION: '1.2.3',
    })
  })

  it('overrides a terminal identity inherited from the parent environment', () => {
    const parent = { ...parts.parent, TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '9' }
    const env = paneShellEnv({ ...parts, parent })
    expect(env.TERM_PROGRAM).toBe('ostia')
    expect(env.TERM_PROGRAM_VERSION).toBe('1.2.3')
  })

  it('reaches the keep-shells tmux window as -e flags', () => {
    const env = paneShellEnv({ ...parts })
    const command = newWindowCommand({ session: 's', file: '/bin/sh', args: [], cwd: '/', env })
    expect(command).toContain('-e "TERM_PROGRAM=ostia"')
    expect(command).toContain('-e "TERM_PROGRAM_VERSION=1.2.3"')
  })
})

describe('paneShellEnv launcher directory', () => {
  it('prepends the launcher directory to PATH when one is given', () => {
    const env = paneShellEnv({ ...parts, launcherDir: '/ud/bin' })
    expect(env.PATH).toBe(`/ud/bin${delimiter}/bin`)
  })

  it('leaves PATH alone when no launcher directory is given', () => {
    expect(paneShellEnv(parts).PATH).toBe('/bin')
  })
})
