import { beforeEach, describe, expect, it } from 'vitest'
import { claimName, forgetNames, nameOf, noteAgentSession, paneNamed } from '../panes/paneNames'
import { PaneWaking } from '../panes/paneWaking'
import type { PromptOwner } from '../terminal/localPrompt'
import { type AgentLeftDeps, agentLeft } from './agentLeft'
import { AgentRunningPanes } from './agentRunning'

const waking = new PaneWaking()
const SHELL: PromptOwner = { foreground: 'zsh', shell: '/bin/zsh', sandboxed: false }
const AGENT: PromptOwner = { foreground: 'claude', shell: '/bin/zsh', sandboxed: false }
let owner: PromptOwner | undefined = SHELL
let rechecks: Array<() => void> = []
const running = new AgentRunningPanes(() => {})
const deps: AgentLeftDeps = {
  running: (id) => running.has(id),
  waking: (id) => waking.has(id),
  owner: () => owner,
  recheck: (_id, again) => rechecks.push(again),
}
running.whenStopped((id) => agentLeft(deps, id))
waking.subscribe((id, how) => {
  if (how === 'failed') agentLeft(deps, id)
})

beforeEach(() => {
  forgetNames()
  waking.abandon('p1')
  owner = SHELL
  rechecks = []
  running.report('p1', true, true)
  noteAgentSession('p1', 'claude', 's-1')
  claimName('p1', 'boss', undefined)
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
    owner = AGENT
    running.report('p1', false, true)
    running.report('p1', true, true)
    expect(nameOf('p1')?.name).toBe('boss')
  })

  it('is dropped when the agent exits and the shell is back at its prompt', () => {
    running.report('p1', false, true)
    expect(paneNamed('boss')).toBeUndefined()
  })

  it('is dropped when a wake ends failed and the shell sits at its prompt', () => {
    waking.start('p1')
    running.report('p1', false, true)
    expect(nameOf('p1')?.name).toBe('boss')
    waking.end('p1', 'failed')
    expect(paneNamed('boss')).toBeUndefined()
  })

  it('is kept when a wake ends started, and when the agent runs again by then', () => {
    waking.start('p1')
    running.report('p1', false, true)
    waking.end('p1', 'started')
    expect(nameOf('p1')?.name).toBe('boss')
    running.report('p1', true, true)
    agentLeft(deps, 'p1')
    expect(nameOf('p1')?.name).toBe('boss')
  })

  it.each([
    ['sandboxed, where the foreground cannot be read', { ...SHELL, sandboxed: true }],
    ['an empty foreground read', { ...SHELL, foreground: '' }],
    ['a program that is not the shell', AGENT],
  ])('is kept for %s', (_why, busy) => {
    owner = busy
    running.report('p1', false, true)
    expect(nameOf('p1')?.name).toBe('boss')
  })

  it('is kept when reading the foreground throws', () => {
    owner = {
      shell: '/bin/zsh',
      sandboxed: false,
      get foreground(): string {
        throw new Error('gone')
      },
    }
    running.report('p1', false, true)
    expect(nameOf('p1')?.name).toBe('boss')
  })

  it('is kept when the pane has no terminal, as when it hibernates', () => {
    owner = undefined
    running.report('p1', false, true)
    expect(nameOf('p1')?.name).toBe('boss')
  })

  it('is dropped when a different agent session starts in the pane', () => {
    noteAgentSession('p1', 'claude', 's-2')
    expect(paneNamed('boss')).toBeUndefined()
  })
})

describe('a kept shell whose foreground lags the prompt', () => {
  it('checks once more after the next foreground update, and drops the name then', () => {
    owner = AGENT
    running.report('p1', false, true)
    expect(nameOf('p1')?.name).toBe('boss')
    expect(rechecks).toHaveLength(1)
    owner = SHELL
    rechecks[0]()
    expect(paneNamed('boss')).toBeUndefined()
  })

  it('keeps it when the agent is still the foreground at the second look, without a third', () => {
    owner = AGENT
    running.report('p1', false, true)
    rechecks[0]()
    expect(nameOf('p1')?.name).toBe('boss')
    expect(rechecks).toHaveLength(1)
  })

  it('does not drop it when the agent started again before the update', () => {
    owner = AGENT
    running.report('p1', false, true)
    running.report('p1', true, true)
    owner = SHELL
    rechecks[0]()
    expect(nameOf('p1')?.name).toBe('boss')
  })
})
