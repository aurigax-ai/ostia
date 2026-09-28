import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { privateTmpDir } from './privateTmp'
import { shellIntegrationSpawnOptions } from './shellIntegration'

const INTEGRATION_DIR = privateTmpDir('pine-shell-integration')
const ZSH_INIT = join(INTEGRATION_DIR, 'init.zsh')
const ZSH_ENV = join(INTEGRATION_DIR, '.zshenv')
const ZSH_RC = join(INTEGRATION_DIR, '.zshrc')
const BASH_INIT = join(INTEGRATION_DIR, 'init.bash')
const BASH_RC = join(INTEGRATION_DIR, 'bashrc')

describe('shellIntegrationSpawnOptions', () => {
  describe('zsh', () => {
    it('spawns with no extra args and points ZDOTDIR at the integration dir', () => {
      const { args, env } = shellIntegrationSpawnOptions('/usr/bin/zsh', { HOME: '/home/u' })
      expect(args).toEqual([])
      expect(env.ZDOTDIR).toBe(INTEGRATION_DIR)
    })

    it('sets PINE_ZDOTDIR_ORIG to baseEnv.ZDOTDIR when it is present', () => {
      const { env } = shellIntegrationSpawnOptions('zsh', {
        ZDOTDIR: '/custom/zdot',
        HOME: '/home/u',
      })
      expect(env.PINE_ZDOTDIR_ORIG).toBe('/custom/zdot')
    })

    it('falls back to baseEnv.HOME for PINE_ZDOTDIR_ORIG when ZDOTDIR is unset', () => {
      const { env } = shellIntegrationSpawnOptions('zsh', { HOME: '/home/u' })
      expect(env.PINE_ZDOTDIR_ORIG).toBe('/home/u')
    })

    it('falls back to an empty string for PINE_ZDOTDIR_ORIG when neither ZDOTDIR nor HOME is set', () => {
      const { env } = shellIntegrationSpawnOptions('zsh', {})
      expect(env.PINE_ZDOTDIR_ORIG).toBe('')
    })

    it('matches the basename case-insensitively for a bare uppercase name', () => {
      const { env } = shellIntegrationSpawnOptions('ZSH', {})
      expect(env.ZDOTDIR).toBe(INTEGRATION_DIR)
    })

    it('resolves zsh from a full path via its basename', () => {
      const { args, env } = shellIntegrationSpawnOptions('/opt/homebrew/bin/zsh', {})
      expect(args).toEqual([])
      expect(env.ZDOTDIR).toBe(INTEGRATION_DIR)
    })
  })

  describe('bash', () => {
    it('spawns with --rcfile pointing at the generated bashrc and no extra env', () => {
      const { args, env } = shellIntegrationSpawnOptions('/bin/bash', {})
      expect(args).toEqual(['--rcfile', BASH_RC])
      expect(env).toEqual({})
    })
  })

  describe('unintegrated shells', () => {
    it.each(['fish', '/usr/bin/fish', 'sh', 'pwsh', 'powershell.exe', 'someunknownshell'])(
      'returns no integration for %s',
      (shell) => {
        const result = shellIntegrationSpawnOptions(shell, { HOME: '/home/u' })
        expect(result).toEqual({ args: [], env: {} })
      },
    )
  })

  describe('generated rc/init files', () => {
    it('writes a zsh init file emitting OSC 133 marks and OSC 7 cwd reports', () => {
      shellIntegrationSpawnOptions('zsh', { HOME: '/home/u' })
      const init = readFileSync(ZSH_INIT, 'utf8')
      expect(init).toContain('133;A')
      expect(init).toContain('133;B')
      expect(init).toContain('133;C')
      expect(init).toContain('133;D')
      expect(init).toContain('7;file://')
    })

    it('registers the precmd/preexec/chpwd hooks in the generated zsh init', () => {
      shellIntegrationSpawnOptions('zsh', { HOME: '/home/u' })
      const init = readFileSync(ZSH_INIT, 'utf8')
      expect(init).toContain('add-zsh-hook precmd')
      expect(init).toContain('add-zsh-hook preexec')
      expect(init).toContain('add-zsh-hook chpwd')
    })

    it('reclaims ZDOTDIR after sourcing the real .zshenv in the generated .zshenv', () => {
      shellIntegrationSpawnOptions('zsh', { HOME: '/home/u' })
      const zshenv = readFileSync(ZSH_ENV, 'utf8')
      expect(zshenv).toContain('source "$PINE_ZDOTDIR_ORIG/.zshenv"')
      expect(zshenv).toContain(`if [ "$ZDOTDIR" != "${INTEGRATION_DIR}"`)
      expect(zshenv).toContain('PINE_ZDOTDIR_ORIG="$ZDOTDIR"')
      expect(zshenv).toContain(`ZDOTDIR="${INTEGRATION_DIR}"`)
    })

    it('orders the generated .zshrc: source real rc, source init, restore then unset ZDOTDIR', () => {
      shellIntegrationSpawnOptions('zsh', { HOME: '/home/u' })
      const zshrc = readFileSync(ZSH_RC, 'utf8')
      const sourceReal = zshrc.indexOf('source "$PINE_ZDOTDIR_ORIG/.zshrc"')
      const sourceInit = zshrc.indexOf('init.zsh')
      const restore = zshrc.indexOf('ZDOTDIR="$PINE_ZDOTDIR_ORIG"')
      const unset = zshrc.indexOf('unset PINE_ZDOTDIR_ORIG')
      expect(sourceReal).toBeGreaterThanOrEqual(0)
      expect(sourceReal).toBeLessThan(sourceInit)
      expect(sourceInit).toBeLessThan(restore)
      expect(restore).toBeLessThan(unset)
    })

    it('makes the generated bashrc source the user ~/.bashrc before the bash init', () => {
      const { args } = shellIntegrationSpawnOptions('/bin/bash', {})
      const rc = readFileSync(args[1], 'utf8')
      const sourceHome = rc.indexOf('source "$HOME/.bashrc"')
      const sourceInit = rc.indexOf('init.bash')
      expect(sourceHome).toBeGreaterThanOrEqual(0)
      expect(sourceInit).toBeGreaterThanOrEqual(0)
      expect(sourceHome).toBeLessThan(sourceInit)
    })

    it('makes the bash --rcfile source a bash init that emits OSC 133 marks and OSC 7', () => {
      const { args } = shellIntegrationSpawnOptions('/bin/bash', {})
      const rc = readFileSync(args[1], 'utf8')
      expect(rc).toContain('init.bash')
      const init = readFileSync(BASH_INIT, 'utf8')
      expect(init).toContain('133;A')
      expect(init).toContain('133;B')
      expect(init).toContain('133;C')
      expect(init).toContain('133;D')
      expect(init).toContain('7;file://')
    })

    it('wires the bash prompt hooks via PROMPT_COMMAND and a DEBUG trap', () => {
      shellIntegrationSpawnOptions('/bin/bash', {})
      const init = readFileSync(BASH_INIT, 'utf8')
      expect(init).toContain('PROMPT_COMMAND=')
      expect(init).toMatch(/trap .*DEBUG/)
    })
  })

  describe('idempotency', () => {
    it('returns identical results without throwing when called twice for the same shell', () => {
      const bash1 = shellIntegrationSpawnOptions('/bin/bash', {})
      const bash2 = shellIntegrationSpawnOptions('/bin/bash', {})
      expect(bash2).toEqual(bash1)

      const zsh1 = shellIntegrationSpawnOptions('zsh', { HOME: '/home/u' })
      const zsh2 = shellIntegrationSpawnOptions('zsh', { HOME: '/home/u' })
      expect(zsh2).toEqual(zsh1)
    })
  })
})
