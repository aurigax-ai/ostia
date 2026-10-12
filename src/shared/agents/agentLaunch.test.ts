import { describe, expect, it } from 'vitest'
import {
  AGENT_ARGS_SEPARATOR,
  capturedArgs,
  commandLineEnv,
  looksSecret,
  resumeFlags,
  safeEnv,
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

  it('takes every value of a list flag and the optional value of --debug like commander', () => {
    expect(
      resumeFlags('claude', ['--add-dir', '/a', '/b', '--debug', 'api,hooks', '-d', '--bare']),
    ).toEqual(['--add-dir', '/a', '/b', '--debug=api,hooks', '--debug', '--bare'])
    expect(resumeFlags('claude', ['-dhooks'])).toEqual(['--debug=hooks'])
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

  it('drops a config override that holds a key', () => {
    expect(resumeFlags('codex', ['-c', 'model_providers.x.api_key="abc"', '--oss'])).toEqual([
      '--oss',
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
    expect(commandLineEnv('claude', 'claude')).toEqual({})
  })

  it('returns null when the line does not start the agent itself', () => {
    expect(commandLineEnv('claude', 'cd x && GL_ISSUE=1 claude')).toBeNull()
    expect(commandLineEnv('claude', 'GL_ISSUE=1 cc')).toBeNull()
    expect(commandLineEnv('claude', 'GL_ISSUE=1 codex')).toBeNull()
    expect(commandLineEnv('claude', "'claude'")).toBeNull()
    expect(commandLineEnv('claude', 'A=1; claude')).toBeNull()
    expect(commandLineEnv('claude', 'A="open claude')).toBeNull()
    expect(commandLineEnv('claude', '')).toBeNull()
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
        AWS_SECRET_ACCESS_KEY: 'x',
        OSTIA_SOCKET: '/tmp/s',
        'BAD-NAME': '1',
        LONG: 'x'.repeat(1025),
        CTRL: 'a\nb',
        NUM: 5,
      }),
    ).toEqual({ GL_ISSUE: '685' })
    expect(safeEnv(['A'])).toEqual({})
    expect(safeEnv(null)).toEqual({})
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
