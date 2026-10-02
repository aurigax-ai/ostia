import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { privateTmpDir } from './privateTmp'
import { type ShellState, parseShellState } from './shellCommands'
import {
  CLAUDE_PLUGIN_MANIFEST,
  type CodexHookEvent,
  claudeHookSettings,
  codexHookArgs,
  codexHookCommands,
  codexHookKey,
  codexHookTrustHash,
  codexWrapper,
  shellIntegrationSpawnOptions,
  writeCodexIntegration,
} from './shellIntegration'

const INTEGRATION_DIR = privateTmpDir('pine-shell-integration')
const ZSH_INIT = join(INTEGRATION_DIR, 'init.zsh')
const ZSH_ENV = join(INTEGRATION_DIR, '.zshenv')
const ZSH_RC = join(INTEGRATION_DIR, '.zshrc')
const BASH_INIT = join(INTEGRATION_DIR, 'init.bash')
const BASH_RC = join(INTEGRATION_DIR, 'bashrc')
const CLAUDE_PLUGIN = join(INTEGRATION_DIR, 'claude-plugin')

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

  describe('Pine prompt', () => {
    it('asks zsh and bash for the plain prompt through the environment only when enabled', () => {
      const split = { separator: '$' as const, sameLine: false }
      const inline = { separator: 'none' as const, sameLine: true }
      expect(shellIntegrationSpawnOptions('zsh', { HOME: '/home/u' }, split).env).toMatchObject({
        PINE_PROMPT: 'pine',
        PINE_PROMPT_SEPARATOR: '$',
        PINE_PROMPT_LINES: '2',
      })
      expect(shellIntegrationSpawnOptions('/bin/bash', {}, inline).env).toEqual({
        PINE_PROMPT: 'pine',
        PINE_PROMPT_SEPARATOR: 'none',
        PINE_PROMPT_LINES: '1',
      })
      expect(shellIntegrationSpawnOptions('zsh', { HOME: '/home/u' }).env).not.toHaveProperty(
        'PINE_PROMPT',
      )
      expect(shellIntegrationSpawnOptions('/bin/bash', {}, null).env).toEqual({})
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
            '__pine_precmd >/dev/null',
            '__pine_precmd >/dev/null',
            'print -rn -- "$torn|$PROMPT|$RPROMPT|$PINE_PROMPT"',
          ].join('; '),
          env,
        ).stdout

      it('puts the input on its own line under the cwd when the chips have their own row', () => {
        expect(
          prompt({ PINE_PROMPT: 'pine', PINE_PROMPT_SEPARATOR: '$', PINE_PROMPT_LINES: '2' }),
        ).toBe(`1|%~\n$ %{${B_MARK}%}||`)
        expect(
          prompt({ PINE_PROMPT: 'pine', PINE_PROMPT_SEPARATOR: 'none', PINE_PROMPT_LINES: '2' }),
        ).toBe(`1|%~\n%{${B_MARK}%}||`)
      })

      it('replaces the prompt with the cwd and separator, clears RPROMPT and keeps the B mark', () => {
        expect(prompt({ PINE_PROMPT: 'pine', PINE_PROMPT_SEPARATOR: '%' })).toBe(
          `1|%~ %% %{${B_MARK}%}||`,
        )
        expect(prompt({ PINE_PROMPT: 'pine', PINE_PROMPT_SEPARATOR: '$' })).toBe(
          `1|%~ $ %{${B_MARK}%}||`,
        )
        expect(prompt({ PINE_PROMPT: 'pine', PINE_PROMPT_SEPARATOR: 'none' })).toBe(
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
              '__pine_precmd >/dev/null',
              'print -rn -- "|$torn"',
            ].join('; '),
          ],
          {
            env: { PATH: '/usr/bin:/bin', HOME: '/home/u', PINE_PROMPT: 'pine' },
            encoding: 'utf8',
          },
        ).stdout
        expect(out).toBe('1|%~ |1')
      })

      it('turns the powerlevel10k instant prompt off for the user’s rc only with the Pine prompt', () => {
        const home = mkdtempSync(join(tmpdir(), 'pine-zsh-home-'))
        try {
          writeFileSync(
            join(home, '.zshrc'),
            'print -rn -- "instant=${POWERLEVEL9K_INSTANT_PROMPT-unset}"\n',
          )
          const seen = (pinePrompt: Record<string, string>): string => {
            const { env } = shellIntegrationSpawnOptions('zsh', { HOME: home })
            return spawnSync('zsh', ['-i', '-c', 'true'], {
              env: { PATH: '/usr/bin:/bin', HOME: home, ...env, ...pinePrompt },
              encoding: 'utf8',
            }).stdout
          }
          expect(seen({ PINE_PROMPT: 'pine' })).toContain('instant=off')
          expect(seen({})).toContain('instant=unset')
        } finally {
          rmSync(home, { recursive: true, force: true })
        }
      })

      it('leaves the user’s prompt alone when the Pine prompt is off', () => {
        expect(prompt({})).toBe(`0|user> %{${B_MARK}%}|right|`)
      })

      it('renders the plain prompt as the home-abbreviated cwd', () => {
        const out = run(
          'zsh',
          ZSH_INIT,
          'HOME=$PWD; __pine_precmd >/dev/null; print -rn -- "${(%)PROMPT}"',
          { PINE_PROMPT: 'pine', PINE_PROMPT_SEPARATOR: '>' },
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
            `__pine_orig_prompt_command=("PS1='framework> '")`,
            '__pine_prompt_command >/dev/null',
            'printf "|%s|%s" "$PS1" "$PINE_PROMPT"',
          ].join('; '),
          env,
        ).stdout
        return out.slice(out.indexOf('|'))
      }

      it('sets PS1 to the cwd and separator after the user’s PROMPT_COMMAND and keeps the B mark', () => {
        expect(ps1({ PINE_PROMPT: 'pine', PINE_PROMPT_SEPARATOR: '>' })).toBe(
          `|\\w > ${BASH_B_MARK}|`,
        )
        expect(ps1({ PINE_PROMPT: 'pine', PINE_PROMPT_SEPARATOR: 'none' })).toBe(
          `|\\w ${BASH_B_MARK}|`,
        )
      })

      it('puts the input on its own line under the cwd when the chips have their own row', () => {
        expect(
          ps1({ PINE_PROMPT: 'pine', PINE_PROMPT_SEPARATOR: '>', PINE_PROMPT_LINES: '2' }),
        ).toBe(`|\\w\\n> ${BASH_B_MARK}|`)
      })

      it('keeps the framework’s PS1 when the Pine prompt is off', () => {
        expect(ps1({})).toBe(`|framework> ${BASH_B_MARK}|`)
      })
    })
  })

  describe('scratch history', () => {
    let home: string
    beforeAll(() => {
      home = mkdtempSync(join(tmpdir(), 'pine-histfile-home-'))
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
        expect.objectContaining({ PINE_HISTFILE: '/tmp/s/h' }),
      )
      expect(shellIntegrationSpawnOptions('bash', { HOME: home }, null, '/tmp/s/h').env).toEqual({
        PINE_HISTFILE: '/tmp/s/h',
      })
      expect(shellIntegrationSpawnOptions('zsh', { HOME: home }).env).not.toHaveProperty(
        'PINE_HISTFILE',
      )
    })

    it.each(['zsh', 'bash'] as const)(
      'points %s HISTFILE at the scratch folder after the user rc set its own',
      (shell) => {
        const scratch = join(home, 'scratch', '.pine_history')
        expect(histfileOf(shell, scratch)).toBe(scratch)
      },
    )

    it.each(['zsh', 'bash'] as const)('leaves the user HISTFILE alone in %s otherwise', (shell) => {
      expect(histfileOf(shell, null)).toBe(join(home, `.${shell}_history`))
    })

    it('keeps an interactive zsh from reading or writing the user history', () => {
      const scratch = mkdtempSync(join(tmpdir(), 'pine-histfile-scratch-'))
      const histFile = join(scratch, '.pine_history')
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

    it('marks only real commands when the user’s PROMPT_COMMAND is an array', () => {
      shellIntegrationSpawnOptions('/bin/bash', {})
      const dir = mkdtempSync(join(tmpdir(), 'pine-bash-array-'))
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

    describe.each([
      ['bash', ['--norc'], BASH_INIT],
      ['zsh', ['-f'], ZSH_INIT],
    ])('%s reports its PATH and command names', (shell, noRc, init) => {
      let dir = ''
      let stateFile = ''

      beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), 'pine-shell-state-'))
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
            `source '${init}'; alias pine_ll='ls'; pine_fn() { :; }; _pine_private() { :; }; ${script}`,
          ],
          {
            env: {
              PATH: '/pine/bin:/usr/bin:/bin',
              HOME: '/home/u',
              ...(state ? { PINE_SHELL_STATE: state } : {}),
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
        expect(report('__pine_report_shell')).toBe('')
        const { path, names } = readState()
        expect(path).toBe('/pine/bin:/usr/bin:/bin')
        expect(names).toEqual(expect.arrayContaining(['cd', 'if', 'pine_ll', 'pine_fn']))
        expect(names).not.toContain('_pine_private')
        expect(names).not.toContain('__pine_report_shell')
      })

      it('rewrites the file only when the PATH or the names changed', () => {
        const out = report(
          [
            '__pine_report_shell',
            'rm -f "$PINE_SHELL_STATE"',
            '__pine_report_shell',
            '[ -e "$PINE_SHELL_STATE" ] && echo rewritten',
            'PATH=/x:$PATH',
            '__pine_report_shell',
          ].join('; '),
        )
        expect(out).toBe('')
        expect(readState().path).toBe('/x:/pine/bin:/usr/bin:/bin')
      })

      it('reports the virtualenv, conda env and KUBECONFIG, and rewrites when they change', () => {
        expect(readStateAfter('__pine_report_shell')).toMatchObject({
          virtualEnv: null,
          condaEnv: null,
          kubeconfig: null,
        })
        const out = report(
          [
            '__pine_report_shell',
            'export VIRTUAL_ENV=/home/u/proj/.venv CONDA_DEFAULT_ENV=base KUBECONFIG=/k/a:/k/b',
            '__pine_report_shell',
          ].join('; '),
        )
        expect(out).toBe('')
        expect(readState()).toMatchObject({
          path: '/pine/bin:/usr/bin:/bin',
          virtualEnv: '/home/u/proj/.venv',
          condaEnv: 'base',
          kubeconfig: '/k/a:/k/b',
        })
        expect(readState().names).toEqual(expect.arrayContaining(['cd', 'pine_fn']))
      })

      it('drops newlines from a reported variable so it cannot shift the lines after it', () => {
        report('__pine_report_shell', stateFile, { CONDA_DEFAULT_ENV: 'a\nb' })
        expect(readState()).toMatchObject({ condaEnv: 'ab', kubeconfig: null })
      })

      it('does nothing outside a Pine pane', () => {
        expect(report('__pine_report_shell', null)).toBe('')
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
    it('writes a Claude Code plugin with the pine skill and its manifest', () => {
      shellIntegrationSpawnOptions('/bin/bash', {})
      const manifest = JSON.parse(
        readFileSync(join(CLAUDE_PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8'),
      )
      expect(manifest).toEqual(CLAUDE_PLUGIN_MANIFEST)
      const skill = readFileSync(join(CLAUDE_PLUGIN, 'skills', 'pine', 'SKILL.md'), 'utf8')
      expect(skill).toMatch(/^---\nname: pine\ndescription: /)
      expect(skill).toContain('ELECTRON_RUN_AS_NODE=1 "$PINE_NODE" "$PINE_CLI"')
    })

    it('writes Claude Code hooks that record the resume token and attention state', () => {
      shellIntegrationSpawnOptions('/bin/bash', {})
      const settings = JSON.parse(readFileSync(join(CLAUDE_PLUGIN, 'hooks', 'hooks.json'), 'utf8'))
      expect(settings).toEqual(claudeHookSettings())
      const command = (event: string) => settings.hooks[event][0].hooks[0].command as string
      expect(command('SessionStart')).toContain('"$PINE_CLI" resume-token claude -')
      expect(command('Notification')).toContain('state waiting -')
      expect(command('Stop')).toContain('state done')
      expect(command('SessionStart')).toMatch(/^\[ -n "\$PINE_SOCKET" \] && .*\|\| true$/)
    })

    it('makes claude in a Pine shell load the plugin and keep the user’s arguments', () => {
      shellIntegrationSpawnOptions('/bin/bash', {})
      const bin = mkdtempSync(join(tmpdir(), 'pine-fake-claude-'))
      try {
        const fake = join(bin, 'claude')
        writeFileSync(fake, '#!/bin/sh\nprintf "%s\\n" "$@"\n')
        chmodSync(fake, 0o755)
        const run = (script: string) =>
          spawnSync('bash', ['--norc', '-c', `source '${BASH_INIT}'; ${script}`], {
            env: { PATH: `${bin}:/usr/bin:/bin`, PINE_CLI: '/x/cli.js' },
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
  })

  describe('codex hooks', () => {
    const CONTEXT = '/x/codex/session-context.md'

    it('writes the pine skill and a session context that points Codex at it', () => {
      const dir = mkdtempSync(join(tmpdir(), 'pine-codex-integration-'))
      try {
        const { contextFile } = writeCodexIntegration(dir)
        const skill = readFileSync(join(dir, 'SKILL.md'), 'utf8')
        expect(skill).toMatch(/^---\nname: pine\ndescription: /)
        const context = readFileSync(contextFile, 'utf8')
        expect(context).toContain(`read its guide: ${join(dir, 'SKILL.md')}`)
        expect(context).toContain('ELECTRON_RUN_AS_NODE=1 "$PINE_NODE" "$PINE_CLI"')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('maps Codex events onto the resume token, the context and the attention state', () => {
      const commands = codexHookCommands(CONTEXT)
      expect(commands.SessionStart[0]).toContain('"$PINE_CLI" resume-token codex -')
      expect(commands.SessionStart[1]).toBe(
        `[ -n "$PINE_SOCKET" ] && cat '${CONTEXT}' 2>/dev/null || true`,
      )
      expect(commands.UserPromptSubmit[0]).toContain('state working')
      expect(commands.PermissionRequest[0]).toContain('state waiting -')
      expect(commands.Stop[0]).toContain('state done')
      for (const command of Object.values(commands).flat()) {
        expect(command).toMatch(/^\[ -n "\$PINE_SOCKET" \] && .*\|\| true$/)
      }
    })

    it('hashes a hook the way codex-cli 0.157 computes its trust hash', () => {
      const stop = codexHookCommands(CONTEXT).Stop[0]
      expect(codexHookTrustHash('Stop', stop)).toBe(
        'sha256:04649370ec668e17edd8c909dda94fbdf1e5a71584fe8a58896fc903e330c6b1',
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
        bin = mkdtempSync(join(tmpdir(), 'pine-fake-codex-'))
        const fake = join(bin, 'codex')
        writeFileSync(fake, '#!/bin/sh\nprintf "%s\\n" "$@"\n')
        chmodSync(fake, 0o755)
        wrapper = join(bin, 'wrapper.sh')
        writeFileSync(wrapper, codexWrapper(CONTEXT))
      })

      afterAll(() => {
        rmSync(bin, { recursive: true, force: true })
      })

      const run = (script: string, pineCli: string | null = '/x/cli.js') =>
        spawnSync(shell, [noRc, '-c', `source '${wrapper}'; ${script}`], {
          env: { PATH: `${bin}:/usr/bin:/bin`, ...(pineCli ? { PINE_CLI: pineCli } : {}) },
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
      ])('injects the Pine hooks for an interactive session: codex %j', (args) => {
        const out = run(`codex ${quote(args)}`)
        expect(out).toEqual([...codexHookArgs(CONTEXT), ...args])
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

      it('lets command codex bypass Pine', () => {
        expect(run('command codex resume abc')).toEqual(['resume', 'abc'])
      })

      it('defines no codex function outside a Pine pane', () => {
        expect(run('codex resume abc', null)).toEqual(['resume', 'abc'])
      })
    })
  })
})
