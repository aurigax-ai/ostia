import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { typedLaunch } from './agentLaunch'
import {
  type AgentResume,
  canFork,
  forkCommand,
  newSessionCommand,
  parseAgentResume,
  parseResumeFailure,
  parseStoredResume,
  resumeCommand,
  resumeFromHookPayload,
  sameResume,
} from './agentResume'

describe('parseAgentResume', () => {
  it('accepts a known agent with a plain id', () => {
    expect(parseAgentResume({ agent: 'claude', id: 'ffe55127-cb1f-4efd' })).toEqual({
      agent: 'claude',
      id: 'ffe55127-cb1f-4efd',
    })
  })

  it('rejects an unknown agent or an id that could smuggle shell syntax', () => {
    expect(parseAgentResume({ agent: 'bash', id: 'abc' })).toBeNull()
    expect(parseAgentResume({ agent: 'claude', id: 'abc; rm -rf ~' })).toBeNull()
    expect(parseAgentResume({ agent: 'claude', id: '$(whoami)' })).toBeNull()
    expect(parseAgentResume({ agent: 'claude', id: '-x' })).toBeNull()
    expect(parseAgentResume(null)).toBeNull()
  })

  it('keeps an absolute cwd and drops one that is relative, too long or has a control character', () => {
    expect(parseAgentResume({ agent: 'claude', id: 'abc', cwd: '/work/tree' })).toEqual({
      agent: 'claude',
      id: 'abc',
      cwd: '/work/tree',
    })
    for (const cwd of ['work/tree', `/${'a'.repeat(4096)}`, '/work\ntree', '/work\u001btree', 7]) {
      expect(parseAgentResume({ agent: 'claude', id: 'abc', cwd })).toEqual({
        agent: 'claude',
        id: 'abc',
      })
    }
  })
})

describe('parseAgentResume with the launch flags', () => {
  it('keeps the flags it can replay and no variable at all', () => {
    expect(
      parseAgentResume({
        agent: 'claude',
        id: 'abc',
        args: ['--model', 'opus', '--resume', 'old', 'prompt'],
        env: {
          GL_ISSUE: '685',
          GIT_DIR: '/tmp/g',
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
          HTTPS_PROXY: 'http://127.0.0.1:9',
          SHELL: '/tmp/sh',
          BROWSER: '/tmp/b',
        },
      }),
    ).toEqual({ agent: 'claude', id: 'abc', args: ['--model', 'opus'] })
  })

  it('drops args that are not a list of strings and leaves empty ones out', () => {
    for (const args of ['--agent x', [1, 2], ['--resume', 'x'], []]) {
      expect(parseAgentResume({ agent: 'codex', id: 'abc', args, env: {} })).toEqual({
        agent: 'codex',
        id: 'abc',
      })
    }
  })
})

describe('parseAgentResume with an escaping flag', () => {
  it('stores none of them, from the hook or from a saved snapshot', () => {
    expect(
      parseAgentResume({
        agent: 'claude',
        id: 'abc',
        args: [
          '--dangerously-skip-permissions',
          '--permission-mode',
          'bypassPermissions',
          '--model',
          'opus',
        ],
        env: { CLAUDE_CONFIG_DIR: '/tmp/c' },
      }),
    ).toEqual({ agent: 'claude', id: 'abc', args: ['--model', 'opus'] })
    expect(
      parseAgentResume({
        agent: 'codex',
        id: 'abc',
        args: ['--dangerously-bypass-approvals-and-sandbox', '-a', 'never'],
        env: { CODEX_HOME: '/tmp/x' },
      }),
    ).toEqual({ agent: 'codex', id: 'abc' })
  })
})

describe('sameResume', () => {
  it('compares the flags too', () => {
    const base = { agent: 'claude' as const, id: 'abc', args: ['--model', 'opus'] }
    expect(sameResume(base, { ...base, args: ['--model', 'opus'] })).toBe(true)
    expect(sameResume(base, { ...base, args: ['--model', 'sonnet'] })).toBe(false)
    expect(sameResume(undefined, base)).toBe(false)
  })
})

describe('resumeCommand', () => {
  it('builds each agent’s own resume command', () => {
    expect(resumeCommand({ agent: 'claude', id: 'abc' })).toBe("'claude' --resume abc")
    expect(resumeCommand({ agent: 'codex', id: 'abc' })).toBe("'codex' resume abc")
  })

  it('replays the flags after the session, quoted for the shell', () => {
    expect(
      resumeCommand({
        agent: 'claude',
        id: 'abc',
        args: ['--model', 'opus', '--append-system-prompt', "it's done"],
      }),
    ).toBe("'claude' --resume abc --model opus --append-system-prompt 'it'\\''s done'")
    expect(
      resumeCommand({ agent: 'codex', id: 'abc', args: ['-c', 'model_reasoning_effort="high"'] }),
    ).toBe(`'codex' resume abc -c 'model_reasoning_effort="high"'`)
  })

  it('quotes a flag value that holds an =', () => {
    expect(resumeCommand({ agent: 'codex', id: 'abc', args: ['-c', 'model_verbosity=low'] })).toBe(
      "'codex' resume abc -c 'model_verbosity=low'",
    )
  })

  it('never replays an escaping flag or any variable, even from a record built by hand', () => {
    expect(
      resumeCommand({
        agent: 'codex',
        id: 'abc',
        args: ['--yolo', '-s', 'danger-full-access', '-c', 'notify=["sh"]', '-m', 'gpt-5'],
        env: { CODEX_HOME: '/tmp/x', GIT_DIR: '/tmp/g', OPENAI_BASE_URL: 'http://127.0.0.1:9' },
      } as AgentResume),
    ).toBe("'codex' resume abc -m gpt-5")
    expect(
      forkCommand({
        agent: 'claude',
        id: 'abc',
        args: ['--dangerously-skip-permissions', '--agent', 'x', '--model', 'opus'],
        env: { GL_ISSUE: '687' },
      } as AgentResume),
    ).toBe("'claude' --resume abc --fork-session --model opus")
  })
})

describe('forkCommand', () => {
  it('builds each agent’s own fork command', () => {
    expect(forkCommand({ agent: 'claude', id: 'abc' })).toBe("'claude' --resume abc --fork-session")
    expect(forkCommand({ agent: 'codex', id: 'abc' })).toBe("'codex' fork abc")
  })

  it('carries the saved flags after the session', () => {
    expect(
      forkCommand({
        agent: 'claude',
        id: 'abc',
        cwd: '/home/u/proj',
        args: ['--model', 'opus', '--append-system-prompt', "it's done"],
      }),
    ).toBe(
      "'claude' --resume abc --fork-session --model opus --append-system-prompt 'it'\\''s done'",
    )
    expect(
      forkCommand({ agent: 'codex', id: 'abc', args: ['-c', 'model_reasoning_effort="high"'] }),
    ).toBe(`'codex' fork abc -c 'model_reasoning_effort="high"'`)
  })

  it('saves no fork flag for the fork’s own resume', () => {
    for (const agent of ['claude', 'codex'] as const) {
      const line = forkCommand({ agent, id: 'abc' })
      expect(parseAgentResume({ agent, id: 'new', args: line.split(' ').slice(2) })).toEqual({
        agent,
        id: 'new',
      })
    }
  })
})

describe('agy', () => {
  it('resumes with --conversation and keeps only the allow-listed flags', () => {
    expect(
      resumeCommand({
        agent: 'agy',
        id: 'c-1',
        args: ['--model', 'Gemini 3', '--dangerously-skip-permissions', '--mode', 'auto'],
      }),
    ).toBe("'agy' --conversation c-1 --model 'Gemini 3'")
  })

  it('has no fork', () => {
    expect(canFork('agy')).toBe(false)
    expect(canFork('claude')).toBe(true)
    expect(() => forkCommand({ agent: 'agy', id: 'c-1' })).toThrow('agy cannot fork')
  })

  it('reads the conversation id of an agy hook payload', () => {
    expect(resumeFromHookPayload(JSON.stringify({ conversationId: 'c-1' }))).toBe('c-1')
    expect(resumeFromHookPayload(JSON.stringify({ conversationId: 'c-1', invocationNum: 0 }))).toBe(
      'c-1',
    )
  })

  it('stores no token on a later model call of the same turn', () => {
    expect(
      resumeFromHookPayload(JSON.stringify({ conversationId: 'c-1', invocationNum: 2 })),
    ).toBeNull()
  })
})

describe('resumeFromHookPayload', () => {
  it('reads session_id from a Claude Code hook event', () => {
    const event = JSON.stringify({ session_id: 'ffe55127-cb1f', hook_event_name: 'SessionStart' })
    expect(resumeFromHookPayload(event)).toBe('ffe55127-cb1f')
  })

  it('reads session_id from a Codex SessionStart hook event', () => {
    const event = JSON.stringify({
      session_id: '01a0f04c-15fd-7b22-8538-ca8250a46988',
      hook_event_name: 'SessionStart',
      source: 'resume',
    })
    expect(resumeFromHookPayload(event)).toBe('01a0f04c-15fd-7b22-8538-ca8250a46988')
  })

  it('reads only the session, never the event’s folder', () => {
    const event = JSON.stringify({ session_id: 'ffe55127-cb1f', cwd: '/home/u' })
    expect(resumeFromHookPayload(event)).toBe('ffe55127-cb1f')
  })

  it('takes a bare id and refuses anything else', () => {
    expect(resumeFromHookPayload('abc-123\n')).toBe('abc-123')
    expect(resumeFromHookPayload('not an id')).toBeNull()
    expect(resumeFromHookPayload('{broken')).toBeNull()
    expect(resumeFromHookPayload(JSON.stringify({ session_id: 'a b' }))).toBeNull()
  })
})

const hasShell = (shell: string) => spawnSync(shell, ['-c', 'true']).status === 0

describe('the line Ostia types for an agent', () => {
  it('starts a fresh session of the same agent, never with anything from the token', () => {
    expect(newSessionCommand('claude')).toBe("'claude'")
    expect(newSessionCommand('codex')).toBe("'codex'")
  })

  for (const shell of ['bash', 'zsh']) {
    it.skipIf(!hasShell(shell))(
      `RSM-C12 skips the human's alias but keeps Ostia's claude function, in ${shell}`,
      () => {
        const dir = mkdtempSync(join(tmpdir(), 'ostia-alias-'))
        try {
          const agent = join(dir, 'claude')
          writeFileSync(agent, '#!/bin/sh\necho "REAL $*"\n')
          chmodSync(agent, 0o755)
          const run = (line: string) =>
            spawnSync(
              shell,
              [
                ...(shell === 'bash' ? ['-O', 'expand_aliases'] : ['-f']),
                '-c',
                `claude() { echo "WRAPPED $*"; command claude "$@"; }\nalias claude='echo ALIAS'\nalias ccr='claude --resume'\neval "$LINE"\n`,
              ],
              { env: { PATH: `${dir}:/usr/bin:/bin`, LINE: line }, encoding: 'utf8' },
            ).stdout.trim()
          expect(run('claude --resume abc')).toBe('ALIAS --resume abc')
          expect(run(resumeCommand({ agent: 'claude', id: 'abc' }))).toBe(
            'WRAPPED --resume abc\nREAL --resume abc',
          )
          expect(run(forkCommand({ agent: 'claude', id: 'abc' }))).toBe(
            'WRAPPED --resume abc --fork-session\nREAL --resume abc --fork-session',
          )
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      },
    )
  }

  const fish = 'fish'
  it.skipIf(!hasShell(fish))("RSM-C12 runs as valid fish and keeps Ostia's claude function", () => {
    const dir = mkdtempSync(join(tmpdir(), 'ostia-alias-'))
    try {
      const agent = join(dir, 'claude')
      writeFileSync(agent, '#!/bin/sh\necho "REAL $*"\n')
      chmodSync(agent, 0o755)
      const line = resumeCommand({ agent: 'claude', id: 'abc', args: ['--model', 'opus'] })
      const out = spawnSync(
        fish,
        [
          '--no-config',
          '-c',
          'function claude; echo "WRAPPED $argv"; command claude $argv; end; eval $LINE',
        ],
        { env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir, LINE: line }, encoding: 'utf8' },
      ).stdout.trim()
      expect(out).toBe('WRAPPED --resume abc --model opus\nREAL --resume abc --model opus')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the launch the human typed', () => {
  const claude: AgentResume = {
    agent: 'claude',
    id: 'abc',
    args: ['--name', 'Ostia 統籌', '--model', 'opus'],
    typed: {
      args: ['--agent', 'ostia', '--dangerously-skip-permissions'],
      env: { CLAUDE_CONFIG_DIR: '/Users/j/.claude-profiles/twai', GL_ISSUE: 'tracker#24' },
    },
  }
  const codex: AgentResume = {
    agent: 'codex',
    id: 'r-9',
    typed: { args: ['--yolo', '-s', 'danger-full-access'], env: { CODEX_HOME: '/c' } },
  }

  it('is never taken from a caller, only from a saved record', () => {
    expect(parseAgentResume(claude)).toEqual({
      agent: 'claude',
      id: 'abc',
      args: ['--name', 'Ostia 統籌', '--model', 'opus'],
    })
    expect(parseStoredResume(claude)).toEqual(claude)
    expect(parseStoredResume(codex)).toEqual(codex)
    expect(parseResumeFailure({ resume: claude, exitCode: 1 })).toEqual({
      resume: claude,
      exitCode: 1,
    })
  })

  it('is filtered again when read from a saved record', () => {
    expect(
      parseStoredResume({
        agent: 'claude',
        id: 'abc',
        typed: {
          args: ['--model', 'opus', '--agent', 'a'],
          env: { GH_TOKEN: 'x', BASH_ENV: '/x', GL_ISSUE: '1' },
        },
      }),
    ).toEqual({
      agent: 'claude',
      id: 'abc',
      typed: { args: ['--agent', 'a'], env: { GL_ISSUE: '1' } },
    })
    expect(
      parseStoredResume({ agent: 'claude', id: 'abc', typed: { args: ['--yolo'], env: {} } }),
    ).toEqual({ agent: 'claude', id: 'abc' })
  })

  it('is replayed in front of and after the session', () => {
    expect(resumeCommand(claude)).toBe(
      "CLAUDE_CONFIG_DIR=/Users/j/.claude-profiles/twai GL_ISSUE='tracker#24' 'claude' --resume abc --name 'Ostia 統籌' --model opus --agent ostia --dangerously-skip-permissions",
    )
    expect(forkCommand(codex)).toBe("CODEX_HOME=/c 'codex' fork r-9 --yolo -s danger-full-access")
  })

  it('reads back the same from the line Ostia types, so it never wears off over resumes', () => {
    for (const resume of [claude, codex]) {
      expect(typedLaunch(resume.agent, resumeCommand(resume))).toEqual(resume.typed)
    }
  })

  it('is compared too', () => {
    expect(sameResume(claude, { ...claude, typed: { ...claude.typed } })).toBe(true)
    expect(sameResume(claude, { ...claude, typed: undefined })).toBe(false)
  })
})
