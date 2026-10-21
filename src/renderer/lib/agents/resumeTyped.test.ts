import type { AgentResume } from '@shared/agents/agentResume'
import { beforeEach, describe, expect, it } from 'vitest'
import { createPane, findPane } from '@/lib/layout/tree'
import { type CommandBlock, useBlocksStore } from '@/stores/terminal/blocksStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { clearTypedLaunchOnNewBlock, withTypedLaunch } from './resumeTyped'

const TYPED = { args: ['--agent', 'a', '--dangerously-skip-permissions'], env: { GL_ISSUE: '1' } }
const LINE = 'GL_ISSUE=1 claude --agent a --dangerously-skip-permissions'
const saved: AgentResume = { agent: 'claude', id: 'old', typed: TYPED }
const PANE = createPane('terminal')

function runningLine(typedCommand?: string): void {
  const id = `${PANE.id}-b`
  const block = { id, paneId: PANE.id, command: '', startedAt: 0, typedCommand } as CommandBlock
  useBlocksStore.setState({ running: { [PANE.id]: id }, byPane: { [PANE.id]: [block] } })
}

function seed(resume?: AgentResume): void {
  const pane = { ...PANE, ...(resume ? { resume } : {}) }
  useLayoutStore.setState({
    byWorkspace: { w1: { root: pane, activePaneId: pane.id, zoomedPaneId: null } },
  })
}

function stored(): AgentResume | undefined {
  const pane = findPane(useLayoutStore.getState().byWorkspace.w1.root, PANE.id)
  return pane?.kind === 'terminal' ? pane.resume : undefined
}

beforeEach(() => {
  useBlocksStore.setState({ running: {}, byPane: {} })
  seed()
})

describe('a typed launch follows the pane and the agent kind', () => {
  it('keeps the typed part when the session id changes with no typed line running', () => {
    expect(withTypedLaunch({ agent: 'claude', id: 'new' }, PANE.id, saved)).toEqual({
      agent: 'claude',
      id: 'new',
      typed: TYPED,
    })
  })

  it('drops it when the agent kind changes', () => {
    expect(withTypedLaunch({ agent: 'codex', id: 'new' }, PANE.id, saved)).toEqual({
      agent: 'codex',
      id: 'new',
    })
  })

  it('never takes a typed part a report carries', () => {
    expect(
      withTypedLaunch({ agent: 'claude', id: 'new', typed: TYPED }, PANE.id, undefined),
    ).toEqual({ agent: 'claude', id: 'new' })
  })

  it('reads a running nonce-backed line over the saved one', () => {
    runningLine('claude --agent b')
    expect(withTypedLaunch({ agent: 'claude', id: 'new' }, PANE.id, saved)).toEqual({
      agent: 'claude',
      id: 'new',
      typed: { args: ['--agent', 'b'] },
    })
  })
})

describe('a new command block', () => {
  const plain: AgentResume = { agent: 'claude', id: 'old' }

  it('never adds a typed part from its line to a record that has none', () => {
    seed(plain)
    clearTypedLaunchOnNewBlock('w1', PANE.id, LINE, false)
    expect(stored()).toEqual(plain)
  })

  it('never replaces the typed part with the one its line carries', () => {
    seed(saved)
    clearTypedLaunchOnNewBlock('w1', PANE.id, 'claude --agent b', false)
    expect(stored()).toEqual(plain)
  })

  it('clears it when the block has no nonce-backed line', () => {
    seed(saved)
    clearTypedLaunchOnNewBlock('w1', PANE.id, undefined, false)
    expect(stored()).toEqual(plain)
  })

  it('clears it for a typed line that does not launch the saved agent', () => {
    seed(saved)
    clearTypedLaunchOnNewBlock('w1', PANE.id, 'ls -la', false)
    expect(stored()).toEqual(plain)
    seed(saved)
    clearTypedLaunchOnNewBlock('w1', PANE.id, 'codex --yolo', false)
    expect(stored()).toEqual(plain)
  })

  it('keeps it for a line that carries the same typed part', () => {
    seed(saved)
    const before = useLayoutStore.getState().byWorkspace
    clearTypedLaunchOnNewBlock('w1', PANE.id, LINE, false)
    expect(useLayoutStore.getState().byWorkspace).toBe(before)
  })

  it('clears it for a replayed launch whose flags differ, and ignores a replayed block that launches nothing', () => {
    seed(saved)
    clearTypedLaunchOnNewBlock('w1', PANE.id, 'ls -la', true)
    expect(stored()).toEqual(saved)
    clearTypedLaunchOnNewBlock('w1', PANE.id, 'claude --agent b', true)
    expect(stored()).toEqual(plain)
  })

  it('does nothing for a pane with no record', () => {
    clearTypedLaunchOnNewBlock('w1', PANE.id, LINE, false)
    expect(stored()).toBeUndefined()
  })
})
