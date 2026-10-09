import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentPluginContent } from '../agents/agentSkills'
import { type ShellState, parseShellState } from './shellCommands'
import {
  CLAUDE_PLUGIN_MANIFEST,
  type CodexHookEvent,
  busHookCommand,
  claudeHookSettings,
  claudeWrapper,
  codexHookArgs,
  codexHookCommands,
  codexHookKey,
  codexHookTrustHash,
  codexWrapper,
  extensionHookCommand,
  permissionHookCommand,
  shellIntegrationDir,
  shellIntegrationFiles,
  shellIntegrationSpawnOptions,
  writeAgentPlugin,
  writeCodexIntegration,
  writeShellIntegration,
} from './shellIntegration'

const INTEGRATION_DIR = shellIntegrationDir()
const ZSH_INIT = join(INTEGRATION_DIR, 'init.zsh')
const ZSH_ENV = join(INTEGRATION_DIR, '.zshenv')
const ZSH_RC = join(INTEGRATION_DIR, '.zshrc')
const BASH_INIT = join(INTEGRATION_DIR, 'init.bash')
const BASH_RC = join(INTEGRATION_DIR, 'bashrc')
const AGENT_DIR = shellIntegrationSpawnOptions('/bin/bash', {}).env.OSTIA_AGENT_DIR ?? ''
const CLAUDE_PLUGIN = join(AGENT_DIR, 'claude-plugin')

describe('test isolation', () => {
  it("writes the integration files under this run's private temp folder", () => {
    expect(process.env.TMPDIR).toMatch(process.platform === 'darwin' ? /\/pv-/ : /ostia-vitest-/)
    expect(INTEGRATION_DIR.startsWith(`${process.env.TMPDIR}/`)).toBe(true)
  })
})

describe('writeShellIntegration', () => {
  let root: string
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'ostia-shells-'))
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  function otherBuild(dir: string): Record<string, string> {
    const files = shellIntegrationFiles(dir)
    return { ...files, '.zshrc': `${files['.zshrc']}# another build\n` }
  }

  it("keeps each build's files when another build writes into the same root", () => {
    const ours = writeShellIntegration(root)
    const theirs = writeShellIntegration(root, otherBuild)
    expect(theirs).not.toBe(ours)
    expect(readFileSync(join(ours, '.zshrc'), 'utf8')).toBe(shellIntegrationFiles(ours)['.zshrc'])
    expect(readFileSync(join(theirs, '.zshrc'), 'utf8')).toContain('OSTIA_ZDOTDIR_ORIG')
  })

  it('reuses the folder of identical files and points them at it', () => {
    const dir = writeShellIntegration(root)
    expect(writeShellIntegration(root)).toBe(dir)
    expect(readFileSync(join(dir, '.zshenv'), 'utf8')).toContain(`ZDOTDIR="${dir}"`)
    expect(readFileSync(join(dir, 'bashrc'), 'utf8')).toContain(
      `source "${join(dir, 'init.bash')}"`,
    )
  })
})

describe('shellIntegrationSpawnOptions', () => {
  describe('zsh', () => {
    it('spawns with no extra args and points ZDOTDIR at the integration dir', () => {
      const { args, env } = shellIntegrationSpawnOptions('/usr/bin/zsh', { HOME: '/home/u' })
      expect(args).toEqual([])
      expect(env.ZDOTDIR).toBe(INTEGRATION_DIR)
    })

    it('sets OSTIA_ZDOTDIR_ORIG to baseEnv.ZDOTDIR when it is present', () => {
      const { env } = shellIntegrationSpawnOptions('zsh', {
        ZDOTDIR: '/custom/zdot',
        HOME: '/home/u',
      })
      expect(env.OSTIA_ZDOTDIR_ORIG).toBe('/custom/zdot')
    })

    it('falls back to baseEnv.HOME for OSTIA_ZDOTDIR_ORIG when ZDOTDIR is unset', () => {
      const { env } = shellIntegrationSpawnOptions('zsh', { HOME: '/home/u' })
      expect(env.OSTIA_ZDOTDIR_ORIG).toBe('/home/u')
    })

    it('falls back to an empty string for OSTIA_ZDOTDIR_ORIG when neither ZDOTDIR nor HOME is set', () => {
      const { env } = shellIntegrationSpawnOptions('zsh', {})
      expect(env.OSTIA_ZDOTDIR_ORIG).toBe('')
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
    it('spawns with --rcfile pointing at the generated bashrc and only the agent plugin env', () => {
      const { args, env } = shellIntegrationSpawnOptions('/bin/bash', {})
      expect(args).toEqual(['--rcfile', BASH_RC])
      expect(env).toEqual({ OSTIA_AGENT_DIR: AGENT_DIR })
    })
  })

  describe('Ostia prompt', () => {
    it('asks zsh and bash for the plain prompt through the environment only when enabled', () => {
      const split = { separator: '$' as const, sameLine: false }
      const inline = { separator: 'none' as const, sameLine: true }
      expect(shellIntegrationSpawnOptions('zsh', { HOME: '/home/u' }, split).env).toMatchObject({
        OSTIA_PROMPT: 'ostia',
        OSTIA_PROMPT_SEPARATOR: '$',
        OSTIA_PROMPT_LINES: '2',
      })
      expect(shellIntegrationSpawnOptions('/bin/bash', {}, inline).env).toEqual({
        OSTIA_AGENT_DIR: AGENT_DIR,
        OSTIA_PROMPT: 'ostia',
        OSTIA_PROMPT_SEPARATOR: 'none',
        OSTIA_PROMPT_LINES: '1',
      })
      expect(shellIntegrationSpawnOptions('zsh', { HOME: '/home/u' }).env).not.toHaveProperty(
        'OSTIA_PROMPT',
      )
      expect(shellIntegrationSpawnOptions('/bin/bash', {}, null).env).toEqual({
        OSTIA_AGENT_DIR: AGENT_DIR,
      })
      expect(shellIntegrationSpawnOptions('fish', {}, split)).toEqual({ args: [], env: {} })
    })

    const B_MARK = '\x1b]133;B\x1b\\'
    const BASH_B_MARK = String.raw`\[\e]133;B\e\\\]`
    const run = (shell: string, init: string, script: string, env: Record<string, string>) => {
      shellIntegrationSpawnOptions(shell, { HOME: '/home/u' })
      return spawnSync(
        shell,
        [shell === 'zsh' ? '-f' : '--norc', '-c', `source '${init}'; ${script}`],
        { env: { PATH: '/usr/bin:/bin', HOME: '/home/u', ...env }, encoding: 'utf8' },
      )
    }

    describe('zsh', () => {
      const prompt = (env: Record<string, string>): string =>
        run(
          'zsh',
          ZSH_INIT,
          [
            "PROMPT='user> '",
            "RPROMPT='right'",
            'typeset -i torn=0',
            'prompt_powerlevel9k_teardown() { (( torn++ )) }',
            '__ostia_precmd >/dev/null',
            '__ostia_precmd >/dev/null',
            'print -rn -- "$torn|$PROMPT|$RPROMPT|$OSTIA_PROMPT"',
          ].join('; '),
          env,
        ).stdout

      it('puts the input on its own line under the cwd when the chips have their own row', () => {
        expect(
          prompt({ OSTIA_PROMPT: 'ostia', OSTIA_PROMPT_SEPARATOR: '$', OSTIA_PROMPT_LINES: '2' }),
        ).toBe(`1|%~\n$ %{${B_MARK}%}||`)
        expect(
          prompt({
            OSTIA_PROMPT: 'ostia',
            OSTIA_PROMPT_SEPARATOR: 'none',
            OSTIA_PROMPT_LINES: '2',
          }),
        ).toBe(`1|%~\n%{${B_MARK}%}||`)
      })

      it('replaces the prompt with the cwd and separator, clears RPROMPT and keeps the B mark', () => {
        expect(prompt({ OSTIA_PROMPT: 'ostia', OSTIA_PROMPT_SEPARATOR: '%' })).toBe(
          `1|%~ %% %{${B_MARK}%}||`,
        )
        expect(prompt({ OSTIA_PROMPT: 'ostia', OSTIA_PROMPT_SEPARATOR: '$' })).toBe(
          `1|%~ $ %{${B_MARK}%}||`,
        )
        expect(prompt({ OSTIA_PROMPT: 'ostia', OSTIA_PROMPT_SEPARATOR: 'none' })).toBe(
          `1|%~ %{${B_MARK}%}||`,
        )
      })

      it('tears powerlevel10k down while loading, before its first precmd can run', () => {
        const out = spawnSync(
          'zsh',
          [
            '-f',
            '-c',
            [
              'typeset -i torn=0',
              'prompt_powerlevel9k_teardown() { (( torn++ )) }',
              `source '${ZSH_INIT}'`,
              'print -rn -- "$torn|$PROMPT"',
              '__ostia_precmd >/dev/null',
              'print -rn -- "|$torn"',
            ].join('; '),
          ],
          {
            env: { PATH: '/usr/bin:/bin', HOME: '/home/u', OSTIA_PROMPT: 'ostia' },
            encoding: 'utf8',
          },
        ).stdout
        expect(out).toBe('1|%~ |1')
      })

      it('turns the powerlevel10k instant prompt off for the user’s rc only with the Ostia prompt', () => {
        const home = mkdtempSync(join(tmpdir(), 'ostia-zsh-home-'))
        try {
          writeFileSync(
            join(home, '.zshrc'),
            'print -rn -- "instant=${POWERLEVEL9K_INSTANT_PROMPT-unset}"\n',
          )
          const seen = (ostiaPrompt: Record<string, string>): string => {
            const { env } = shellIntegrationSpawnOptions('zsh', { HOME: home })
            return spawnSync('zsh', ['-i', '-c', 'true'], {
              env: { PATH: '/usr/bin:/bin', HOME: home, ...env, ...ostiaPrompt },
              encoding: 'utf8',
            }).stdout
          }
          expect(seen({ OSTIA_PROMPT: 'ostia' })).toContain('instant=off')
          expect(seen({})).toContain('instant=unset')
        } finally {
          rmSync(home, { recursive: true, force: true })
        }
      })

      it('leaves the user’s prompt alone when the Ostia prompt is off', () => {
        expect(prompt({})).toBe(`0|user> %{${B_MARK}%}|right|`)
      })

      it('renders the plain prompt as the home-abbreviated cwd', () => {
        const out = run(
          'zsh',
          ZSH_INIT,
          'HOME=$PWD; __ostia_precmd >/dev/null; print -rn -- "${(%)PROMPT}"',
          { OSTIA_PROMPT: 'ostia', OSTIA_PROMPT_SEPARATOR: '>' },
        ).stdout
        expect(out.startsWith('~ > ')).toBe(true)
      })
    })

    describe('bash', () => {
      const ps1 = (env: Record<string, string>): string => {
        const out = run(
          'bash',
          BASH_INIT,
          [
            "PS1='user> '",
            `__ostia_orig_prompt_command=("PS1='framework> '")`,
            '__ostia_prompt_command >/dev/null',
            'printf "|%s|%s" "$PS1" "$OSTIA_PROMPT"',
          ].join('; '),
          env,
        ).stdout
        return out.slice(out.indexOf('|'))
      }

      it('sets PS1 to the cwd and separator after the user’s PROMPT_COMMAND and keeps the B mark', () => {
        expect(ps1({ OSTIA_PROMPT: 'ostia', OSTIA_PROMPT_SEPARATOR: '>' })).toBe(
          `|\\w > ${BASH_B_MARK}|`,
        )
        expect(ps1({ OSTIA_PROMPT: 'ostia', OSTIA_PROMPT_SEPARATOR: 'none' })).toBe(
          `|\\w ${BASH_B_MARK}|`,
        )
      })

      it('puts the input on its own line under the cwd when the chips have their own row', () => {
        expect(
          ps1({ OSTIA_PROMPT: 'ostia', OSTIA_PROMPT_SEPARATOR: '>', OSTIA_PROMPT_LINES: '2' }),
        ).toBe(`|\\w\\n> ${BASH_B_MARK}|`)
      })

      it('keeps the framework’s PS1 when the Ostia prompt is off', () => {
        expect(ps1({})).toBe(`|framework> ${BASH_B_MARK}|`)
      })
    })
  })

  describe('scratch history', () => {
    let home: string
    beforeAll(() => {
      home = mkdtempSync(join(tmpdir(), 'ostia-histfile-home-'))
      writeFileSync(join(home, '.zshrc'), 'HISTFILE="$HOME/.zsh_history"\n')
      writeFileSync(join(home, '.bashrc'), 'HISTFILE="$HOME/.bash_history"\n')
      writeFileSync(join(home, '.zsh_history'), 'echo from-the-user-history\n')
    })
    afterAll(() => rmSync(home, { recursive: true, force: true }))

    const histfileOf = (shell: 'zsh' | 'bash', histFile: string | null): string => {
      const { args, env } = shellIntegrationSpawnOptions(shell, { HOME: home }, null, histFile)
      const out = spawnSync(shell, [...args, '-i', '-c', 'printf "<%s>" "$HISTFILE"'], {
        env: { PATH: '/usr/bin:/bin', HOME: home, TERM: 'dumb', ...env },
        encoding: 'utf8',
      }).stdout
      return out.slice(out.lastIndexOf('<') + 1, out.lastIndexOf('>'))
    }

    it('asks zsh and bash for the scratch history file through the environment only', () => {
      expect(shellIntegrationSpawnOptions('zsh', { HOME: home }, null, '/tmp/s/h').env).toEqual(
        expect.objectContaining({ OSTIA_HISTFILE: '/tmp/s/h' }),
      )
      expect(shellIntegrationSpawnOptions('bash', { HOME: home }, null, '/tmp/s/h').env).toEqual({
        OSTIA_AGENT_DIR: AGENT_DIR,
        OSTIA_HISTFILE: '/tmp/s/h',
      })
      expect(shellIntegrationSpawnOptions('zsh', { HOME: home }).env).not.toHaveProperty(
        'OSTIA_HISTFILE',
      )
    })

    it.each(['zsh', 'bash'] as const)(
      'points %s HISTFILE at the scratch folder after the user rc set its own',
      (shell) => {
        const scratch = join(home, 'scratch', '.ostia_history')
        expect(histfileOf(shell, scratch)).toBe(scratch)
      },
    )

    it.each(['zsh', 'bash'] as const)('leaves the user HISTFILE alone in %s otherwise', (shell) => {
      expect(histfileOf(shell, null)).toBe(join(home, `.${shell}_history`))
    })

    it('keeps an interactive zsh from reading or writing the user history', () => {
      const scratch = mkdtempSync(join(tmpdir(), 'ostia-histfile-scratch-'))
      const histFile = join(scratch, '.ostia_history')
      writeFileSync(join(home, '.zshrc'), 'HISTFILE="$HOME/.zsh_history"\nSAVEHIST=100\n')
      const { args, env } = shellIntegrationSpawnOptions('zsh', { HOME: home }, null, histFile)
      const out = spawnSync('zsh', [...args, '-i'], {
        env: { PATH: '/usr/bin:/bin', HOME: home, TERM: 'dumb', ...env },
        input: 'fc -ln 1 2>&1\necho scratch-only\nexit\n',
        encoding: 'utf8',
      }).stdout
      expect(out).not.toContain('from-the-user-history')
      expect(readFileSync(join(home, '.zsh_history'), 'utf8')).toBe('echo from-the-user-history\n')
      expect(readFileSync(histFile, 'utf8')).toContain('echo scratch-only')
      rmSync(scratch, { recursive: true, force: true })
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
      expect(zshenv).toContain('source "$OSTIA_ZDOTDIR_ORIG/.zshenv"')
      expect(zshenv).toContain(`if [ "$ZDOTDIR" != "${INTEGRATION_DIR}"`)
      expect(zshenv).toContain('OSTIA_ZDOTDIR_ORIG="$ZDOTDIR"')
      expect(zshenv).toContain(`ZDOTDIR="${INTEGRATION_DIR}"`)
    })

    it('orders the generated .zshrc: source real rc, source init, restore then unset ZDOTDIR', () => {
      shellIntegrationSpawnOptions('zsh', { HOME: '/home/u' })
      const zshrc = readFileSync(ZSH_RC, 'utf8')
      const sourceReal = zshrc.indexOf('source "$OSTIA_ZDOTDIR_ORIG/.zshrc"')
      const sourceInit = zshrc.indexOf('init.zsh')
      const restore = zshrc.indexOf('ZDOTDIR="$OSTIA_ZDOTDIR_ORIG"')
      const unset = zshrc.indexOf('unset OSTIA_ZDOTDIR_ORIG')
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

    it('marks only real commands when the user’s PROMPT_COMMAND is an array', () => {
      shellIntegrationSpawnOptions('/bin/bash', {})
      const dir = mkdtempSync(join(tmpdir(), 'ostia-bash-array-'))
      try {
        const rc = join(dir, 'rc')
        writeFileSync(
          rc,
          `PS1='b> '\nPROMPT_COMMAND=(true)\nPROMPT_COMMAND+=('printf TICK')\nsource '${BASH_INIT}'\n`,
        )
        const out = spawnSync('bash', ['--rcfile', rc, '-i'], {
          env: { HOME: dir, PATH: process.env.PATH ?? '/usr/bin:/bin', TERM: 'dumb' },
          input: 'echo hi\nfalse\n',
          encoding: 'utf8',
        })
        const text = `${out.stdout}${out.stderr}`
        const marks = (body: string): number => text.split(`\u001b]133;${body}\u001b\\`).length - 1
        expect(marks('C')).toBe(2)
        expect(text.split('TICK').length - 1).toBe(marks('A'))
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    describe.skipIf(process.platform !== 'linux')('bash command line marks (Linux only)', () => {
      const PASTE_START = '\x1b[200~'
      const PASTE_END = '\x1b[201~'
      const commandMarks = (typed: string, rcLines = ''): string[] => {
        shellIntegrationSpawnOptions('/bin/bash', {})
        const dir = mkdtempSync(join(tmpdir(), 'ostia-bash-lines-'))
        try {
          const rc = join(dir, 'rc')
          writeFileSync(
            rc,
            `PS1='b> '\nHISTFILE='${join(dir, 'history')}'\nbind 'set enable-bracketed-paste on'\n${rcLines}\nsource '${BASH_INIT}'\n`,
          )
          const out = spawnSync('script', ['-qec', `bash --rcfile '${rc}' -i`, '/dev/null'], {
            env: { HOME: dir, PATH: process.env.PATH ?? '/usr/bin:/bin', TERM: 'xterm' },
            input: `${typed}\rexit\r`,
            encoding: 'utf8',
          })
          return out.stdout
            .split('\x1b]')
            .slice(1)
            .map((osc) => osc.split('\x1b\\')[0])
            .filter((osc) => osc.startsWith('633;E;') || /^133;[CD]/.test(osc))
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      }

      it('reports every line of a pasted multi-line input as the whole command before D', () => {
        const typed = `${PASTE_START}echo ostia_ml_1\recho ostia_ml_2${PASTE_END}`
        expect(commandMarks(typed).slice(0, 4)).toEqual([
          '633;E;echo ostia_ml_1',
          '133;C',
          String.raw`633;E;echo ostia_ml_1\x0aecho ostia_ml_2`,
          '133;D;0',
        ])
      })

      it('reports a one-line command only once', () => {
        expect(commandMarks('echo solo').slice(0, 3)).toEqual([
          '633;E;echo solo',
          '133;C',
          '133;D;0',
        ])
      })

      it('counts an unrecorded repeat of the previous command as the first line', () => {
        const typed = `echo again\r${PASTE_START}echo again\recho after${PASTE_END}`
        expect(commandMarks(typed, 'HISTCONTROL=ignoredups').slice(3, 7)).toEqual([
          '633;E;echo again',
          '133;C',
          String.raw`633;E;echo again\x0aecho after`,
          '133;D;0',
        ])
      })

      it('keeps the first line when the history list was rewritten under the command', () => {
        const typed = `echo b\recho q\r${PASTE_START}echo a\recho b\recho c${PASTE_END}`
        expect(commandMarks(typed, 'HISTCONTROL=erasedups').slice(6, 9)).toEqual([
          '633;E;echo a',
          '133;C',
          '133;D;0',
        ])
      })
    })

    describe.each([
      ['bash', ['--norc'], BASH_INIT],
      ['zsh', ['-f'], ZSH_INIT],
    ])('%s reports its PATH and command names', (shell, noRc, init) => {
      let dir = ''
      let stateFile = ''

      beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), 'ostia-shell-state-'))
        stateFile = join(dir, 'state')
      })

      afterAll(() => {
        rmSync(dir, { recursive: true, force: true })
      })

      const report = (
        script: string,
        state: string | null = stateFile,
        extraEnv: Record<string, string> = {},
      ): string => {
        rmSync(stateFile, { force: true })
        shellIntegrationSpawnOptions(shell, { HOME: '/home/u' })
        return spawnSync(
          shell,
          [
            ...noRc,
            '-c',
            `source '${init}'; alias ostia_ll='ls'; ostia_fn() { :; }; _ostia_private() { :; }; ${script}`,
          ],
          {
            env: {
              PATH: '/ostia/bin:/usr/bin:/bin',
              HOME: '/home/u',
              ...(state ? { OSTIA_SHELL_STATE: state } : {}),
              ...extraEnv,
            },
            encoding: 'utf8',
          },
        ).stdout
      }
      const readState = (): ShellState => {
        const state = parseShellState(readFileSync(stateFile, 'utf8'))
        if (!state) throw new Error('unreadable shell state')
        return state
      }

      const readStateAfter = (script: string): ShellState => {
        report(script)
        return readState()
      }

      it('writes the PATH and its builtins, keywords, aliases and public functions to the state file, not the terminal', () => {
        expect(report('__ostia_report_shell')).toBe('')
        const { path, names } = readState()
        expect(path).toBe('/ostia/bin:/usr/bin:/bin')
        expect(names).toEqual(expect.arrayContaining(['cd', 'if', 'ostia_ll', 'ostia_fn']))
        expect(names).not.toContain('_ostia_private')
        expect(names).not.toContain('__ostia_report_shell')
      })

      it('rewrites the file only when the PATH or the names changed', () => {
        const out = report(
          [
            '__ostia_report_shell',
            'rm -f "$OSTIA_SHELL_STATE"',
            '__ostia_report_shell',
            '[ -e "$OSTIA_SHELL_STATE" ] && echo rewritten',
            'PATH=/x:$PATH',
            '__ostia_report_shell',
          ].join('; '),
        )
        expect(out).toBe('')
        expect(readState().path).toBe('/x:/ostia/bin:/usr/bin:/bin')
      })

      it('reports the virtualenv, conda env and KUBECONFIG, and rewrites when they change', () => {
        expect(readStateAfter('__ostia_report_shell')).toMatchObject({
          virtualEnv: null,
          condaEnv: null,
          kubeconfig: null,
        })
        const out = report(
          [
            '__ostia_report_shell',
            'export VIRTUAL_ENV=/home/u/proj/.venv CONDA_DEFAULT_ENV=base KUBECONFIG=/k/a:/k/b',
            '__ostia_report_shell',
          ].join('; '),
        )
        expect(out).toBe('')
        expect(readState()).toMatchObject({
          path: '/ostia/bin:/usr/bin:/bin',
          virtualEnv: '/home/u/proj/.venv',
          condaEnv: 'base',
          kubeconfig: '/k/a:/k/b',
        })
        expect(readState().names).toEqual(expect.arrayContaining(['cd', 'ostia_fn']))
      })

      it('drops newlines from a reported variable so it cannot shift the lines after it', () => {
        report('__ostia_report_shell', stateFile, { CONDA_DEFAULT_ENV: 'a\nb' })
        expect(readState()).toMatchObject({ condaEnv: 'ab', kubeconfig: null })
      })

      it('does nothing outside a Ostia pane', () => {
        expect(report('__ostia_report_shell', null)).toBe('')
        expect(existsSync(stateFile)).toBe(false)
      })
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

  describe('claude hooks', () => {
    it('writes a Claude Code plugin with the ostia skill and its manifest', () => {
      shellIntegrationSpawnOptions('/bin/bash', {})
      const manifest = JSON.parse(
        readFileSync(join(CLAUDE_PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8'),
      )
      expect(manifest).toEqual(CLAUDE_PLUGIN_MANIFEST)
      const skill = readFileSync(join(CLAUDE_PLUGIN, 'skills', 'ostia', 'SKILL.md'), 'utf8')
      expect(skill).toMatch(/^---\nname: ostia\ndescription: /)
      expect(manifest.name).toBe('ostia')
      expect(skill).toContain('ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" "$OSTIA_CLI"')
    })

    it('writes Claude Code hooks that record the resume token and attention state', () => {
      shellIntegrationSpawnOptions('/bin/bash', {})
      const settings = JSON.parse(readFileSync(join(CLAUDE_PLUGIN, 'hooks', 'hooks.json'), 'utf8'))
      expect(settings).toEqual(claudeHookSettings())
      const command = (event: string) => settings.hooks[event][0].hooks[0].command as string
      expect(command('SessionStart')).toContain('"${OSTIA_CLI}" resume-token claude -')
      expect(command('Notification')).toContain('"${OSTIA_CLI}" claude-hook Notification')
      expect(command('Stop')).toContain('"${OSTIA_CLI}" claude-hook Stop')
      expect(command('StopFailure')).toContain('"${OSTIA_CLI}" claude-hook StopFailure')
      expect(command('SubagentStart')).toContain('"${OSTIA_CLI}" claude-hook SubagentStart')
      expect(command('SubagentStop')).toContain('"${OSTIA_CLI}" claude-hook SubagentStop')
      expect(settings.hooks.PreToolUse[0].matcher).toBe('AskUserQuestion|ExitPlanMode')
      expect(command('PreToolUse')).toContain('"${OSTIA_CLI}" claude-hook PreToolUse')
      expect(command('SessionStart')).toMatch(/^\[ -n "\$\{OSTIA_SOCKET\}" \] && .*\|\| true$/)
    })

    it('adds the unread bus messages as context when a session starts and a prompt is sent', () => {
      const hooks = claudeHookSettings().hooks as Record<string, { hooks: { command: string }[] }[]>
      const commands = (event: string) => hooks[event]?.[0]?.hooks.map((h) => h.command) ?? []
      expect(commands('SessionStart')).toEqual([
        expect.stringContaining('resume-token claude -'),
        busHookCommand('SessionStart'),
      ])
      expect(commands('UserPromptSubmit')).toEqual([
        expect.stringContaining('state working'),
        busHookCommand('UserPromptSubmit'),
      ])
      expect(busHookCommand('UserPromptSubmit')).toBe(
        '[ -n "${OSTIA_SOCKET}" ] && ELECTRON_RUN_AS_NODE=1 "${OSTIA_NODE}" "${OSTIA_CLI}" bus hook UserPromptSubmit 2>/dev/null || true',
      )
      expect(commands('Stop').join(' ')).not.toContain('bus hook')
      expect(commands('Notification').join(' ')).not.toContain('bus hook')
    })

    it('asks Ostia for a permission decision and keeps the hook’s stdout for it', () => {
      const hooks = claudeHookSettings().hooks as Record<string, { hooks: { command: string }[] }[]>
      expect(hooks.PermissionRequest?.[0]?.hooks.map((h) => h.command)).toEqual([
        permissionHookCommand('claude'),
      ])
      expect(permissionHookCommand('claude')).toBe(
        '[ -n "${OSTIA_SOCKET}" ] && ELECTRON_RUN_AS_NODE=1 "${OSTIA_NODE}" "${OSTIA_CLI}" permission-hook claude 2>/dev/null || true',
      )
      expect(codexHookCommands('/tmp/codex-context.md').PermissionRequest).toEqual([
        expect.stringContaining('state waiting -'),
        permissionHookCommand('codex'),
      ])
    })

    it('makes claude in a Ostia shell load the plugin and keep the user’s arguments', () => {
      shellIntegrationSpawnOptions('/bin/bash', {})
      const bin = mkdtempSync(join(tmpdir(), 'ostia-fake-claude-'))
      try {
        const fake = join(bin, 'claude')
        writeFileSync(fake, '#!/bin/sh\nprintf "%s\\n" "$@"\n')
        chmodSync(fake, 0o755)
        const run = (script: string) =>
          spawnSync('bash', ['--norc', '-c', `source '${BASH_INIT}'; ${script}`], {
            env: {
              PATH: `${bin}:/usr/bin:/bin`,
              OSTIA_CLI: '/x/cli.js',
              OSTIA_AGENT_DIR: AGENT_DIR,
            },
            encoding: 'utf8',
          }).stdout.trim()

        expect(run('claude --resume abc').split('\n')).toEqual([
          '--plugin-dir',
          CLAUDE_PLUGIN,
          '--resume',
          'abc',
        ])
        expect(run('command claude plain')).toBe('plain')
      } finally {
        rmSync(bin, { recursive: true, force: true })
      }
    })

    it.each([
      ['bash', '--norc'],
      ['zsh', '-f'],
    ])('runs claude untouched in %s when its integration is turned off', (shell, noRc) => {
      const bin = mkdtempSync(join(tmpdir(), 'ostia-fake-claude-'))
      try {
        const fake = join(bin, 'claude')
        writeFileSync(fake, '#!/bin/sh\nprintf "%s\\n" "$@"\n')
        chmodSync(fake, 0o755)
        const wrapper = join(bin, 'wrapper.sh')
        writeFileSync(wrapper, claudeWrapper())
        const agentDir = join(bin, 'agent')
        const pluginDir = join(agentDir, 'claude-plugin')
        mkdirSync(pluginDir, { recursive: true })
        const run = (off: string) =>
          spawnSync(shell, [noRc, '-c', `source '${wrapper}'; claude --resume abc`], {
            env: {
              PATH: `${bin}:/usr/bin:/bin`,
              OSTIA_CLI: '/x/cli.js',
              OSTIA_AGENT_DIR: agentDir,
              OSTIA_NO_CLAUDE_HOOKS: off,
            },
            encoding: 'utf8',
          })
            .stdout.trim()
            .split('\n')
        expect(run('1')).toEqual(['--resume', 'abc'])
        expect(run('')).toEqual(['--plugin-dir', pluginDir, '--resume', 'abc'])
      } finally {
        rmSync(bin, { recursive: true, force: true })
      }
    })
  })

  describe('the ostia command', () => {
    it.each([
      ['bash', '--norc', BASH_INIT],
      ['zsh', '-f', ZSH_INIT],
    ])('defines ostia in %s, running the CLI', (shell, noRc, init) => {
      shellIntegrationSpawnOptions(shell, { HOME: '/home/u' })
      const dir = mkdtempSync(join(tmpdir(), 'ostia-fake-node-'))
      try {
        const node = join(dir, 'node')
        writeFileSync(node, '#!/bin/sh\nprintf "%s %s\\n" "$ELECTRON_RUN_AS_NODE" "$*"\n')
        chmodSync(node, 0o755)
        const run = (env: Record<string, string>, script: string) =>
          spawnSync(shell, [noRc, '-c', `source '${init}'; ${script}`], {
            env: { PATH: '/usr/bin:/bin', ...env },
            encoding: 'utf8',
          }).stdout.trim()

        expect(run({ OSTIA_NODE: node, OSTIA_CLI: '/new/cli.js' }, 'ostia whoami')).toBe(
          '1 /new/cli.js whoami',
        )
        expect(
          run({ OSTIA_NODE: node, OSTIA_CLI: '/new/cli.js' }, 'type pine || echo none'),
        ).toContain('none')
        expect(run({}, 'type ostia >/dev/null 2>&1 || echo none')).toBe('none')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  describe('codex hooks', () => {
    const CONTEXT = '/x/codex/session-context.md'

    it('writes the ostia skill and a session context that points Codex at it', () => {
      const dir = mkdtempSync(join(tmpdir(), 'ostia-codex-integration-'))
      try {
        const { contextFile } = writeCodexIntegration(dir)
        const skill = readFileSync(join(dir, 'SKILL.md'), 'utf8')
        expect(skill).toMatch(/^---\nname: ostia\ndescription: /)
        const context = readFileSync(contextFile, 'utf8')
        expect(context).toContain(`read its guide: ${join(dir, 'SKILL.md')}`)
        expect(context).toContain('ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" "$OSTIA_CLI"')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('maps Codex events onto the resume token, the context and the attention state', () => {
      const commands = codexHookCommands(CONTEXT)
      expect(Object.keys(commands)).toEqual([
        'SessionStart',
        'UserPromptSubmit',
        'PermissionRequest',
        'Stop',
      ])
      expect(commands.SessionStart?.[0]).toContain('"${OSTIA_CLI}" resume-token codex -')
      expect(commands.SessionStart?.[1]).toBe(
        `[ -n "\${OSTIA_SOCKET}" ] && cat '${CONTEXT}' 2>/dev/null || true`,
      )
      expect(commands.SessionStart?.[2]).toBe(busHookCommand('SessionStart'))
      expect(commands.SessionStart).toHaveLength(3)
      expect(commands.UserPromptSubmit?.[0]).toContain('state working')
      expect(commands.UserPromptSubmit).toEqual([
        commands.UserPromptSubmit?.[0],
        busHookCommand('UserPromptSubmit'),
      ])
      expect(commands.PermissionRequest?.[0]).toContain('state waiting -')
      expect(commands.Stop?.[0]).toContain('state done')
      for (const command of Object.values(commands).flat()) {
        expect(command).toMatch(/^\[ -n "\$\{OSTIA_SOCKET\}" \] && .*\|\| true$/)
      }
    })

    it('hashes a hook the way codex-cli 0.157 computes its trust hash', () => {
      const codexReference =
        '[ -n "$PINE_SOCKET" ] && ELECTRON_RUN_AS_NODE=1 "$PINE_NODE" "$PINE_CLI" state done >/dev/null 2>&1 || true'
      expect(codexHookTrustHash('Stop', codexReference)).toBe(
        'sha256:04649370ec668e17edd8c909dda94fbdf1e5a71584fe8a58896fc903e330c6b1',
      )
      const stop = codexHookCommands(CONTEXT).Stop?.[0] ?? ''
      expect(codexHookTrustHash('Stop', stop)).toBe(
        'sha256:dd0738f4d05919c023080c695b24bed2afaecc6504369bde591c15314b798eff',
      )
    })

    it('pins the trust hashes of the bus hooks, which print context', () => {
      expect(codexHookTrustHash('UserPromptSubmit', busHookCommand('UserPromptSubmit'))).toBe(
        'sha256:6d1627ffada98cdfdfb78abf5655cb545afa5bd013ae973d24dc47c10d814d96',
      )
      expect(codexHookTrustHash('SessionStart', busHookCommand('SessionStart'))).toBe(
        'sha256:c7ca4569c67b9e45236d1f3e3cc7abd741599aba67417a6efd1ef08b2b9f7447',
      )
      const state = codexHookArgs(CONTEXT).at(-1) ?? ''
      expect(state).toContain(
        '"/<session-flags>/config.toml:user_prompt_submit:0:1"={trusted_hash="sha256:6d1627ffada98cdfdfb78abf5655cb545afa5bd013ae973d24dc47c10d814d96"}',
      )
      expect(state).toContain(
        '"/<session-flags>/config.toml:session_start:0:2"={trusted_hash="sha256:c7ca4569c67b9e45236d1f3e3cc7abd741599aba67417a6efd1ef08b2b9f7447"}',
      )
    })

    it('trusts exactly the injected hooks by session-flags key and hash, never all hooks', () => {
      const args = codexHookArgs(CONTEXT)
      expect(args[0]).toBe('--no-daemon')
      expect(args).not.toContain('--dangerously-bypass-hook-trust')
      const state = args[args.length - 1]
      expect(state.startsWith('hooks.state={')).toBe(true)
      const commands = Object.entries(codexHookCommands(CONTEXT)) as [CodexHookEvent, string[]][]
      for (const [event, handlers] of commands) {
        handlers.forEach((command, index) => {
          const key = JSON.stringify(codexHookKey(event, index))
          const hash = JSON.stringify(codexHookTrustHash(event, command))
          expect(state).toContain(`${key}={trusted_hash=${hash}}`)
        })
      }
      expect(codexHookKey('SessionStart', 1)).toBe('/<session-flags>/config.toml:session_start:0:1')
    })

    describe.each([
      ['bash', '--norc'],
      ['zsh', '-f'],
    ])('the codex function in %s', (shell, noRc) => {
      let bin = ''
      let wrapper = ''

      beforeAll(() => {
        bin = mkdtempSync(join(tmpdir(), 'ostia-fake-codex-'))
        const fake = join(bin, 'codex')
        writeFileSync(fake, '#!/bin/sh\nprintf "%s\\n" "$@"\n')
        chmodSync(fake, 0o755)
        wrapper = join(bin, 'wrapper.sh')
        writeFileSync(wrapper, codexWrapper())
      })

      afterAll(() => {
        rmSync(bin, { recursive: true, force: true })
      })

      const run = (script: string, ostiaCli: string | null = '/x/cli.js') =>
        spawnSync(shell, [noRc, '-c', `source '${wrapper}'; ${script}`], {
          env: {
            PATH: `${bin}:/usr/bin:/bin`,
            OSTIA_AGENT_DIR: AGENT_DIR,
            ...(ostiaCli ? { OSTIA_CLI: ostiaCli } : {}),
          },
          encoding: 'utf8',
        })
          .stdout.trim()
          .split('\n')
      const quote = (args: string[]) => args.map((arg) => `'${arg}'`).join(' ')

      it.each([
        [[]],
        [['fix the tests']],
        [['-m', 'gpt-5', '-c', 'model_reasoning_effort="high"', 'fix it']],
        [['resume', '01a0f04c-15fd-7b22-8538-ca8250a46988']],
        [['resume', '--last']],
        [['--sandbox', 'workspace-write', 'resume']],
        [['fork', '--last']],
        [['--', 'exec']],
      ])('injects the Ostia hooks for an interactive session: codex %j', (args) => {
        const out = run(`codex ${quote(args)}`)
        expect(out).toEqual([
          ...codexHookArgs(join(AGENT_DIR, 'codex', 'session-context.md')),
          ...args,
        ])
      })

      it.each([
        [['exec', 'fix it']],
        [['e', 'fix it']],
        [['login']],
        [['mcp', 'list']],
        [['review']],
        [['-m', 'gpt-5', 'exec', 'fix it']],
        [['--help']],
        [['--version']],
      ])('passes codex %j through untouched', (args) => {
        expect(run(`codex ${quote(args)}`)).toEqual(args)
      })

      it('runs codex untouched when its hooks are turned off', () => {
        const out = spawnSync(shell, [noRc, '-c', `source '${wrapper}'; codex 'fix it'`], {
          env: { PATH: `${bin}:/usr/bin:/bin`, OSTIA_CLI: '/x/cli.js', OSTIA_NO_CODEX_HOOKS: '1' },
          encoding: 'utf8',
        }).stdout.trim()
        expect(out).toBe('fix it')
      })

      it('lets command codex bypass Ostia', () => {
        expect(run('command codex resume abc')).toEqual(['resume', 'abc'])
      })

      it('defines no codex function outside a Ostia pane', () => {
        expect(run('codex resume abc', null)).toEqual(['resume', 'abc'])
      })
    })
  })
  describe('extension agent plugins', () => {
    let root = ''
    const CONTEXT = '/x/codex/session-context.md'
    const toolHook = { extId: 'kit', event: 'PreToolUse' as const, command: 'on-tool' }
    const content: AgentPluginContent = {
      skills: [
        {
          id: 'kit-review',
          description: 'Use when\nreviewing.',
          files: [
            { name: 'SKILL.md', data: Buffer.from('---\nname: kit-review\n---\n') },
            { name: 'checklist.md', data: Buffer.from('- tests\n') },
          ],
        },
      ],
      hooks: [
        { extId: 'kit', event: 'SessionStart', command: 'on-hook' },
        toolHook,
        { extId: 'kit', event: 'Notification', command: 'on-hook' },
      ],
    }

    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), 'ostia-agent-plugins-'))
    })

    afterAll(() => {
      rmSync(root, { recursive: true, force: true })
    })

    it('runs the extension’s own command through the ostia CLI, never a shell string of its own', () => {
      expect(
        extensionHookCommand({ extId: 'kit', event: 'PreToolUse', command: 'on-tool' }, 'codex'),
      ).toBe(
        '[ -n "${OSTIA_SOCKET}" ] && ELECTRON_RUN_AS_NODE=1 "${OSTIA_NODE}" "${OSTIA_CLI}" agent-hook kit on-tool codex PreToolUse 2>/dev/null || true',
      )
    })

    it('adds extension hooks after Ostia’s own, for the agents that have the event', () => {
      const hooks = claudeHookSettings(content.hooks).hooks as Record<
        string,
        { hooks: { command: string }[] }[]
      >
      const commands = (event: string) => hooks[event]?.[0]?.hooks.map((h) => h.command) ?? []
      expect(commands('SessionStart')).toHaveLength(3)
      expect(commands('SessionStart')[0]).toContain('resume-token claude -')
      expect(commands('SessionStart')[1]).toBe(busHookCommand('SessionStart'))
      expect(commands('SessionStart')[2]).toContain('agent-hook kit on-hook claude SessionStart')
      expect(hooks.PreToolUse[1].hooks.map((h) => h.command)).toEqual([
        extensionHookCommand(toolHook, 'claude'),
      ])
      expect(commands('Notification')[1]).toContain('agent-hook kit on-hook claude Notification')
      const codex = codexHookCommands(CONTEXT, content.hooks)
      expect(codex.PreToolUse).toEqual([extensionHookCommand(toolHook, 'codex')])
      expect(JSON.stringify(codex)).not.toContain('Notification')
      expect(claudeHookSettings().hooks.PreToolUse).toHaveLength(1)
    })

    it('trusts each extension hook by its own Codex hash and handler index', () => {
      const args = codexHookArgs(CONTEXT, content.hooks)
      const state = args[args.length - 1] ?? ''
      const sessionStart = codexHookCommands(CONTEXT, content.hooks).SessionStart ?? []
      expect(sessionStart).toHaveLength(4)
      const hook = sessionStart[3] ?? ''
      expect(state).toContain(
        `${JSON.stringify(codexHookKey('SessionStart', 3))}={trusted_hash=${JSON.stringify(codexHookTrustHash('SessionStart', hook))}}`,
      )
      expect(codexHookKey('PreToolUse', 0)).toBe('/<session-flags>/config.toml:pre_tool_use:0:0')
      expect(args).not.toContain('--dangerously-bypass-hook-trust')
    })

    it('writes one folder per content, with the skills for claude and codex', () => {
      const dir = writeAgentPlugin(root, content)
      expect(writeAgentPlugin(root, content)).toBe(dir)
      expect(writeAgentPlugin(root, { skills: [], hooks: [] })).not.toBe(dir)
      const plugin = join(dir, 'claude-plugin')
      expect(readFileSync(join(plugin, 'skills', 'kit-review', 'checklist.md'), 'utf8')).toBe(
        '- tests\n',
      )
      expect(readFileSync(join(plugin, 'skills', 'ostia', 'SKILL.md'), 'utf8')).toMatch(
        /^---\nname: ostia/,
      )
      expect(JSON.parse(readFileSync(join(plugin, 'hooks', 'hooks.json'), 'utf8'))).toEqual(
        claudeHookSettings(content.hooks),
      )
      const codexDir = join(dir, 'codex')
      const context = readFileSync(join(codexDir, 'session-context.md'), 'utf8')
      expect(context).toContain(
        `- kit-review (${join(codexDir, 'skills', 'kit-review', 'SKILL.md')}): Use when reviewing.`,
      )
      expect(existsSync(join(codexDir, 'skills', 'kit-review', 'checklist.md'))).toBe(true)
    })

    it.skipIf(process.getuid?.() === 0)(
      'returns an existing generation without writing anything under the root',
      () => {
        const dir = writeAgentPlugin(root, content)
        const file = join(dir, 'claude-plugin', 'skills', 'kit-review', 'checklist.md')
        writeFileSync(file, 'edited\n')
        chmodSync(root, 0o500)
        try {
          expect(writeAgentPlugin(root, content)).toBe(dir)
        } finally {
          chmodSync(root, 0o700)
        }
        expect(readFileSync(file, 'utf8')).toBe('edited\n')
      },
    )

    it('hands a shell exactly the Codex args it trusts, quoted', () => {
      const dir = writeAgentPlugin(root, content)
      const out = spawnSync(
        'bash',
        [
          '--norc',
          '-c',
          `. '${join(dir, 'codex', 'hook-args.sh')}'; printf '%s\\n' "\${__ostia_codex_hook_args[@]}"`,
        ],
        { encoding: 'utf8' },
      ).stdout
      expect(out.trimEnd().split('\n')).toEqual(
        codexHookArgs(join(dir, 'codex', 'session-context.md'), content.hooks),
      )
    })
  })
})
