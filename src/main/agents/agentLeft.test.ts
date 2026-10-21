import { beforeEach, describe, expect, it } from 'vitest'
import { claimName, forgetNames, nameOf, noteAgentSession, panesNamed } from '../panes/paneNames'
import { PaneWaking } from '../panes/paneWaking'
import { agentLeft } from './agentLeft'
import { AgentRunningPanes } from './agentRunning'

const waking = new PaneWaking()
let program: string | null = null
let sandboxed: boolean | undefined = false
const running = new AgentRunningPanes(() => {})
running.whenStopped((paneId) =>
  agentLeft(
    { waking: (id) => waking.has(id), sandboxed: () => sandboxed, program: () => program },
    paneId,
  ),
)

beforeEach(() => {
  forgetNames()
  waking.abandon('p1')
  program = null
  sandboxed = false
  running.report('p1', true, true)
  noteAgentSession('p1', 'claude', 's-1')
  claimName('p1', 'boss', undefined, () => true)
})

describe('a bus name when the renderer reports the agent not running', () => {
  it('survives a wake: the resume line runs, false flaps, resume.set reports the same session', () => {
    waking.start('p1')
    running.report('p1', false, true)
    running.report('p1', true, true)
    noteAgentSession('p1', 'claude', 's-1')
    waking.end('p1', 'started')
    expect(nameOf('p1')?.name).toBe('boss')
  })

  it('survives a renderer reload that replays the agent block before it is marked', () => {
    program = 'claude'
    running.report('p1', false, true)
    running.report('p1', true, true)
    expect(nameOf('p1')?.name).toBe('boss')
  })

  it('survives in a sandboxed pane, where the foreground program cannot be read', () => {
    sandboxed = true
    running.report('p1', false, true)
    expect(nameOf('p1')?.name).toBe('boss')
  })

  it('is dropped when the agent exits and the shell is back at its prompt', () => {
    running.report('p1', false, true)
    expect(panesNamed('boss')).toEqual([])
  })

  it('is kept when the pane has no terminal, as when it hibernates', () => {
    sandboxed = undefined
    running.report('p1', false, true)
    expect(nameOf('p1')?.name).toBe('boss')
  })

  it('is dropped when a different agent session starts in the pane', () => {
    noteAgentSession('p1', 'claude', 's-2')
    expect(panesNamed('boss')).toEqual([])
  })
})
