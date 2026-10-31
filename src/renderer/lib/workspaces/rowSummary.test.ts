import { describe, expect, it } from 'vitest'
import { createTerminalPane } from '@/lib/layout/tree'
import type { PaneNode } from '@/lib/layout/types'
import { liveTerminalCount, rowFact, rowMark, stateCounts } from './rowSummary'

const pane = (over: Partial<PaneNode>): PaneNode => ({ ...createTerminalPane('t', '/x'), ...over })

describe('rowMark', () => {
  it('marks every state but idle', () => {
    expect(
      (['idle', 'done', 'working', 'waiting', 'error'] as const).map((s) => rowMark(s)),
    ).toEqual([null, 'done', 'working', 'waiting', 'error'])
  })
})

describe('liveTerminalCount', () => {
  it('counts shells and agents, never hibernated tabs or other surfaces', () => {
    const panes = [
      pane({ id: 'a' }),
      pane({ id: 'b', kind: 'agent' }),
      pane({ id: 'c', hibernated: true }),
      pane({ id: 'd', kind: 'browser' }),
    ]
    expect(liveTerminalCount(panes)).toBe(2)
  })

  it('is zero with no tabs', () => {
    expect(liveTerminalCount([])).toBe(0)
  })
})

describe('rowFact', () => {
  const none = { message: null, offline: null, running: null }

  it('has no line when nothing is live', () => {
    expect(rowFact({ state: 'idle', ...none })).toBeNull()
  })

  it('colours the message by the state it explains', () => {
    expect(rowFact({ state: 'waiting', ...none, message: 'Allow?' })).toEqual({
      text: 'Allow?',
      tone: 'waiting',
    })
    expect(rowFact({ state: 'error', ...none, message: 'exit 1' })?.tone).toBe('error')
    expect(rowFact({ state: 'done', ...none, message: 'Finished' })?.tone).toBe('plain')
  })

  it('puts the message before offline before the running command', () => {
    const all = { state: 'working' as const, message: 'm', offline: 'o', running: 'r' }
    expect(rowFact(all)?.text).toBe('m')
    expect(rowFact({ ...all, message: null })).toEqual({ text: 'o', tone: 'muted' })
    expect(rowFact({ ...all, message: null, offline: null })).toEqual({ text: 'r', tone: 'muted' })
  })
})

describe('stateCounts', () => {
  it('counts one per nonzero state and ignores idle and done', () => {
    expect(stateCounts(['waiting', 'waiting', 'error', 'working', 'idle', 'done'])).toEqual({
      waiting: 2,
      error: 1,
      working: 1,
    })
  })
})
