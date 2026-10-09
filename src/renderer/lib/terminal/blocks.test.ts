import type { CommandBlock } from '@/stores/blocksStore'
import { describe, expect, it } from 'vitest'
import {
  blockSpan,
  collectHistory,
  isIdlePrompt,
  scrollTargetFor,
  stepSelection,
  stickyBlock,
} from './blocks'

function block(over: Partial<CommandBlock> & { id: string }): CommandBlock {
  return {
    paneId: 'p1',
    promptLine: { line: 0 },
    inputLine: { line: 0 },
    outputStartLine: { line: 1 },
    endLine: { line: 3 },
    endCol: 0,
    command: 'ls',
    exitCode: 0,
    cwd: '/home/u',
    startedAt: 1,
    endedAt: 2,
    ...over,
  }
}

describe('blockSpan', () => {
  it('spans the prompt line up to the D mark for a finished block', () => {
    expect(blockSpan(block({ id: 'a' }), 50)).toEqual({ start: 0, end: 3 })
  })

  it('includes the D row when output ended mid-line', () => {
    expect(blockSpan(block({ id: 'a', endCol: 4 }), 50)).toEqual({ start: 0, end: 4 })
  })

  it('extends a running block to the cursor line', () => {
    expect(blockSpan(block({ id: 'a', endLine: null }), 9)).toEqual({ start: 0, end: 10 })
  })

  it('falls back to the output start when the prompt line was trimmed', () => {
    const b = block({ id: 'a', promptLine: { line: -1 }, outputStartLine: { line: 0 } })
    expect(blockSpan(b, 50).start).toBe(0)
  })
})

describe('stepSelection', () => {
  const ids = ['a', 'b', 'c']

  it('selects the newest block when stepping back with nothing selected', () => {
    expect(stepSelection(ids, undefined, 'prev')).toBe('c')
  })

  it('selects nothing when stepping forward with nothing selected', () => {
    expect(stepSelection(ids, undefined, 'next')).toBeNull()
  })

  it('moves one block and clamps at both ends', () => {
    expect(stepSelection(ids, 'b', 'prev')).toBe('a')
    expect(stepSelection(ids, 'a', 'prev')).toBe('a')
    expect(stepSelection(ids, 'b', 'next')).toBe('c')
    expect(stepSelection(ids, 'c', 'next')).toBe('c')
  })

  it('restarts from the newest block when the selected one is gone', () => {
    expect(stepSelection(ids, 'gone', 'prev')).toBe('c')
    expect(stepSelection([], 'a', 'prev')).toBeNull()
  })
})

describe('scrollTargetFor', () => {
  it('does not scroll when the block start is already visible', () => {
    expect(scrollTargetFor({ start: 12, end: 14 }, 10, 5)).toBeNull()
  })

  it('scrolls to the block start when it is above or below the viewport', () => {
    expect(scrollTargetFor({ start: 3, end: 14 }, 10, 5)).toBe(3)
    expect(scrollTargetFor({ start: 15, end: 16 }, 10, 5)).toBe(15)
  })
})

describe('stickyBlock', () => {
  const first = block({
    id: 'a',
    promptLine: { line: 0 },
    inputLine: { line: 0 },
    endLine: { line: 40 },
  })
  const second = block({
    id: 'b',
    promptLine: { line: 40 },
    inputLine: { line: 40 },
    outputStartLine: { line: 41 },
    endLine: null,
  })

  it('shows the running block when its command line scrolled above the viewport', () => {
    expect(stickyBlock([first, second], 60, 90)?.id).toBe('b')
  })

  it('shows nothing when the command line is still visible', () => {
    expect(stickyBlock([first, second], 40, 90)).toBeNull()
  })

  it('shows an earlier block whose output fills the top of the viewport', () => {
    expect(stickyBlock([first, second], 20, 90)?.id).toBe('a')
  })

  it('shows nothing when the block above the viewport ended before it', () => {
    const done = block({ id: 'c', endLine: { line: 5 } })
    expect(stickyBlock([done], 10, 20)).toBeNull()
  })
})

describe('isIdlePrompt', () => {
  it('is idle only with an open draft and nothing running', () => {
    expect(isIdlePrompt({ drafts: { p: {} }, running: {} }, 'p')).toBe(true)
    expect(isIdlePrompt({ drafts: { p: {} }, running: { p: 'b1' } }, 'p')).toBe(false)
    expect(isIdlePrompt({ drafts: {}, running: {} }, 'p')).toBe(false)
  })
})

describe('collectHistory', () => {
  const origins = new Map([
    ['p1', { workspaceId: 's1', workspaceName: 'api' }],
    ['p2', { workspaceId: 's2', workspaceName: 'web' }],
  ])

  it('lists commands from every pane newest first, deduped by command text', () => {
    const history = collectHistory(
      {
        p1: [
          block({ id: 'a', command: 'make test', startedAt: 1 }),
          block({ id: 'b', command: 'git status', startedAt: 5 }),
        ],
        p2: [
          block({ id: 'c', paneId: 'p2', command: 'make test', startedAt: 9, cwd: '/web' }),
          block({ id: 'd', paneId: 'p2', command: '   ', startedAt: 10 }),
        ],
      },
      origins,
    )

    expect(history.map((h) => h.command)).toEqual(['make test', 'git status'])
    expect(history[0]).toMatchObject({ paneId: 'p2', workspaceName: 'web', cwd: '/web', at: 9 })
  })

  it('skips panes that no longer belong to a workspace', () => {
    const history = collectHistory({ gone: [block({ id: 'x', command: 'rm -rf x' })] }, origins)
    expect(history).toEqual([])
  })
})
