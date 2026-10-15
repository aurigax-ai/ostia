import '@testing-library/jest-dom/vitest'
import { registerPaneLayoutCommands } from '@/commands/core/paneLayoutCommands'
import { registerPaneTabCommands } from '@/commands/paneTabCommands'
import { commands } from '@/commands/registry'
import { createPane, findPane, resetIds, splitOf, tabsOf } from '@/lib/layout/tree'
import type { PaneNode } from '@/lib/layout/types'
import { useAttentionStore } from '@/stores/agents/attentionStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { PaneTree } from './PaneTree'

let attentionInit: ReturnType<typeof useAttentionStore.getState>
let layoutInit: ReturnType<typeof useLayoutStore.getState>
let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>

beforeAll(() => {
  attentionInit = useAttentionStore.getState()
  layoutInit = useLayoutStore.getState()
  workspacesInit = useWorkspacesStore.getState()
  if (!commands.has('pane.collapse')) registerPaneTabCommands()
  if (!commands.has('pane.focus')) registerPaneLayoutCommands()
  commands.setContextProvider(() => ({
    activeWorkspaceId: useWorkspacesStore.getState().activeWorkspaceId,
    activePaneId: useLayoutStore.getState().byWorkspace.w?.activePaneId ?? null,
  }))
})

afterAll(() => {
  commands.setContextProvider(() => ({ activeWorkspaceId: null, activePaneId: null }))
})

afterEach(() => {
  cleanup()
  useAttentionStore.setState(attentionInit, true)
  useLayoutStore.setState(layoutInit, true)
  useWorkspacesStore.setState(workspacesInit, true)
  resetIds()
})

function workers() {
  const [lone, a, b, c] = ['shell', 'alpha', 'beta', 'gamma'].map(
    (title): PaneNode => createPane('terminal', title),
  )
  const tab = { ...splitOf('horizontal', a, b, c), name: 'workers' }
  useWorkspacesStore.setState({
    workspaces: [{ id: 'w', name: 'w', kind: 'terminal', workDir: '/w', state: 'idle' }],
    activeWorkspaceId: 'w',
  })
  useLayoutStore.setState({
    byWorkspace: { w: { root: tabsOf(b.id, lone, tab), activePaneId: b.id, zoomedPaneId: null } },
  })
  return { a, b, c, ...render(<PaneTree workspaceId="w" />) }
}

function layout() {
  return useLayoutStore.getState().byWorkspace.w
}

describe('collapsed split tab panes', () => {
  it('collapses a pane from its segment into a strip with its title, state and attention', async () => {
    const { a, container } = workers()
    act(() => useAttentionStore.getState().dispatch(a.id, { type: 'set', state: 'done', at: 1 }))

    await userEvent.click(screen.getByRole('button', { name: 'Collapse alpha' }))

    expect(container.querySelector(`[data-cell-id="${a.id}"]`)).toBeNull()
    const strip = container.querySelector(`[data-strip-id="${a.id}"]`) as HTMLElement
    expect(strip).toHaveAttribute('data-attention', 'done')
    expect(strip).toHaveAttribute('data-across', 'horizontal')
    expect(within(strip).getByText('alpha')).toBeInTheDocument()
    expect(within(strip).getByText('Done')).toBeInTheDocument()
    const slot = strip.querySelector('.pane-slot') as HTMLElement
    expect(slot).toHaveAttribute('data-hidden')
    expect(slot.inert).toBe(true)
  })

  it('expands a strip on a click and focuses its pane', async () => {
    const { a, container } = workers()
    act(() => useLayoutStore.getState().changeCollapse('w', a.id, 'collapse'))
    const strip = container.querySelector(`[data-strip-id="${a.id}"]`) as HTMLElement

    await userEvent.click(within(strip).getByRole('button', { name: 'Expand alpha' }))

    expect(container.querySelector(`[data-strip-id="${a.id}"]`)).toBeNull()
    expect(container.querySelector(`[data-cell-id="${a.id}"]`)).not.toBeNull()
    expect(layout().activePaneId).toBe(a.id)
  })

  it('moves the focus to the next expanded pane when the active pane collapses', async () => {
    const { b, c } = workers()
    await act(() => commands.exec('pane.collapse'))
    expect(findPane(layout().root, b.id)?.collapsed).toBe(true)
    expect(layout().activePaneId).toBe(c.id)
  })

  it('offers no collapse for the last expanded pane', async () => {
    const { a, b, c } = workers()
    await act(() => commands.exec('pane.collapseOthers', { paneId: b.id }))
    expect(findPane(layout().root, a.id)?.collapsed).toBe(true)
    expect(findPane(layout().root, c.id)?.collapsed).toBe(true)
    expect(screen.queryByRole('button', { name: 'Collapse beta' })).toBeNull()

    await act(() => commands.exec('pane.expandAll', { paneId: b.id }))
    expect(screen.getByRole('button', { name: 'Collapse beta' })).toBeInTheDocument()
    expect(document.querySelectorAll('.pane-strip')).toHaveLength(0)
  })
})
