import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPane, findPane, tabsOf } from '@/lib/layout/tree'
import type { PaneNode } from '@/lib/layout/types'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'

const typed: [string, string][] = []

vi.mock('@/lib/terminal/blockActions', () => ({
  runWhenIdle: vi.fn((paneId: string, command: string) => {
    typed.push([paneId, command])
    return vi.fn()
  }),
}))

const { forkConversation } = await import('./forkConversation')

function seed(pane: PaneNode): void {
  useLayoutStore.setState({
    byWorkspace: {
      w1: { root: tabsOf(pane.id, pane), activePaneId: pane.id, zoomedPaneId: null },
    },
  })
}

beforeEach(() => {
  typed.length = 0
})

describe('forkConversation', () => {
  it.each([
    ['claude', ["'claude' --resume a1 --fork-session", '/w/repo/.claude/worktrees/wt1']],
    ['codex', ["'codex' fork a1", '/w/b']],
  ] as const)(
    'forks a hibernated %s session in the folder it moved to, not the pane folder',
    (agent, [command, folder]) => {
      const pane: PaneNode = {
        ...createPane('terminal'),
        cwd: '/w/repo',
        hibernated: true,
        resume: { agent, id: 'a1', cwd: folder },
      }
      seed(pane)
      const forkId = forkConversation('w1', pane.id)
      expect(forkId).not.toBeNull()
      const root = useLayoutStore.getState().byWorkspace.w1.root
      expect(findPane(root, forkId as string)?.spawnDir).toBe(folder)
      expect(typed).toEqual([[forkId, command]])
    },
  )
})
