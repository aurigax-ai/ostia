import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { createPane, paneIds, resetIds, splitOf } from '@/lib/layout/tree'
import type { SplitNode } from '@/lib/layout/types'
import { useAttentionStore } from '@/stores/agents/attentionStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { FoldedSplitTab } from './FoldedSplitTab'

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
})

function folded(count: number): SplitNode {
  const panes = Array.from({ length: count }, (_, i) => createPane('terminal', `p${i}`))
  return { ...splitOf('horizontal', ...panes), name: 'workers', folded: true }
}

function setStates(
  tab: SplitNode,
  states: ReadonlyArray<'waiting' | 'working' | 'done' | 'error'>,
) {
  tab.children.forEach((pane, i) => {
    useAttentionStore.getState().dispatch(pane.id, {
      type: 'set',
      state: states[i] ?? 'working',
      at: i + 1,
    })
  })
}

function renderChip(tab: SplitNode) {
  return render(
    <TooltipProvider delay={0}>
      <FoldedSplitTab tab={tab} dropMark={null} workspaceId="w" entering={false} />
    </TooltipProvider>,
  )
}

describe('FoldedSplitTab', () => {
  it('shows the name and just the pane count', () => {
    renderChip(folded(12))
    const chip = document.querySelector('.pane-split-tab') as HTMLElement
    expect(chip).toHaveTextContent('workers12')
    expect(chip).not.toHaveTextContent('panes')
    expect(chip.querySelector('.pane-attn-mark')).toBeNull()
  })

  it('keeps the full breakdown in the label', () => {
    const tab = folded(4)
    setStates(tab, ['waiting', 'error', 'done', 'working'])
    renderChip(tab)
    expect(screen.getByRole('tab')).toHaveAccessibleName(
      'Folded split tab workers: 4 panes, 1 waiting, 1 failed, 1 working, 1 done',
    )
  })

  it('shows the breakdown on hover', async () => {
    const tab = folded(3)
    setStates(tab, ['done', 'done', 'working'])
    renderChip(tab)
    await userEvent.hover(screen.getByRole('tab'))
    expect((await screen.findAllByText('3 panes, 1 working, 2 done')).length).toBeGreaterThan(0)
  })

  it.each([
    ['waiting', 'waiting'],
    ['error', 'error'],
    ['done', 'done'],
  ] as const)('marks the chip %s with the pane-tab mark', (state, mark) => {
    const tab = folded(3)
    setStates(tab, ['working', state, 'working'])
    renderChip(tab)
    const chip = document.querySelector('.pane-split-tab') as HTMLElement
    expect(chip).toHaveAttribute('data-attention', mark)
    expect(chip.querySelector('.pane-attn-mark')).toBeInTheDocument()
  })

  it('shows the most urgent mark of the panes', () => {
    const tab = folded(3)
    setStates(tab, ['done', 'error', 'working'])
    renderChip(tab)
    expect(document.querySelector('.pane-split-tab')).toHaveAttribute('data-attention', 'error')
  })

  it('shows the grid icon, not the layout drawing', () => {
    renderChip(folded(3))
    const chip = document.querySelector('.pane-split-tab') as HTMLElement
    expect(chip.querySelector('svg.pane-kind')).toBeInTheDocument()
    expect(chip.querySelector('.split-tab-glyph')).toBeNull()
  })

  it('closes every pane of the split tab on a middle click', async () => {
    const tab = folded(3)
    const other = createPane('terminal', 'other')
    useWorkspacesStore.setState({
      workspaces: [{ id: 'w', name: 'w', kind: 'terminal', workDir: '/w', state: 'idle' }],
      activeWorkspaceId: 'w',
    })
    useLayoutStore.setState({
      byWorkspace: {
        w: {
          root: { type: 'tabs', id: 'tabs', activeId: other.id, children: [tab, other] },
          activePaneId: other.id,
          zoomedPaneId: null,
        },
      },
    })
    renderChip(tab)
    const chip = document.querySelector('.pane-split-tab') as HTMLElement
    fireEvent(chip, new MouseEvent('auxclick', { button: 1, bubbles: true }))
    await vi.waitFor(() => {
      const root = useLayoutStore.getState().byWorkspace.w?.root
      expect(root ? paneIds(root) : []).toEqual([other.id])
    })
  })
})
