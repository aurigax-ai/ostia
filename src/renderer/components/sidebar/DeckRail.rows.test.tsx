import { act, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import type { Workspace } from '@/stores/workspaces/workspaceTypes'
import { renderSettled } from '../../../../test/render'
import { DeckRail } from './DeckRail'

const renders = vi.hoisted(() => new Map<string, number>())

vi.mock('./WorkspaceMenu', () => ({
  WorkspaceMenu: ({ workspace }: { workspace: { id: string } }) => {
    renders.set(workspace.id, (renders.get(workspace.id) ?? 0) + 1)
    return null
  },
}))

const workspaces = (): Workspace[] =>
  Array.from({ length: 30 }, (_, i) => ({
    id: `s${i}`,
    name: `ws${i}`,
    kind: 'terminal',
    workDir: `/home/u/p${i}`,
    state: 'idle',
  }))

beforeEach(() => {
  renders.clear()
  useWorkspacesStore.setState({ workspaces: workspaces(), activeWorkspaceId: 's0' })
})

afterEach(cleanup)

describe('DeckRail rows', () => {
  it('re-renders only the row whose workspace changed', async () => {
    await renderSettled(<DeckRail />)
    const before = new Map(renders)
    await act(async () => {
      useWorkspacesStore.setState((s) => ({
        workspaces: s.workspaces.map((w) => (w.id === 's5' ? { ...w, state: 'working' } : w)),
      }))
    })
    const rerendered = [...renders]
      .filter(([id, count]) => count !== before.get(id))
      .map(([id]) => id)
    expect(rerendered).toEqual(['s5'])
  })
})
