import { delimiter } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GPU_RESTORE_ENV } from '../platform/discreteGpu'
import { newWindowCommand } from '../tmux/tmuxCommand'
import { paneShellEnv, ptyHyperlinkEnv, ptyLocaleEnv, withPaneToken } from './terminalType'

const parts = {
  version: '1.2.3',
  parent: { PATH: '/bin', HOME: '/home/u' },
  integration: { ZDOTDIR: '/tmp/z' },
  pane: { OSTIA_PANE_ID: 'p1', OSTIA_TOKEN: 't' },
  agentHooks: undefined as unknown,
  hasLocale: () => true,
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
      OSTIA_NO_AGY_HOOKS: '',
      LANG: 'en_US.UTF-8',
      FORCE_HYPERLINK: '1',
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

  it('tells the pane the folder its workspace is anchored to', () => {
    const env = paneShellEnv({ ...parts, workspaceDir: '/home/u/project' })
    expect(env.OSTIA_WORKSPACE_DIR).toBe('/home/u/project')
  })

  it('never passes on a workspace folder inherited from the parent environment', () => {
    const parent = { ...parts.parent, OSTIA_WORKSPACE_DIR: '/other/project' }
    const env = paneShellEnv({ ...parts, parent, workspaceDir: null })
    expect(env.OSTIA_WORKSPACE_DIR).toBeUndefined()
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

describe('paneShellEnv locale', () => {
  it('gives a pane started without a locale a UTF-8 LANG from the system locale', () => {
    expect(paneShellEnv({ ...parts, locale: 'zh-TW' }).LANG).toBe('zh_TW.UTF-8')
  })

  it('keeps the LANG the parent environment already has', () => {
    const parent = { ...parts.parent, LANG: 'C' }
    expect(paneShellEnv({ ...parts, parent, locale: 'zh-TW' }).LANG).toBe('C')
  })

  it('does not add LANG when LC_ALL is set', () => {
    const parent = { ...parts.parent, LC_ALL: 'en_GB.UTF-8' }
    const env = paneShellEnv({ ...parts, parent, locale: 'zh-TW' })
    expect(env.LANG).toBeUndefined()
    expect(env.LC_ALL).toBe('en_GB.UTF-8')
  })
})

describe('paneShellEnv hyperlinks', () => {
  it('turns on FORCE_HYPERLINK for a pane that did not set it', () => {
    expect(paneShellEnv(parts).FORCE_HYPERLINK).toBe('1')
  })

  it.each(['0', '1', 'false', ''])(
    'keeps FORCE_HYPERLINK=%j from the parent environment',
    (value) => {
      const parent = { ...parts.parent, FORCE_HYPERLINK: value }
      expect(paneShellEnv({ ...parts, parent }).FORCE_HYPERLINK).toBe(value)
    },
  )
})

describe('ptyHyperlinkEnv', () => {
  it('adds FORCE_HYPERLINK only when the parent has none', () => {
    expect(ptyHyperlinkEnv({})).toEqual({ FORCE_HYPERLINK: '1' })
    expect(ptyHyperlinkEnv({ FORCE_HYPERLINK: '0' })).toEqual({})
    expect(ptyHyperlinkEnv({ FORCE_HYPERLINK: '' })).toEqual({})
  })
})

describe('ptyLocaleEnv', () => {
  const all = () => true
  const none = () => false

  it('leaves the environment alone when LANG, LC_ALL or LC_CTYPE is set', () => {
    expect(ptyLocaleEnv({ LANG: 'C' }, 'zh-TW', all)).toEqual({})
    expect(ptyLocaleEnv({ LC_ALL: 'C' }, 'zh-TW', all)).toEqual({})
    expect(ptyLocaleEnv({ LC_CTYPE: 'UTF-8' }, 'zh-TW', all)).toEqual({})
  })

  it('treats empty locale variables as unset', () => {
    expect(ptyLocaleEnv({ LANG: '', LC_ALL: '' }, 'ja-JP', all)).toEqual({ LANG: 'ja_JP.UTF-8' })
  })

  it('turns a BCP 47 tag into a UTF-8 POSIX locale', () => {
    expect(ptyLocaleEnv({}, 'en-US', all)).toEqual({ LANG: 'en_US.UTF-8' })
    expect(ptyLocaleEnv({}, 'zh-TW', all)).toEqual({ LANG: 'zh_TW.UTF-8' })
    expect(ptyLocaleEnv({}, 'pt-br', all)).toEqual({ LANG: 'pt_BR.UTF-8' })
  })

  it('accepts POSIX style and already suffixed values', () => {
    expect(ptyLocaleEnv({}, 'zh_TW', all)).toEqual({ LANG: 'zh_TW.UTF-8' })
    expect(ptyLocaleEnv({}, 'de_DE.UTF-8', all)).toEqual({ LANG: 'de_DE.UTF-8' })
    expect(ptyLocaleEnv({}, 'fr_FR@euro', all)).toEqual({ LANG: 'fr_FR.UTF-8' })
  })

  it('takes the region from a tag that carries a script', () => {
    expect(ptyLocaleEnv({}, 'zh-Hant-TW', all)).toEqual({ LANG: 'zh_TW.UTF-8' })
    expect(ptyLocaleEnv({}, 'zh-Hans-CN', all)).toEqual({ LANG: 'zh_CN.UTF-8' })
  })

  it('maps a script without a region to its usual region', () => {
    expect(ptyLocaleEnv({}, 'zh-Hant', all)).toEqual({ LANG: 'zh_TW.UTF-8' })
    expect(ptyLocaleEnv({}, 'zh-Hans', all)).toEqual({ LANG: 'zh_CN.UTF-8' })
  })

  it('fills in the usual region for a bare language', () => {
    expect(ptyLocaleEnv({}, 'ja', all)).toEqual({ LANG: 'ja_JP.UTF-8' })
    expect(ptyLocaleEnv({}, 'en', all)).toEqual({ LANG: 'en_US.UTF-8' })
    expect(ptyLocaleEnv({}, 'de', all)).toEqual({ LANG: 'de_DE.UTF-8' })
  })

  it('falls back to the language default when the region has no locale on this system', () => {
    const macLike = (name: string) => name !== 'es_419.UTF-8' && name !== 'es_CL.UTF-8'
    expect(ptyLocaleEnv({}, 'es-CL', macLike)).toEqual({ LANG: 'es_ES.UTF-8' })
    expect(ptyLocaleEnv({}, 'es-419', macLike)).toEqual({ LANG: 'es_ES.UTF-8' })
  })

  it('checks Linux style names against what the system has installed', () => {
    const installed = new Set(['en_US.UTF-8', 'zh_TW.UTF-8'])
    expect(ptyLocaleEnv({}, 'zh-TW', (name) => installed.has(name))).toEqual({
      LANG: 'zh_TW.UTF-8',
    })
    expect(ptyLocaleEnv({}, 'fr-FR', (name) => installed.has(name))).toEqual({
      LANG: 'en_US.UTF-8',
    })
  })

  it('falls back to en_US.UTF-8 when the locale cannot be worked out', () => {
    expect(ptyLocaleEnv({}, undefined, all)).toEqual({ LANG: 'en_US.UTF-8' })
    expect(ptyLocaleEnv({}, '', all)).toEqual({ LANG: 'en_US.UTF-8' })
    expect(ptyLocaleEnv({}, 'C', all)).toEqual({ LANG: 'en_US.UTF-8' })
    expect(ptyLocaleEnv({}, 'x-y-z', all)).toEqual({ LANG: 'en_US.UTF-8' })
  })

  it('uses C.UTF-8 when only that exists, and en_US.UTF-8 when nothing can be confirmed', () => {
    expect(ptyLocaleEnv({}, 'zh-TW', (name) => name === 'C.UTF-8')).toEqual({ LANG: 'C.UTF-8' })
    expect(ptyLocaleEnv({}, 'zh-TW', none)).toEqual({ LANG: 'en_US.UTF-8' })
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
