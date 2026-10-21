import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { registerPaneLayoutCommands } from '@/commands/core/paneLayoutCommands'
import { registerPaneTabCommands } from '@/commands/paneTabCommands'
import { commands } from '@/commands/registry'
import { createPane, findPane, resetIds, splitOf, tabsOf } from '@/lib/layout/tree'
import type { PaneNode } from '@/lib/layout/types'
import { useAttentionStore } from '@/stores/agents/attentionStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
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

  it('fades a strip face in only when the human collapses it, never at first render', async () => {
    const { a, container } = workers()
    expect(container.querySelector('.motion-fade')).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'Collapse alpha' }))

    const strip = container.querySelector(`[data-strip-id="${a.id}"]`) as HTMLElement
    expect(strip.querySelector('.pane-strip-main')).toHaveClass('motion-fade')
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

describe('folded split tab', () => {
  it('folds from the pill into one chip with its pane count and the attention mark', async () => {
    const { a, b, c, container } = workers()
    act(() => {
      useAttentionStore.getState().dispatch(a.id, { type: 'set', state: 'working', at: 1 })
      useAttentionStore.getState().dispatch(c.id, { type: 'set', state: 'waiting', at: 2 })
    })

    await userEvent.click(screen.getByRole('button', { name: 'Fold workers' }))

    const chip = await screen.findByRole('tab', {
      name: 'Folded split tab workers: 3 panes, 1 waiting, 1 working',
    })
    expect(chip).toHaveAttribute('aria-expanded', 'false')
    expect(chip.closest('.pane-split-tab')).toHaveAttribute('data-attention', 'waiting')
    expect(within(chip).getByText('3')).toBeInTheDocument()
    expect(container.querySelectorAll('.split-tab-segment')).toHaveLength(0)
    expect(findPane(layout().root, b.id)).not.toBeNull()
    expect(layout().activePaneId).not.toBe(b.id)
  })

  it('fades the chip and the unfolded pill in only after the human toggles them', async () => {
    const { container } = workers()
    expect(container.querySelector('.pane-split-tab.motion-fade')).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'Fold workers' }))
    const face = await screen.findByRole('tab', { name: /^Folded split tab workers/ })
    const chip = face.closest('.pane-split-tab') as HTMLElement
    expect(chip).toHaveClass('motion-fade')

    await userEvent.click(within(chip).getByRole('tab'))
    const pill = container.querySelector('.pane-split-tab') as HTMLElement
    expect(pill).not.toHaveClass('folded')
    expect(pill).toHaveClass('motion-fade')
  })

  it('does not fade a split tab that was created, only one that was folded or unfolded', async () => {
    const { b, container } = workers()
    const [x, y] = ['x', 'y'].map((title): PaneNode => createPane('terminal', title))
    const existing = layout().root
    if (existing.type !== 'tabs') throw new Error('expected tabs')
    act(() =>
      useLayoutStore.setState({
        byWorkspace: {
          w: {
            root: { ...existing, children: [...existing.children, splitOf('horizontal', x, y)] },
            activePaneId: b.id,
            zoomedPaneId: null,
          },
        },
      }),
    )

    expect(container.querySelectorAll('.pane-split-tab')).toHaveLength(2)
    expect(container.querySelector('.pane-split-tab.motion-fade')).toBeNull()
  })

  it('unfolds and shows its panes when the chip is clicked', async () => {
    const { a, container } = workers()
    await act(() => commands.exec('pane.foldSplitTab'))
    const chip = container.querySelector('.pane-split-tab.folded') as HTMLElement

    await userEvent.click(within(chip).getByRole('tab'))

    expect(container.querySelector('.pane-split-tab.folded')).toBeNull()
    expect(container.querySelectorAll('.split-tab-segment')).toHaveLength(3)
    expect(layout().activePaneId).toBe(a.id)
  })
})
