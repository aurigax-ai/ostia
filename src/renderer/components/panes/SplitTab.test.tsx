import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { registerPaneTabCommands } from '@/commands/paneTabCommands'
import { commands } from '@/commands/registry'
import {
  allPanes,
  createPane,
  resetIds,
  setSplitTabName,
  splitPane,
  tabIdOf,
  tabsOf,
} from '@/lib/layout/tree'
import type { LayoutNode, PaneNode, TabsNode } from '@/lib/layout/types'
import { useAttentionStore } from '@/stores/agents/attentionStore'
import { type CommandBlock, useBlocksStore } from '@/stores/terminal/blocksStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { usePaneRenameStore } from '@/stores/workspaces/paneRenameStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { Pane } from './Pane'
import { PaneTree } from './PaneTree'

let attentionInit: ReturnType<typeof useAttentionStore.getState>
let layoutInit: ReturnType<typeof useLayoutStore.getState>
let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
let blocksInit: ReturnType<typeof useBlocksStore.getState>

beforeAll(() => {
  attentionInit = useAttentionStore.getState()
  layoutInit = useLayoutStore.getState()
  workspacesInit = useWorkspacesStore.getState()
  blocksInit = useBlocksStore.getState()
})

afterEach(() => {
  cleanup()
  useAttentionStore.setState(attentionInit, true)
  useLayoutStore.setState(layoutInit, true)
  useWorkspacesStore.setState(workspacesInit, true)
  useBlocksStore.setState(blocksInit, true)
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

describe('split tab session warning', () => {
  it('warns in the split cell whose session runs in another tab', () => {
    const resume = { agent: 'claude' as const, id: 'sess-split' }
    const a = { ...terminal('alpha'), resume }
    const b = { ...terminal('beta'), resume, resumePending: true as const }
    const c = terminal('gamma')
    const root = splitPane(tabsOf(b.id, a, b), b.id, 'horizontal', c).root as TabsNode
    useLayoutStore.setState({
      byWorkspace: { w: { root, activePaneId: b.id, zoomedPaneId: null } },
    })
    useBlocksStore.setState({
      running: { [a.id]: 'run-a' },
      byPane: {
        [a.id]: [
          { id: 'run-a', paneId: a.id, command: 'claude --resume sess-split', startedAt: 0 },
        ] as unknown as CommandBlock[],
      },
      agentBlocks: { [a.id]: { blockId: 'run-a', agent: 'claude' } },
    })
    const { container } = renderStack(root, b.id)
    const cell = container.querySelector(`[data-cell-id="${b.id}"]`) as HTMLElement
    const notice = within(cell).getByRole('region', { name: 'Agent session open twice' })
    expect(within(notice).getByText(/“alpha”/)).toBeInTheDocument()
    const other = container.querySelector(`[data-cell-id="${c.id}"]`) as HTMLElement
    expect(within(other).queryByRole('region', { name: 'Agent session open twice' })).toBeNull()
  })
})

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
    const named = setSplitTabName(root, tabIdOf(root, b.id) ?? '', 'api') as TabsNode
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

  it('folds when its head is clicked a double-click interval later, at once from the keyboard', () => {
    vi.useFakeTimers()
    const exec = vi.spyOn(commands, 'exec').mockResolvedValue({ ok: true, result: undefined })
    const { root } = stackWithSplit()
    renderStack(root)
    const head = screen.getByRole('button', { name: 'Fold split tab' })
    expect(head).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(head, { detail: 1 })
    expect(exec).not.toHaveBeenCalledWith('pane.foldSplitTab', expect.anything())
    vi.advanceTimersByTime(1000)
    expect(exec).toHaveBeenCalledWith('pane.foldSplitTab', { tabId: expect.any(String) })
    exec.mockClear()
    fireEvent.click(head, { detail: 0 })
    expect(exec).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('keeps a double-click on the head for rename and never folds', () => {
    vi.useFakeTimers()
    const exec = vi.spyOn(commands, 'exec').mockResolvedValue({ ok: true, result: undefined })
    const { root } = stackWithSplit()
    renderStack(root)
    const head = screen.getByRole('button', { name: 'Fold split tab' })
    fireEvent.click(head, { detail: 1 })
    fireEvent.click(head, { detail: 2 })
    fireEvent.doubleClick(head)
    vi.advanceTimersByTime(1000)
    expect(exec).not.toHaveBeenCalledWith('pane.foldSplitTab', expect.anything())
    expect(screen.getByRole('textbox')).toBeInTheDocument()
    act(() => usePaneRenameStore.getState().end())
    vi.useRealTimers()
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

describe('split tab segment rename', () => {
  afterEach(() => act(() => usePaneRenameStore.getState().end()))

  it('arrow keys move the caret in the rename field and the pill cannot be dragged meanwhile', () => {
    vi.spyOn(commands, 'exec').mockResolvedValue({ ok: true, result: undefined })
    const { c, root } = stackWithSplit()
    const { container } = renderStack(root, c.id)
    const pill = container.querySelector('.pane-split-tab') as HTMLElement
    expect(pill).toHaveAttribute('draggable', 'true')
    const segment = container.querySelector(`[data-segment-id="${c.id}"]`) as HTMLElement
    fireEvent.doubleClick(segment.querySelector('.split-tab-segment-main') as HTMLElement)
    const input = screen.getByRole('textbox', { name: 'Rename Tab…' })
    expect(input).toHaveFocus()
    expect(pill).toHaveAttribute('draggable', 'false')
    fireEvent.keyDown(input, { key: 'ArrowLeft' })
    fireEvent.keyDown(input, { key: 'ArrowRight' })
    expect(screen.getByRole('textbox', { name: 'Rename Tab…' })).toHaveFocus()
  })

  it('arrow keys inside a split segment rename move the caret and keep the edit open', async () => {
    const { c, root } = stackWithSplit()
    useLayoutStore.setState({
      byWorkspace: { w: { root, activePaneId: c.id, zoomedPaneId: null } },
    })
    const { container } = renderStack(root, c.id)
    const user = userEvent.setup()
    const segment = container.querySelector(`[data-segment-id="${c.id}"]`) as HTMLElement
    await user.dblClick(segment.querySelector('.split-tab-segment-main') as HTMLElement)
    const input = screen.getByRole('textbox', { name: 'Rename Tab…' })
    expect(input).toHaveFocus()

    await user.keyboard('abc{ArrowLeft}{ArrowLeft}')
    expect(input).toHaveFocus()
    await user.keyboard('X{Enter}')

    expect(screen.queryByRole('textbox', { name: 'Rename Tab…' })).toBeNull()
    expect(allPanes(useLayoutStore.getState().byWorkspace.w.root)).toContainEqual(
      expect.objectContaining({ id: c.id, title: 'aXbc', titlePinned: true }),
    )
  })
})

describe('naming a split tab', () => {
  function seedStack(name?: string) {
    const { b, c, root } = stackWithSplit()
    const tabId = tabIdOf(root, b.id) ?? ''
    const tree = name ? (setSplitTabName(root, tabId, name) as TabsNode) : root
    useLayoutStore.setState({
      byWorkspace: { w: { root: tree, activePaneId: b.id, zoomedPaneId: null } },
    })
    render(<PaneTree workspaceId="w" />)
    return { b, c, tabId }
  }

  const nameOf = (tabId: string): string | undefined => {
    const root = useLayoutStore.getState().byWorkspace.w.root as TabsNode
    const tab = root.children.find((t) => t.id === tabId)
    return tab?.type === 'split' ? tab.name : undefined
  }

  afterEach(() => {
    act(() => usePaneRenameStore.getState().end())
  })

  it('names an unnamed split tab from a double-click on its layout glyph, saved on Enter', () => {
    const { tabId } = seedStack()
    const glyph = document.querySelector('.pane-split-tab .split-tab-glyph') as HTMLElement
    fireEvent.doubleClick(glyph)
    const field = screen.getByRole('textbox', { name: 'Rename Split Tab…' })
    fireEvent.change(field, { target: { value: '  workers  ' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(nameOf(tabId)).toBe('workers')
    expect(screen.getByText('workers')).toHaveClass('split-tab-name')
  })

  it('renames from a double-click on the name, clears on an empty name and keeps it on Escape', () => {
    const { tabId } = seedStack('api')
    fireEvent.doubleClick(screen.getByText('api'))
    const field = screen.getByRole('textbox', { name: 'Rename Split Tab…' })
    expect(field).toHaveValue('api')
    fireEvent.change(field, { target: { value: 'web' } })
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(nameOf(tabId)).toBe('api')

    fireEvent.doubleClick(screen.getByText('api'))
    const again = screen.getByRole('textbox', { name: 'Rename Split Tab…' })
    fireEvent.change(again, { target: { value: '   ' } })
    fireEvent.keyDown(again, { key: 'Enter' })
    expect(nameOf(tabId)).toBeUndefined()
    expect(document.querySelector('.split-tab-name')).toBeNull()
  })

  it('gives the name pane move --tab and --tab use, so agents join the renamed tab', () => {
    const { tabId } = seedStack('api')
    act(() => useLayoutStore.getState().renameSplitTab('w', tabId, 'review'))
    const d = createPane('terminal', 'delta')
    act(() => {
      const layout = useLayoutStore.getState().byWorkspace.w
      useLayoutStore.setState({
        byWorkspace: {
          w: {
            ...layout,
            root: {
              ...(layout.root as TabsNode),
              children: [...(layout.root as TabsNode).children, d],
            },
          },
        },
      })
    })
    act(() => {
      useLayoutStore.getState().joinTab('w', [d.id], 'review')
    })
    const root = useLayoutStore.getState().byWorkspace.w.root as TabsNode
    const tab = root.children.find((t) => t.id === tabId)
    expect(tab && allPanes(tab).map((p) => p.id)).toContain(d.id)
  })

  it('starts naming from the palette only when the active pane is in a split tab', async () => {
    const { tabId } = seedStack()
    if (!commands.has('pane.renameSplitTab')) registerPaneTabCommands()
    expect(commands.isLocal('pane.renameSplitTab')).toBe(true)
    await act(async () => {
      await commands.execWith(
        {
          activeWorkspaceId: 'w',
          activePaneId: useLayoutStore.getState().byWorkspace.w.activePaneId,
        },
        'pane.renameSplitTab',
      )
    })
    expect(usePaneRenameStore.getState().splitTabId).toBe(tabId)
    expect(screen.getByRole('textbox', { name: 'Rename Split Tab…' })).toHaveValue('')
  })
})
