import { describe, expect, it } from 'vitest'
import { createPane } from '../layout/tree'
import type { CommandBlock } from '../stores/blocksStore'
import { agentSession, sessionTitle } from './agentSession'

const running = (command: string): CommandBlock => ({
  id: 'b1',
  paneId: 'p1',
  promptLine: { line: 0 },
  inputLine: null,
  outputStartLine: { line: 1 },
  endLine: null,
  endCol: 0,
  command,
  exitCode: null,
  cwd: '/home/u/proj',
  startedAt: 100,
  endedAt: null,
})

describe('sessionTitle', () => {
  it('drops the spinner glyph an agent puts before its session title', () => {
    expect(sessionTitle('✳ Natural text search', 'claude')).toBe('Natural text search')
    expect(sessionTitle('⠂ Fix the build', 'claude')).toBe('Fix the build')
  })

  it('returns null when the title is only the agent or the shell', () => {
    expect(sessionTitle('claude', 'claude')).toBeNull()
    expect(sessionTitle('zsh', 'claude')).toBeNull()
    expect(sessionTitle('✳ ', 'claude')).toBeNull()
  })
})

describe('agentSession', () => {
  it('describes an agent running in a terminal with its resume id and state', () => {
    const pane = {
      ...createPane('terminal', '✳ Resume tokens'),
      resume: { agent: 'claude' as const, id: 'abc-123' },
    }
    const session = agentSession(pane, running('claude --model opus'), {
      state: 'waiting',
      unread: true,
      message: 'Needs input',
      at: 1,
    })
    expect(session).toEqual({
      agent: 'claude',
      title: 'Resume tokens',
      sessionId: 'abc-123',
      command: 'claude --model opus',
      cwd: '/home/u/proj',
      startedAt: 100,
      state: 'waiting',
      message: 'Needs input',
    })
  })

  it('is null for a plain command or an idle terminal, and ignores another agent’s resume id', () => {
    const pane = { ...createPane('terminal'), resume: { agent: 'claude' as const, id: 'x' } }
    expect(agentSession(pane, running('pnpm test'), undefined)).toBeNull()
    expect(agentSession(pane, undefined, undefined)).toBeNull()
    expect(agentSession(pane, running('codex'), undefined)?.sessionId).toBeNull()
  })
})
