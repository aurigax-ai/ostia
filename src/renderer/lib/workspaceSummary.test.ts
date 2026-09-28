import { describe, expect, it } from 'vitest'
import type { PaneNode } from '../layout/types'
import { latestUnreadMessage, runningTitle } from './workspaceSummary'

const pane = (id: string, title = 'zsh', kind: PaneNode['kind'] = 'terminal'): PaneNode => ({
  type: 'pane',
  id,
  title,
  kind,
})

describe('latestUnreadMessage', () => {
  it('shows the newest unread message across the workspace’s panes', () => {
    const byPane = {
      a: { state: 'done' as const, unread: true, message: 'tests passed', at: 1 },
      b: { state: 'waiting' as const, unread: true, message: 'Claude needs permission', at: 2 },
    }
    expect(latestUnreadMessage([pane('a'), pane('b')], byPane)).toBe('Claude needs permission')
  })

  it('ignores read messages and panes outside the workspace', () => {
    const byPane = {
      a: { state: 'done' as const, unread: false, message: 'old', at: 5 },
      z: { state: 'waiting' as const, unread: true, message: 'elsewhere', at: 9 },
    }
    expect(latestUnreadMessage([pane('a')], byPane)).toBeNull()
  })
})

describe('runningTitle', () => {
  it('prefers the active pane’s program title while it runs', () => {
    const panes = [pane('a', 'npm run dev'), pane('b', '✳ Review PR')]
    expect(runningTitle(panes, 'b', { a: 'blk1', b: 'blk2' })).toBe('✳ Review PR')
  })

  it('falls back to any running terminal and shows nothing at an idle prompt', () => {
    const panes = [pane('a', '~'), pane('b', 'vim notes.md')]
    expect(runningTitle(panes, 'a', { b: 'blk' })).toBe('vim notes.md')
    expect(runningTitle(panes, 'a', {})).toBeNull()
  })
})
