import { describe, expect, it } from 'vitest'
import {
  type AgentResume,
  forkCommand,
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
    expect(resumeCommand({ agent: 'claude', id: 'abc' })).toBe('claude --resume abc')
    expect(resumeCommand({ agent: 'codex', id: 'abc' })).toBe('codex resume abc')
  })

  it('replays the flags after the session, quoted for the shell', () => {
    expect(
      resumeCommand({
        agent: 'claude',
        id: 'abc',
        args: ['--model', 'opus', '--append-system-prompt', "it's done"],
      }),
    ).toBe("claude --resume abc --model opus --append-system-prompt 'it'\\''s done'")
    expect(
      resumeCommand({ agent: 'codex', id: 'abc', args: ['-c', 'model_reasoning_effort="high"'] }),
    ).toBe(`codex resume abc -c 'model_reasoning_effort="high"'`)
  })

  it('never replays an escaping flag or any variable, even from a record built by hand', () => {
    expect(
      resumeCommand({
        agent: 'codex',
        id: 'abc',
        args: ['--yolo', '-s', 'danger-full-access', '-c', 'notify=["sh"]', '-m', 'gpt-5'],
        env: { CODEX_HOME: '/tmp/x', GIT_DIR: '/tmp/g', OPENAI_BASE_URL: 'http://127.0.0.1:9' },
      } as AgentResume),
    ).toBe('codex resume abc -m gpt-5')
    expect(
      forkCommand({
        agent: 'claude',
        id: 'abc',
        args: ['--dangerously-skip-permissions', '--agent', 'x', '--model', 'opus'],
        env: { GL_ISSUE: '687' },
      } as AgentResume),
    ).toBe('claude --resume abc --fork-session --model opus')
  })
})

describe('forkCommand', () => {
  it('builds each agent’s own fork command', () => {
    expect(forkCommand({ agent: 'claude', id: 'abc' })).toBe('claude --resume abc --fork-session')
    expect(forkCommand({ agent: 'codex', id: 'abc' })).toBe('codex fork abc')
  })

  it('carries the saved flags after the session', () => {
    expect(
      forkCommand({
        agent: 'claude',
        id: 'abc',
        cwd: '/home/u/proj',
        args: ['--model', 'opus', '--append-system-prompt', "it's done"],
      }),
    ).toBe("claude --resume abc --fork-session --model opus --append-system-prompt 'it'\\''s done'")
    expect(
      forkCommand({ agent: 'codex', id: 'abc', args: ['-c', 'model_reasoning_effort="high"'] }),
    ).toBe(`codex fork abc -c 'model_reasoning_effort="high"'`)
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
