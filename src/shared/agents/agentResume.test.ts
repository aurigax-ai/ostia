import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { commandLineEnv } from './agentLaunch'
import {
  forkCommand,
  newSessionCommand,
  parseAgentResume,
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

describe('parseAgentResume with the launch flags and environment', () => {
  it('keeps the flags it can replay and the safe variables', () => {
    expect(
      parseAgentResume({
        agent: 'claude',
        id: 'abc',
        args: ['--agent', 'ostia', '--resume', 'old', 'prompt'],
        env: { GL_ISSUE: '685', GH_TOKEN: 'x' },
      }),
    ).toEqual({ agent: 'claude', id: 'abc', args: ['--agent', 'ostia'], env: { GL_ISSUE: '685' } })
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

describe('sameResume', () => {
  it('compares the flags and the environment too', () => {
    const base = { agent: 'claude' as const, id: 'abc', args: ['--model', 'opus'] }
    expect(sameResume(base, { ...base, args: ['--model', 'opus'] })).toBe(true)
    expect(sameResume(base, { ...base, args: ['--model', 'sonnet'] })).toBe(false)
    expect(sameResume(base, { ...base, env: { A: '1' } })).toBe(false)
    expect(sameResume(undefined, base)).toBe(false)
  })
})

describe('resumeCommand', () => {
  it('builds each agent’s own resume command', () => {
    expect(resumeCommand({ agent: 'claude', id: 'abc' })).toBe("'claude' --resume abc")
    expect(resumeCommand({ agent: 'codex', id: 'abc' })).toBe("'codex' resume abc")
  })

  it('replays the flags after the session and the variables in front, quoted for the shell', () => {
    expect(
      resumeCommand({
        agent: 'claude',
        id: 'abc',
        args: ['--agent', 'ostia', '--append-system-prompt', "it's done"],
        env: { GL_ISSUE: '685', NOTE: 'two words' },
      }),
    ).toBe(
      "GL_ISSUE=685 NOTE='two words' 'claude' --resume abc --agent ostia --append-system-prompt 'it'\\''s done'",
    )
    expect(
      resumeCommand({ agent: 'codex', id: 'abc', args: ['-c', 'model_reasoning_effort="high"'] }),
    ).toBe(`'codex' resume abc -c 'model_reasoning_effort="high"'`)
  })

  it('quotes a flag or variable value that holds an =', () => {
    expect(
      resumeCommand({
        agent: 'claude',
        id: 'abc',
        args: ['--model=opus'],
        env: { OPTS: 'a=b' },
      }),
    ).toBe("OPTS='a=b' 'claude' --resume abc '--model=opus'")
  })

  it('resumes in the account the agent was started with', () => {
    expect(
      resumeCommand(
        parseAgentResume({
          agent: 'claude',
          id: 'abc',
          args: ['--agent', 'ostia'],
          env: { CLAUDE_CONFIG_DIR: '/Users/j/.claude-profiles/twai', HOME: '/tmp/h' },
        }) ?? { agent: 'claude', id: 'none' },
      ),
    ).toBe("CLAUDE_CONFIG_DIR=/Users/j/.claude-profiles/twai 'claude' --resume abc --agent ostia")
    expect(
      resumeCommand(
        parseAgentResume({
          agent: 'codex',
          id: 'abc',
          env: { CODEX_HOME: '/Users/j/.codex work', PATH: '/tmp' },
        }) ?? { agent: 'codex', id: 'none' },
      ),
    ).toBe("CODEX_HOME='/Users/j/.codex work' 'codex' resume abc")
  })

  it('quotes an account folder with shell characters and drops a relative one', () => {
    expect(
      resumeCommand(
        parseAgentResume({
          agent: 'claude',
          id: 'abc',
          env: { CLAUDE_CONFIG_DIR: "/home/j/it's $HOME" },
        }) ?? { agent: 'claude', id: 'none' },
      ),
    ).toBe(`CLAUDE_CONFIG_DIR='/home/j/it'\\''s $HOME' 'claude' --resume abc`)
    expect(
      resumeCommand(
        parseAgentResume({ agent: 'codex', id: 'abc', env: { CODEX_HOME: './.codex' } }) ?? {
          agent: 'codex',
          id: 'none',
        },
      ),
    ).toBe("'codex' resume abc")
  })

  it('reads its own variables back from the command it typed', () => {
    const env = { GL_ISSUE: '685', NOTE: "it's two words", OPTS: 'a=b' }
    for (const agent of ['claude', 'codex'] as const) {
      expect(commandLineEnv(agent, resumeCommand({ agent, id: 'abc', env, args: [] }))).toEqual(env)
    }
  })
})

describe('forkCommand', () => {
  it('builds each agent’s own fork command', () => {
    expect(forkCommand({ agent: 'claude', id: 'abc' })).toBe("'claude' --resume abc --fork-session")
    expect(forkCommand({ agent: 'codex', id: 'abc' })).toBe("'codex' fork abc")
  })

  it('carries the saved flags after the session and the saved variables in front', () => {
    expect(
      forkCommand({
        agent: 'claude',
        id: 'abc',
        cwd: '/home/u/proj',
        args: ['--agent', 'ostia', '--append-system-prompt', "it's done"],
        env: { GL_ISSUE: '685', NOTE: 'two words' },
      }),
    ).toBe(
      "GL_ISSUE=685 NOTE='two words' 'claude' --resume abc --fork-session --agent ostia --append-system-prompt 'it'\\''s done'",
    )
    expect(
      forkCommand({
        agent: 'codex',
        id: 'abc',
        args: ['-c', 'model_reasoning_effort="high"'],
        env: { GL_ISSUE: '685' },
      }),
    ).toBe(`GL_ISSUE=685 'codex' fork abc -c 'model_reasoning_effort="high"'`)
  })

  it('is still read as its agent with its variables, and saves no fork flag for the fork’s own resume', () => {
    const env = { GL_ISSUE: '685' }
    for (const agent of ['claude', 'codex'] as const) {
      const line = forkCommand({ agent, id: 'abc', env })
      expect(commandLineEnv(agent, line)).toEqual(env)
      expect(parseAgentResume({ agent, id: 'new', args: line.split(' ').slice(2) })).toEqual({
        agent,
        id: 'new',
      })
    }
  })
})

describe('resumeFromHookPayload', () => {
  it('reads session_id from a Claude Code hook event', () => {
    const event = JSON.stringify({ session_id: 'ffe55127-cb1f', hook_event_name: 'SessionStart' })
    expect(resumeFromHookPayload(event)).toEqual({ id: 'ffe55127-cb1f' })
  })

  it('reads session_id from a Codex SessionStart hook event', () => {
    const event = JSON.stringify({
      session_id: '01a0f04c-15fd-7b22-8538-ca8250a46988',
      hook_event_name: 'SessionStart',
      source: 'resume',
    })
    expect(resumeFromHookPayload(event)).toEqual({ id: '01a0f04c-15fd-7b22-8538-ca8250a46988' })
  })

  it('keeps the folder the session belongs to from the event’s cwd', () => {
    const event = JSON.stringify({
      session_id: 'ffe55127-cb1f',
      hook_event_name: 'SessionStart',
      cwd: '/home/u/work/tree',
    })
    expect(resumeFromHookPayload(event)).toEqual({ id: 'ffe55127-cb1f', cwd: '/home/u/work/tree' })
    const relative = JSON.stringify({ session_id: 'ffe55127-cb1f', cwd: 'tree' })
    expect(resumeFromHookPayload(relative)).toEqual({ id: 'ffe55127-cb1f' })
  })

  it('takes a bare id and refuses anything else', () => {
    expect(resumeFromHookPayload('abc-123\n')).toEqual({ id: 'abc-123' })
    expect(resumeFromHookPayload('not an id')).toBeNull()
    expect(resumeFromHookPayload('{broken')).toBeNull()
    expect(resumeFromHookPayload(JSON.stringify({ session_id: 'a b' }))).toBeNull()
  })
})

const hasShell = (shell: string) => spawnSync(shell, ['-c', 'true']).status === 0

describe('the line Ostia types for an agent', () => {
  it('starts a new session of the same agent with its saved flags and variables', () => {
    expect(newSessionCommand({ agent: 'claude', id: 'abc' })).toBe("'claude'")
    expect(
      newSessionCommand({ agent: 'codex', id: 'abc', env: { GL_ISSUE: '685' }, args: ['--oss'] }),
    ).toBe("GL_ISSUE=685 'codex' --oss")
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
})
