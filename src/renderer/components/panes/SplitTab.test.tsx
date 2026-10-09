import '@testing-library/jest-dom/vitest'
import { commands } from '@/commands/registry'
import { allPanes, createPane, nameSplitTabOf, resetIds, splitPane, tabsOf } from '@/layout/tree'
import type { LayoutNode, PaneNode, TabsNode } from '@/layout/types'
import { useAttentionStore } from '@/stores/agents/attentionStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Pane } from './Pane'
import { PaneTree } from './PaneTree'

let attentionInit: ReturnType<typeof useAttentionStore.getState>
let layoutInit: ReturnType<typeof useLayoutStore.getState>
let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>

beforeAll(() => {
  attentionInit = useAttentionStore.getState()
  layoutInit = useLayoutStore.getState()
  workspacesInit = useWorkspacesStore.getState()
})

afterEach(() => {
  cleanup()
  useAttentionStore.setState(attentionInit, true)
  useLayoutStore.setState(layoutInit, true)
  useWorkspacesStore.setState(workspacesInit, true)
  resetIds()
  vi.restoreAllMocks()
})

function terminal(title: string): PaneNode {
  return createPane('terminal', title)
}

function stackWithSplit(direction: 'horizontal' | 'vertical' = 'horizontal') {
  const [a, b, c] = [terminal('alpha'), terminal('beta'), terminal('gamma')]
  const root = splitPane(tabsOf(b.id, a, b), b.id, direction, c).root as TabsNode
  return { a, b, c, root }
}

function renderStack(root: TabsNode, activePaneId = root.activeId) {
  return render(
    <Pane
      tabs={root.children}
      shownId={root.activeId}
      activePaneId={activePaneId}
      workspaceId="w"
    />,
  )
}

describe('SplitTabPill', () => {
  it('draws one tab for the split tab that names its layout and panes', () => {
    const { root } = stackWithSplit()
    renderStack(root)
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(2)
    expect(
      screen.getByRole('tab', { name: 'Split tab, side by side: beta, gamma' }),
    ).toHaveAttribute('aria-selected', 'true')
  })

  it('shows the name before the segments when the split tab has one', () => {
    const { root, b } = stackWithSplit('vertical')
    const named = nameSplitTabOf(root, b.id, 'api') as TabsNode
    const { container } = renderStack(named)
    const pill = screen.getByRole('tab', { name: 'Split tab api, stacked: beta, gamma' })
    expect(within(pill).getByText('api')).toHaveClass('split-tab-name')
    expect(container.querySelectorAll('.split-tab-segment')).toHaveLength(2)
  })

  it('lays the segments straight in the tab row without a card around them', () => {
    const { root } = stackWithSplit()
    const { container } = renderStack(root)
    const pill = container.querySelector('.pane-split-tab') as HTMLElement
    const segments = pill.querySelectorAll(':scope > .split-tab-segment')
    expect(segments).toHaveLength(2)
  })

  it('draws the glyph from the real tree', () => {
    const { root, c } = stackWithSplit()
    const d = terminal('delta')
    const grid = splitPane(root, c.id, 'vertical', d).root as TabsNode
    const { container } = renderStack(grid)
    const glyph = container.querySelector('[data-split-glyph]')
    expect(glyph).toHaveAttribute('data-split-glyph', 'grid')
    expect(glyph?.querySelectorAll('.split-tab-glyph-pane')).toHaveLength(3)
    expect(
      glyph?.querySelector('.split-tab-glyph-split[data-direction="vertical"]'),
    ).toBeInTheDocument()
    expect(glyph?.querySelector('.split-tab-glyph-pane.focused')).toBeInTheDocument()
  })

  it('puts the attention mark on the segment whose pane needs the human', () => {
    const { root, b, c } = stackWithSplit()
    useAttentionStore.setState({
      byPane: { [c.id]: { state: 'waiting', unread: true, at: 1 } },
    })
    const { container } = renderStack(root)
    const waiting = container.querySelector(`[data-segment-id="${c.id}"]`)
    const calm = container.querySelector(`[data-segment-id="${b.id}"]`)
    expect(waiting).toHaveAttribute('data-attention', 'waiting')
    expect(waiting?.querySelector('.pane-attn-mark')).toBeInTheDocument()
    expect(calm).not.toHaveAttribute('data-attention')
    expect(calm?.querySelector('.pane-attn-mark')).toBeNull()
  })

  it('shows terminal segments by title alone and keeps the icon of other kinds', () => {
    const [a, b] = [terminal('alpha'), terminal('beta')]
    const web = createPane('browser', 'docs')
    const root = splitPane(tabsOf(b.id, a, b), b.id, 'horizontal', web).root as TabsNode
    const { container } = renderStack(root)
    const term = container.querySelector(`[data-segment-id="${b.id}"]`)
    const browser = container.querySelector(`[data-segment-id="${web.id}"]`)
    expect(term?.querySelector('.pane-kind')).toBeNull()
    expect(term?.querySelector('.title')).toHaveTextContent('beta')
    expect(browser?.querySelector('.pane-kind')).toBeInTheDocument()
    expect(container.querySelector(`[data-tab-id="${a.id}"] .pane-kind`)).toBeInTheDocument()
  })

  it('focuses the pane of a clicked segment', () => {
    const exec = vi.spyOn(commands, 'exec').mockResolvedValue({ ok: true, result: undefined })
    const { root, c } = stackWithSplit()
    const { container } = renderStack(root)
    const segment = container.querySelector(`[data-segment-id="${c.id}"] .split-tab-segment-main`)
    fireEvent.click(segment as Element)
    expect(exec).toHaveBeenCalledWith('pane.focus', { paneId: c.id })
  })

  it('closes one pane from its segment', () => {
    const exec = vi.spyOn(commands, 'exec').mockResolvedValue({ ok: true, result: undefined })
    const { root, c } = stackWithSplit()
    renderStack(root)
    fireEvent.click(screen.getByRole('button', { name: 'Close gamma' }))
    expect(exec).toHaveBeenCalledWith('pane.close', { paneId: c.id })
  })

  it('moves between segments with the arrow keys', () => {
    const { root } = stackWithSplit()
    const { container } = renderStack(root)
    const pill = container.querySelector('.pane-split-tab') as HTMLElement
    const [first, second] = [...pill.querySelectorAll<HTMLElement>('.split-tab-segment-main')]
    act(() => first.focus())
    fireEvent.keyDown(pill, { key: 'ArrowRight' })
    expect(second).toHaveFocus()
    fireEvent.keyDown(pill, { key: 'ArrowLeft' })
    expect(first).toHaveFocus()
  })
})

describe('split tab body', () => {
  it('shows one cell per pane and focuses the cell a click lands in', () => {
    const exec = vi.spyOn(commands, 'exec').mockResolvedValue({ ok: true, result: undefined })
    const { root, b, c } = stackWithSplit()
    const { container } = renderStack(root, b.id)
    const cells = container.querySelectorAll('.pane-cell')
    expect([...cells].map((cell) => (cell as HTMLElement).dataset.cellId)).toEqual([b.id, c.id])
    expect(container.querySelector(`[data-cell-id="${b.id}"]`)).toHaveClass('focused')
    cells[1].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(exec).toHaveBeenCalledWith('pane.focus', { paneId: c.id })
    exec.mockClear()
    cells[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(exec).not.toHaveBeenCalled()
  })

  it('keeps a background split tab mounted but hidden and inert', () => {
    const { root, a } = stackWithSplit()
    const background = { ...root, activeId: a.id }
    const { container } = renderStack(background)
    const body = container.querySelector('.pane-split-body') as HTMLElement
    expect(body).toHaveAttribute('data-hidden')
    expect(body.inert).toBe(true)
    expect(body.querySelectorAll('.pane-cell')).toHaveLength(2)
  })
})

describe('split tab in the workspace tree', () => {
  function seed(root: LayoutNode, activePaneId: string): void {
    useWorkspacesStore.setState({
      workspaces: [{ id: 'w', name: 'w', kind: 'terminal', workDir: '/w' } as never],
      activeWorkspaceId: 'w',
    })
    useLayoutStore.setState({ byWorkspace: { w: { root, activePaneId, zoomedPaneId: null } } })
  }

  it('turns the shown tab into a split tab when the human splits inside a stack', () => {
    const [a, b] = [terminal('alpha'), terminal('beta')]
    seed(tabsOf(b.id, a, b), b.id)
    render(<PaneTree workspaceId="w" />)
    act(() => useLayoutStore.getState().split('w', b.id, 'horizontal'))
    expect(document.querySelector('.pane-split-tab')).toBeInTheDocument()
    expect(document.querySelectorAll('.pane')).toHaveLength(1)
  })

  it('a split tab of four panes shows each title as a readable segment', () => {
    const [a, b] = [terminal('alpha'), terminal('beta')]
    seed(tabsOf(b.id, a, b), b.id)
    render(<PaneTree workspaceId="w" />)
    for (const count of [2, 3, 4]) {
      act(() => {
        const { split, byWorkspace } = useLayoutStore.getState()
        split('w', byWorkspace.w.activePaneId, 'horizontal')
      })
      expect(document.querySelectorAll('.split-tab-segment')).toHaveLength(count)
    }
    const segments = [...document.querySelectorAll('.split-tab-segment')]
    expect(document.querySelectorAll('.split-tab-segment .pane-kind')).toHaveLength(0)
    expect(document.querySelector('.pane-split-tab .split-tab-glyph')).toBeInTheDocument()
    const split = (useLayoutStore.getState().byWorkspace.w.root as TabsNode).children[1]
    expect(segments.map((s) => s.querySelector('.title')?.textContent)).toEqual(
      allPanes(split).map((p) => p.title),
    )
  })

  it('goes back to a plain tab when its panes close down to one', () => {
    const { root, b, c } = stackWithSplit()
    seed(root, b.id)
    render(<PaneTree workspaceId="w" />)
    expect(document.querySelector('.pane-split-tab')).toBeInTheDocument()
    act(() => useLayoutStore.getState().closePane('w', c.id))
    expect(document.querySelector('.pane-split-tab')).toBeNull()
    expect(screen.getAllByRole('tab')).toHaveLength(2)
    expect(useLayoutStore.getState().byWorkspace.w.activePaneId).toBe(b.id)
  })

  it('refuses to close a locked pane inside a split tab', () => {
    const { root, c } = stackWithSplit()
    seed(root, c.id)
    useLayoutStore.getState().setLocked('w', c.id, true)
    useLayoutStore.getState().closePane('w', c.id)
    expect(useLayoutStore.getState().byWorkspace.w.root).toMatchObject({ type: 'tabs' })
    render(<PaneTree workspaceId="w" />)
    expect(document.querySelector('.pane-split-tab')).toBeInTheDocument()
  })
})
