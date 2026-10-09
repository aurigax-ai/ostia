import '@testing-library/jest-dom/vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { commands } from '@/commands/registry'
import { TooltipProvider } from '@/components/ui/tooltip'
import { createPane, resetIds, splitPane, tabsOf } from '@/layout/tree'
import type { PaneNode, TabsNode } from '@/layout/types'
import { hiddenTabs, revealScroll } from '@/lib/tabRow'
import { useAttentionStore } from '@/stores/attentionStore'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Pane } from './Pane'

const TAB_W = 100
const ROW_W = 300

let attentionInit: ReturnType<typeof useAttentionStore.getState>

beforeAll(() => {
  attentionInit = useAttentionStore.getState()
})

afterEach(() => {
  cleanup()
  useAttentionStore.setState(attentionInit, true)
  resetIds()
  vi.restoreAllMocks()
})

function tabIndex(el: HTMLElement): number {
  const row = el.closest('[role="tablist"]')
  const tabs = row ? [...row.querySelectorAll('[data-tab-id]')] : []
  return tabs.indexOf(el)
}

function layOut(): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.getAttribute('role') === 'tablist') return new DOMRect(0, 0, ROW_W, 34)
    const at = tabIndex(this)
    if (at === -1) return new DOMRect(0, 0, 0, 0)
    const row = this.closest<HTMLElement>('[role="tablist"]')
    const left = at * TAB_W - (row?.scrollLeft ?? 0)
    return new DOMRect(left, 0, TAB_W, 34)
  })
  vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return Math.max(tabIndex(this), 0) * TAB_W
  })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(TAB_W)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(ROW_W)
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.querySelectorAll('[data-tab-id]').length * TAB_W
  })
}

function stackOf(count: number, shown = 0) {
  const panes: PaneNode[] = Array.from({ length: count }, (_, i) =>
    createPane('terminal', `tab ${i}`, `/work/tab-${i}`),
  )
  return { panes, root: tabsOf(panes[shown].id, ...panes) }
}

function renderStack(root: TabsNode) {
  return render(
    <TooltipProvider delay={0}>
      <Pane
        tabs={root.children}
        shownId={root.activeId}
        activePaneId={root.activeId}
        workspaceId="w"
      />
    </TooltipProvider>,
  )
}

function tablist(): HTMLElement {
  return screen.getByRole('tablist')
}

describe('tab row helpers', () => {
  it('counts a tab as hidden on the side its middle is past', () => {
    const view = { left: 0, right: 300 }
    const tabs = [
      { id: 'a', left: -100, right: 0 },
      { id: 'b', left: -40, right: 60 },
      { id: 'c', left: 250, right: 350 },
      { id: 'd', left: 300, right: 400 },
    ]
    expect(hiddenTabs(view, tabs)).toEqual({ start: ['a'], end: ['d'] })
  })

  it('scrolls just far enough to show a tab', () => {
    expect(revealScroll(0, 300, 100, 100)).toBe(0)
    expect(revealScroll(0, 300, 500, 100)).toBe(300)
    expect(revealScroll(400, 300, 100, 100)).toBe(100)
  })
})

describe('TabRow', () => {
  it('sizes every tab and segment from the max and min width tokens', () => {
    const css = readFileSync(join(__dirname, '..', '..', 'index.css'), 'utf8')
    const rule = (selector: string) => css.slice(css.indexOf(`${selector} {`)).split('}')[0]
    expect(css).toMatch(/--tab-max-w: 200px;/)
    expect(css).toMatch(/--tab-min-w: 96px;/)
    expect(rule('.pane-tab')).toMatch(/flex: 0 1 var\(--tab-max-w\)/)
    expect(rule('.pane-tab')).toMatch(/min-width: var\(--tab-min-w\)/)
    expect(rule('.pane-tab')).toMatch(/max-width: var\(--tab-max-w\)/)
    expect(rule('.split-tab-segment')).toMatch(/min-width: var\(--tab-min-w\)/)
    expect(rule('.split-tab-segment')).toMatch(/max-width: var\(--tab-max-w\)/)
    expect(rule('.pane-tab .title')).toMatch(/text-overflow: ellipsis/)

    const [a, b, c] = ['a', 'b', 'c'].map((t) => createPane('terminal', t))
    const root = splitPane(tabsOf(b.id, a, b), b.id, 'horizontal', c).root as TabsNode
    const { container } = renderStack(root)
    const split = container.querySelector<HTMLElement>('.pane-split-tab')
    expect(split?.style.getPropertyValue('--split-segments')).toBe('2')
  })

  it('shows the full title and the folder of a terminal on hover', async () => {
    const { root } = stackOf(2)
    renderStack(root)
    await userEvent.hover(screen.getByRole('tab', { name: /tab 1/ }))
    expect(await screen.findByText('/work/tab-1')).toBeInTheDocument()
    expect(screen.getAllByText('tab 1').length).toBeGreaterThan(1)
  })

  it('has no All tabs button while every tab fits', () => {
    layOut()
    const { root } = stackOf(3)
    renderStack(root)
    expect(screen.queryByRole('button', { name: /All tabs/ })).toBeNull()
  })

  it('lists every tab behind All tabs once some are hidden and shows the picked one', async () => {
    layOut()
    const exec = vi.spyOn(commands, 'exec').mockResolvedValue({ ok: true, result: undefined })
    const { panes, root } = stackOf(6)
    renderStack(root)
    await userEvent.click(screen.getByRole('button', { name: /All tabs/ }))
    const options = await screen.findAllByRole('option')
    expect(options).toHaveLength(6)
    await userEvent.type(screen.getByPlaceholderText('Search tabs'), 'tab 5')
    await userEvent.keyboard('{Enter}')
    expect(exec).toHaveBeenCalledWith('pane.focus', { paneId: panes[5].id })
  })

  it('keeps the shown tab in view', () => {
    layOut()
    const { root } = stackOf(8, 6)
    renderStack(root)
    expect(tablist().scrollLeft).toBe(6 * TAB_W + TAB_W - ROW_W)
  })

  it('marks the edge that hides a tab needing the human and scrolls to it', () => {
    layOut()
    const { panes, root } = stackOf(8)
    useAttentionStore.setState({
      byPane: { [panes[6].id]: { state: 'waiting', unread: true, at: 1 } },
    })
    renderStack(root)
    const marker = screen.getByRole('button', { name: 'Hidden tabs that need you: 1' })
    expect(marker).toHaveAttribute('data-edge', 'end')
    expect(screen.queryByRole('button', { name: /Hidden tabs.*start/ })).toBeNull()
    fireEvent.click(marker)
    expect(tablist().scrollLeft).toBe(6 * TAB_W + TAB_W - ROW_W)
  })

  it('does not mark an edge for a hidden tab that needs nothing', () => {
    layOut()
    const { root } = stackOf(8)
    renderStack(root)
    expect(screen.queryByRole('button', { name: /Hidden tabs that need you/ })).toBeNull()
  })

  it('holds tab widths while the pointer is on the row and lets go when it leaves', () => {
    layOut()
    const { panes, root } = stackOf(4)
    const { rerender } = renderStack(root)
    const row = tablist().parentElement as HTMLElement
    fireEvent.pointerDown(row)
    const kept = tablist().querySelector<HTMLElement>(`[data-tab-id="${panes[1].id}"]`)
    expect(kept?.style.width).toBe(`${TAB_W}px`)
    expect(kept?.style.flex).toBe('0 0 auto')

    const fewer = tabsOf(panes[1].id, panes[1], panes[2], panes[3])
    act(() => {
      rerender(
        <TooltipProvider delay={0}>
          <Pane
            tabs={fewer.children}
            shownId={fewer.activeId}
            activePaneId={fewer.activeId}
            workspaceId="w"
          />
        </TooltipProvider>,
      )
    })
    expect(kept?.style.width).toBe(`${TAB_W}px`)

    fireEvent.pointerLeave(row)
    expect(kept?.style.width).toBe('')
    expect(kept?.style.flex).toBe('')
  })
})
