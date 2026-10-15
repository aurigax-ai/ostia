import { describe, expect, it } from 'vitest'
import { AGENT_ARGS_SEPARATOR, capturedArgs, looksSecret, resumeFlags } from './agentLaunch'

describe('resumeFlags for claude', () => {
  it('keeps the model, effort and a permission mode that never accepts on its own, in both spellings', () => {
    expect(
      resumeFlags('claude', ['--model=opus', '--effort', 'high', '--permission-mode', 'plan']),
    ).toEqual(['--model', 'opus', '--effort', 'high', '--permission-mode', 'plan'])
    for (const mode of ['manual', 'dontAsk', 'plan']) {
      expect(resumeFlags('claude', ['--permission-mode', mode])).toEqual([
        '--permission-mode',
        mode,
      ])
    }
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
    ).toEqual(['--name', 'Slack 推播上線'])
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
        '--tools=Read,Edit',
        '--disallowedTools=Bash(rm *)',
        '--debug=api,hooks',
        '-dhooks',
        '-d',
        '--bare',
      ]),
    ).toEqual([
      '--tools=Read,Edit',
      '--disallowedTools=Bash(rm *)',
      '--debug=api,hooks',
      '--debug=hooks',
      '--debug',
      '--bare',
    ])
    for (const argv of [
      ['--tools', 'Read', 'fix the login bug'],
      ['--betas', 'x', 'fix the login bug'],
      ['--disallowedTools', 'Edit', 'fix the login bug'],
      ['--debug', 'fix the login bug'],
      ['-d', 'fix the login bug'],
    ]) {
      expect(resumeFlags('claude', [...argv, '--model', 'opus'])).toEqual(['--model', 'opus'])
    }
    expect(resumeFlags('claude', ['--debug'])).toEqual(['--debug'])
  })

  it('reads back the flags it replays the same way', () => {
    const once = resumeFlags('claude', [
      '--disallowed-tools=Bash(rm *)',
      '--debug=api',
      '--model',
      'opus',
      '-n',
      'x',
    ])
    expect(resumeFlags('claude', once)).toEqual(once)
  })

  it('drops a flag that carries a secret, a control character or a value that is too long', () => {
    expect(
      resumeFlags('claude', [
        '--append-system-prompt',
        `use ${'sk'}-${'a'.repeat(20)}`,
        '--append-system-prompt',
        'a\u001bb',
        '--system-prompt',
        'x'.repeat(2049),
        '--model',
        'opus',
      ]),
    ).toEqual(['--model', 'opus'])
  })

  it('refuses a value that starts with a dash, so a dropped flag never becomes the value', () => {
    expect(
      resumeFlags('claude', ['--model', '--dangerously-skip-permissions', '--name=-x', '-n', 'ok']),
    ).toEqual(['--name', 'ok'])
    expect(resumeFlags('codex', ['-m', '--yolo', '-c', '-model="x"', '-m', 'gpt-5'])).toEqual([
      '-m',
      'gpt-5',
    ])
  })

  it('drops a value flag that has no value and a boolean flag given one', () => {
    expect(resumeFlags('claude', ['--verbose=yes', '--model'])).toEqual([])
  })

  it('keeps whole flags only, up to the size limit', () => {
    const many = Array.from({ length: 40 }, () => ['--model', 'a']).flat()
    const out = resumeFlags('claude', many)
    expect(out.length).toBe(64)
    expect(out.at(-2)).toBe('--model')
  })
})

describe('resumeFlags for codex', () => {
  it('keeps model, model config, sandbox and approval flags that stay sandboxed, short or long', () => {
    expect(
      resumeFlags('codex', [
        '-m',
        'gpt-5',
        '-c',
        'model_reasoning_effort="high"',
        '--sandbox=workspace-write',
        '-a',
        'on-request',
        '--search',
        'fix it',
      ]),
    ).toEqual([
      '-m',
      'gpt-5',
      '-c',
      'model_reasoning_effort="high"',
      '--sandbox',
      'workspace-write',
      '-a',
      'on-request',
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
    expect(resumeFlags('codex', ['-c', 'model="gpt-5"'])).toEqual(['-c', 'model="gpt-5"'])
  })

  it('replays only flags codex resume accepts, never one the hook args already pass', () => {
    expect(resumeFlags('codex', ['--oss', '--no-daemon', '--full-auto', '--last'])).toEqual([
      '--oss',
    ])
  })
})

const CLAUDE_ESCAPES = [
  '--agent',
  'ostia',
  '--permission-mode',
  'acceptEdits',
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--permission-mode',
  'bypassPermissions',
  '--permission-mode=auto',
  '--settings',
  '/tmp/s.json',
  '--setting-sources',
  'project',
  '--mcp-config=/tmp/m.json',
  '--plugin-dir',
  '/tmp/p',
  '--plugin-url',
  'https://example.com/p.zip',
  '--agents',
  '/tmp/a.json',
  '--add-dir=/',
  '--allowedTools=Bash',
  '--allowed-tools=Bash',
  '--system-prompt-file',
  '/tmp/p.md',
  '--append-system-prompt-file',
  '/tmp/p.md',
  '--debug-file',
  '/home/j/.bashrc',
  '--chrome',
]

const CODEX_ESCAPES = [
  '--dangerously-bypass-approvals-and-sandbox',
  '--yolo',
  '-s',
  'danger-full-access',
  '--sandbox=danger-full-access',
  '-a',
  'never',
  '--ask-for-approval=never',
  '-c',
  'sandbox_mode="danger-full-access"',
  '-c',
  'approval_policy="never"',
  '-c',
  'notify=["sh","-c","id"]',
  '--config=mcp_servers.x.command="sh"',
  '-c',
  'sandbox_workspace_write.network_access=true',
  '-c',
  'shell_environment_policy.inherit="all"',
  '-c',
  'default_permissions="full"',
  '-c',
  'environment_name="x"',
  '--add-dir',
  '/',
  '-p',
  'yolo',
  '--profile=yolo',
  '--enable',
  'computer_use',
  '--disable',
  'guardian_approval',
  '--approve-for-me',
  '--dangerously-bypass-hook-trust',
  '--remote',
  'ws://h:1',
  '--remote-auth-token-env',
  'T',
]

describe('resumeFlags never carries a way out of the sandbox or the approvals', () => {
  it('drops each claude flag that skips permissions or loads settings, plugins, tools or files', () => {
    expect(resumeFlags('claude', [...CLAUDE_ESCAPES, '--model', 'opus'])).toEqual([
      '--model',
      'opus',
    ])
  })

  it('drops each codex flag that leaves the sandbox or its approvals or loads config', () => {
    expect(resumeFlags('codex', [...CODEX_ESCAPES, '-m', 'gpt-5'])).toEqual(['-m', 'gpt-5'])
  })
})

describe('capturedArgs', () => {
  it('reads the arguments the shell function recorded for that agent only', () => {
    const env = {
      OSTIA_CLAUDE_ARGS: ['--name', 'two words', 'say hi'].join(AGENT_ARGS_SEPARATOR),
    }
    expect(capturedArgs('claude', env)).toEqual(['--name', 'two words'])
    expect(capturedArgs('codex', env)).toBeNull()
    expect(capturedArgs('claude', { OSTIA_CLAUDE_ARGS: '' })).toEqual([])
    expect(capturedArgs('claude', {})).toBeNull()
  })

  it('never reports a flag that leaves the sandbox or skips approvals', () => {
    expect(
      capturedArgs('codex', {
        OSTIA_CODEX_ARGS: [...CODEX_ESCAPES, '-m', 'gpt-5'].join(AGENT_ARGS_SEPARATOR),
      }),
    ).toEqual(['-m', 'gpt-5'])
    expect(
      capturedArgs('claude', {
        OSTIA_CLAUDE_ARGS: [...CLAUDE_ESCAPES, '--model', 'opus'].join(AGENT_ARGS_SEPARATOR),
      }),
    ).toEqual(['--model', 'opus'])
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
