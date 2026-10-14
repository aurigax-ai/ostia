import { describe, expect, it } from 'vitest'
import {
  AGENT_ARGS_SEPARATOR,
  capturedArgs,
  commandLineEnv,
  looksSecret,
  resumeFlags,
  safeEnv,
  shellQuote,
} from './agentLaunch'

describe('resumeFlags for claude', () => {
  it('keeps the agent, model, effort and permission flags in both spellings', () => {
    expect(
      resumeFlags('claude', [
        '--agent',
        'ostia',
        '--model=opus',
        '--effort',
        'high',
        '--permission-mode',
        'acceptEdits',
        '--dangerously-skip-permissions',
      ]),
    ).toEqual([
      '--agent',
      'ostia',
      '--model',
      'opus',
      '--effort',
      'high',
      '--permission-mode',
      'acceptEdits',
      '--dangerously-skip-permissions',
    ])
  })

  it('keeps the shape a coordinator starts a line with', () => {
    expect(
      resumeFlags('claude', [
        '--agent',
        'twai-yushan',
        '-n',
        'Slack 推播上線',
        '--dangerously-skip-permissions',
      ]),
    ).toEqual([
      '--agent',
      'twai-yushan',
      '--name',
      'Slack 推播上線',
      '--dangerously-skip-permissions',
    ])
    expect(resumeFlags('claude', ['--name=修 probe'])).toEqual(['--name', '修 probe'])
  })

  it('drops the prompt, print mode, an old session and flags that conflict with resume', () => {
    expect(
      resumeFlags('claude', [
        '-p',
        '--resume',
        'old-id',
        '-r',
        '--continue',
        '-c',
        '--session-id',
        '0b7c6a52-1111-2222-3333-444455556666',
        '--fork-session',
        '--from-pr',
        '12',
        '--output-format',
        'json',
        '--model',
        'sonnet',
        'fix the tests',
      ]),
    ).toEqual(['--model', 'sonnet'])
  })

  it('stops at -- and treats everything after it as the prompt', () => {
    expect(resumeFlags('claude', ['--verbose', '--', '--model', 'opus'])).toEqual(['--verbose'])
  })

  it('keeps list and optional-value flags only when their value is attached, so a prompt is never stored', () => {
    expect(
      resumeFlags('claude', [
        '--add-dir=/a',
        '--allowedTools=Bash(git *)',
        '--debug=api,hooks',
        '-dhooks',
        '-d',
        '--bare',
      ]),
    ).toEqual([
      '--add-dir=/a',
      '--allowedTools=Bash(git *)',
      '--debug=api,hooks',
      '--debug=hooks',
      '--debug',
      '--bare',
    ])
    for (const argv of [
      ['--add-dir', '/a', 'fix the login bug'],
      ['--mcp-config', 'servers.json', 'fix the login bug'],
      ['--allowedTools', 'Edit', 'fix the login bug'],
      ['--debug', 'fix the login bug'],
      ['-d', 'fix the login bug'],
    ]) {
      expect(resumeFlags('claude', [...argv, '--model', 'opus'])).toEqual(['--model', 'opus'])
    }
    expect(resumeFlags('claude', ['--debug'])).toEqual(['--debug'])
  })

  it('reads back the flags it replays the same way', () => {
    const once = resumeFlags('claude', [
      '--add-dir=/a b',
      '--debug=api',
      '--model',
      'opus',
      '-n',
      'x',
    ])
    expect(resumeFlags('claude', once)).toEqual(once)
  })

  it('drops inline JSON settings, agents and MCP servers, which can carry hooks or keys', () => {
    expect(
      resumeFlags('claude', [
        '--settings',
        '{"hooks":{"SessionStart":[]}}',
        '--agents',
        ' {"a":{}}',
        '--mcp-config={"mcpServers":{}}',
        '--settings',
        '/home/u/settings.json',
      ]),
    ).toEqual(['--settings', '/home/u/settings.json'])
  })

  it('drops a flag that carries a secret, a control character or a value that is too long', () => {
    expect(
      resumeFlags('claude', [
        '--settings',
        '{"env":{"GITHUB_TOKEN":"x"}}',
        '--append-system-prompt',
        'a\u001bb',
        '--system-prompt',
        'x'.repeat(2049),
        '--agent',
        'ostia',
      ]),
    ).toEqual(['--agent', 'ostia'])
  })

  it('drops a value flag that has no value and a boolean flag given one', () => {
    expect(resumeFlags('claude', ['--verbose=yes', '--model'])).toEqual([])
  })

  it('keeps whole flags only, up to the size limit', () => {
    const many = Array.from({ length: 40 }, () => ['--agent', 'a']).flat()
    const out = resumeFlags('claude', many)
    expect(out.length).toBe(64)
    expect(out.at(-2)).toBe('--agent')
  })
})

describe('resumeFlags for codex', () => {
  it('keeps config, model, profile, sandbox and approval flags, short or long', () => {
    expect(
      resumeFlags('codex', [
        '-m',
        'gpt-5',
        '-c',
        'model_reasoning_effort="high"',
        '-pwork',
        '--sandbox=workspace-write',
        '-a',
        'never',
        '--search',
        'fix it',
      ]),
    ).toEqual([
      '-m',
      'gpt-5',
      '-c',
      'model_reasoning_effort="high"',
      '-p',
      'work',
      '--sandbox',
      'workspace-write',
      '-a',
      'never',
      '--search',
    ])
  })

  it('drops the resume and fork subcommands with their session, the prompt, images and the folder', () => {
    expect(
      resumeFlags('codex', [
        'resume',
        '01a0f04c-15fd-7b22-8538-ca8250a46988',
        '--last',
        '--all',
        '-i',
        'shot.png',
        '-C',
        '/elsewhere',
        '--worktree',
        '-m',
        'gpt-5',
        'continue',
      ]),
    ).toEqual(['-m', 'gpt-5'])
    expect(resumeFlags('codex', ['fork', '--last', '--oss'])).toEqual(['--oss'])
  })

  it('drops a config override that holds a key, a password or an environment', () => {
    for (const config of [
      'model_providers.x.api_key="abc"',
      'mcp_servers.gh.env.GH="x"',
      'env.FOO="bar"',
      'shell_environment_policy.set.DB_PW="x"',
      'x.password="x"',
      'x.pin="1234"',
    ]) {
      expect(resumeFlags('codex', ['-c', config, '--oss']), config).toEqual(['--oss'])
      expect(resumeFlags('codex', [`--config=${config}`, '--oss']), config).toEqual(['--oss'])
    }
    expect(resumeFlags('codex', ['-c', 'environment_name="x"'])).toEqual([
      '-c',
      'environment_name="x"',
    ])
  })

  it('replays only flags codex resume accepts, never one the hook args already pass', () => {
    expect(resumeFlags('codex', ['--yolo', '--no-daemon', '--full-auto', '--last'])).toEqual([
      '--yolo',
    ])
  })
})

describe('capturedArgs', () => {
  it('reads the arguments the shell function recorded for that agent only', () => {
    const env = {
      OSTIA_CLAUDE_ARGS: ['--agent', 'two words', 'say hi'].join(AGENT_ARGS_SEPARATOR),
    }
    expect(capturedArgs('claude', env)).toEqual(['--agent', 'two words'])
    expect(capturedArgs('codex', env)).toBeNull()
    expect(capturedArgs('claude', { OSTIA_CLAUDE_ARGS: '' })).toEqual([])
    expect(capturedArgs('claude', {})).toBeNull()
  })
})

describe('commandLineEnv', () => {
  it('reads the variables assigned in front of the agent', () => {
    expect(commandLineEnv('claude', 'GL_ISSUE=685 MODE="fast mode" claude --agent x')).toEqual({
      GL_ISSUE: '685',
      MODE: 'fast mode',
    })
    expect(commandLineEnv('codex', "  NOTE='it'\\''s' codex")).toEqual({ NOTE: "it's" })
    expect(commandLineEnv('claude', 'GL_ISSUE=tracker#1 claude "hello"')).toEqual({
      GL_ISSUE: 'tracker#1',
    })
    expect(commandLineEnv('claude', 'claude')).toEqual({})
  })

  it('keeps the config directory typed in front of the agent', () => {
    expect(
      commandLineEnv(
        'claude',
        `CLAUDE_CONFIG_DIR='/Users/j/.claude-profiles/twai' GL_ISSUE='665#2' claude --agent research`,
      ),
    ).toEqual({ CLAUDE_CONFIG_DIR: '/Users/j/.claude-profiles/twai', GL_ISSUE: '665#2' })
    expect(commandLineEnv('codex', 'CODEX_HOME=/Users/j/.codex-work HOME=/tmp/h codex')).toEqual({
      CODEX_HOME: '/Users/j/.codex-work',
    })
  })

  it('reads a single-quoted value with a hash, as process run passes it', () => {
    expect(
      commandLineEnv(
        'claude',
        `GL_ISSUE='665#2' claude --agent twai-yushan -n "Slack 推播上線" --dangerously-skip-permissions`,
      ),
    ).toEqual({ GL_ISSUE: '665#2' })
  })

  it('returns null when the line does not start the agent itself', () => {
    expect(commandLineEnv('claude', 'cd x && GL_ISSUE=1 claude')).toBeNull()
    expect(commandLineEnv('claude', 'GL_ISSUE=1 cc')).toBeNull()
    expect(commandLineEnv('claude', 'GL_ISSUE=1 codex')).toBeNull()
    expect(commandLineEnv('claude', "'claude'")).toBeNull()
    expect(commandLineEnv('claude', 'A=1; claude')).toBeNull()
    expect(
      commandLineEnv(
        'claude',
        `(ostia workspace group 'Home' >/dev/null 2>&1 || true) && claude --agent homelab -n "修 probe"`,
      ),
    ).toBeNull()
    expect(
      commandLineEnv('claude', `cd '/w' && (true) && claude --agent personal -n "整理帳單"`),
    ).toBeNull()
    expect(commandLineEnv('claude', 'A="open claude')).toBeNull()
    expect(commandLineEnv('claude', '')).toBeNull()
  })

  it('skips a value that starts with an unquoted tilde, which the shell expands', () => {
    expect(commandLineEnv('claude', `A=~/x B='~/y' claude`)).toEqual({ B: '~/y' })
  })

  it('skips values that expand at run time', () => {
    expect(
      commandLineEnv('claude', 'A=$HOME B="$(id)" C=`id` D=*.ts E=ok claude --model opus'),
    ).toEqual({ E: 'ok' })
  })

  it('never keeps a secret', () => {
    expect(
      commandLineEnv(
        'claude',
        `ANTHROPIC_API_KEY=s${'k'}-ant-${'ab12'.repeat(5)} GH_TOKEN=x DB=postgres://u:${'pw'}@h/db OK=1 claude`,
      ),
    ).toEqual({ OK: '1' })
  })
})

describe('safeEnv', () => {
  it('keeps plain variables and drops secret names, Ostia variables and bad values', () => {
    expect(
      safeEnv({
        GL_ISSUE: '685',
        MY_PASSWORD: 'x',
        DB_PASS: 'x',
        MYSQL_PWD: 'x',
        SIM_PIN: '1',
        DB_PW: 'x',
        NODE_OPTIONS: '--require /tmp/x.js',
        DYLD_INSERT_LIBRARIES: '/tmp/x.dylib',
        LD_PRELOAD: '/tmp/x.so',
        BASH_ENV: '/tmp/x',
        PATH: '/tmp',
        SPINNER: 'dots',
        HOME: '/tmp/h',
        XDG_CONFIG_HOME: '/tmp/x',
        XDG_DATA_HOME: '/tmp/x',
        JAVA_TOOL_OPTIONS: '-javaagent:/tmp/a.jar',
        GIT_CONFIG_GLOBAL: '/tmp/g',
        GIT_CONFIG_COUNT: '1',
        EDITOR: '/tmp/e',
        VISUAL: '/tmp/e',
        PAGER: '/tmp/p',
        AWS_SECRET_ACCESS_KEY: 'x',
        OSTIA_SOCKET: '/tmp/s',
        'BAD-NAME': '1',
        LONG: 'x'.repeat(1025),
        CTRL: 'a\nb',
        NUM: 5,
      }),
    ).toEqual({ GL_ISSUE: '685', SPINNER: 'dots' })
    expect(safeEnv(['A'])).toEqual({})
    expect(safeEnv(null)).toEqual({})
  })

  it('keeps the variables that pick the agent account and still drops the ones beside them', () => {
    expect(
      safeEnv({
        CLAUDE_CONFIG_DIR: '/Users/j/.claude-profiles/twai',
        CODEX_HOME: '/Users/j/.codex-work',
        HOME: '/tmp/h',
        PATH: '/tmp',
        XDG_CONFIG_HOME: '/tmp/x',
        LD_PRELOAD: '/tmp/x.so',
        DYLD_INSERT_LIBRARIES: '/tmp/x.dylib',
        EDITOR: '/tmp/e',
        CLAUDE_CODE_USE_BEDROCK: '1',
        CODEX_SANDBOX: 'seatbelt',
      }),
    ).toEqual({
      CLAUDE_CONFIG_DIR: '/Users/j/.claude-profiles/twai',
      CODEX_HOME: '/Users/j/.codex-work',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CODEX_SANDBOX: 'seatbelt',
    })
  })

  it('keeps the account folders only as absolute paths', () => {
    for (const value of ['./x', 'x', '../profiles/a', '~/.claude', '']) {
      expect(safeEnv({ CLAUDE_CONFIG_DIR: value, CODEX_HOME: value })).toEqual({})
    }
    expect(
      safeEnv({ CLAUDE_CONFIG_DIR: '/home/j/.claude-b', CODEX_HOME: 'C:\\Users\\j\\.codex' }),
    ).toEqual({
      CLAUDE_CONFIG_DIR: '/home/j/.claude-b',
      CODEX_HOME: 'C:\\Users\\j\\.codex',
    })
  })
})

describe('looksSecret', () => {
  it('spots common token shapes and leaves paths and ids alone', () => {
    for (const text of [
      `gh${'p'}_${'a1'.repeat(15)}`,
      `gl${'pat'}-abc`,
      `xo${'xb'}-1-2`,
      `AK${'IA'}${'B'.repeat(16)}`,
      `ey${'J'}hbGciOiJIUzI1NiJ9.payload`,
      `https://user:${'pass'}@example.com`,
      'A'.repeat(40),
    ]) {
      expect(looksSecret(text)).toBe(true)
    }
    for (const text of [
      '/Users/someone/Projects/AurigaX/ostia-685/worktrees/fix',
      '0b7c6a52-1111-2222-3333-444455556666',
      'opus',
      'model_reasoning_effort="high"',
    ]) {
      expect(looksSecret(text)).toBe(false)
    }
  })
})

describe('shellQuote', () => {
  it('quotes a value zsh would expand: a leading = or ~, and anything outside plain words', () => {
    expect(shellQuote('=opus')).toBe("'=opus'")
    expect(shellQuote('~/notes')).toBe("'~/notes'")
    expect(shellQuote('a=b')).toBe('a=b')
    expect(shellQuote('--model=opus')).toBe('--model=opus')
    expect(shellQuote("it's")).toBe("'it'\\''s'")
  })
})
