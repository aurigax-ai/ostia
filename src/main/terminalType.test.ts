import { delimiter } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GPU_RESTORE_ENV } from './discreteGpu'
import { paneShellEnv, withPaneToken } from './terminalType'
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

  it('tells the pane where its workspace’s artifact folder and pad are', () => {
    const env = paneShellEnv({ ...parts, artifactsDir: '/data/artifacts/w1' })
    expect(env.OSTIA_ARTIFACTS).toBe('/data/artifacts/w1')
    expect(env.OSTIA_PAD).toBe('/data/artifacts/w1/PAD.md')
  })

  it('never passes on an artifact folder inherited from the parent environment', () => {
    const parent = { ...parts.parent, OSTIA_ARTIFACTS: '/other/w9', OSTIA_PAD: '/other/w9/PAD.md' }
    const env = paneShellEnv({ ...parts, parent, artifactsDir: null })
    expect(env.OSTIA_ARTIFACTS).toBeUndefined()
    expect(env.OSTIA_PAD).toBeUndefined()
  })

  it('overrides a terminal identity inherited from the parent environment', () => {
    const parent = { ...parts.parent, TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '9' }
    const env = paneShellEnv({ ...parts, parent })
    expect(env.TERM_PROGRAM).toBe('ostia')
    expect(env.TERM_PROGRAM_VERSION).toBe('1.2.3')
  })

  it('keeps the discrete GPU variables Ostia relaunched with out of the shell', () => {
    const parent = {
      ...parts.parent,
      DRI_PRIME: 'pci-0000_03_00_0',
      [GPU_RESTORE_ENV]: JSON.stringify({ DRI_PRIME: null }),
    }
    const env = paneShellEnv({ ...parts, parent })
    expect(env.DRI_PRIME).toBeUndefined()
    expect(env[GPU_RESTORE_ENV]).toBeUndefined()
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

describe('withPaneToken', () => {
  it('KSH-C72 gives a kept pane only its token file, never a token inherited from an Ostia it was started in', () => {
    const inherited = { PATH: '/bin', OSTIA_TOKEN: 'outer', OSTIA_TOKEN_FILE: '/outer/file' }
    expect(withPaneToken(inherited, 'mine', '/tmp/tokens/p1')).toEqual({
      PATH: '/bin',
      OSTIA_TOKEN_FILE: '/tmp/tokens/p1',
    })
    expect(withPaneToken(inherited, 'mine', null)).toEqual({ PATH: '/bin', OSTIA_TOKEN: 'mine' })
  })
})
