import '@testing-library/jest-dom/vitest'
import { commands } from '@/commands/registry'
import type { LayoutNode, PaneNode } from '@/layout/types'
import { useLayoutStore } from '@/stores/layoutStore'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { PaneTabMenu } from './PaneTabMenu'

const left: PaneNode = { type: 'pane', id: 'left', kind: 'terminal', title: 'zsh' }
const right: PaneNode = { type: 'pane', id: 'right', kind: 'terminal', title: 'claude' }
const split: LayoutNode = {
  type: 'split',
  id: 'sp',
  direction: 'horizontal',
  children: [left, right],
  sizes: [50, 50],
}

describe('PaneTabMenu zoom', () => {
  let layoutInit: ReturnType<typeof useLayoutStore.getState>

  beforeAll(() => {
    layoutInit = useLayoutStore.getState()
  })

  afterEach(() => {
    cleanup()
    useLayoutStore.setState(layoutInit, true)
    vi.restoreAllMocks()
  })

  function seed(root: LayoutNode, zoomedPaneId: string | null): void {
    useLayoutStore.setState({
      byWorkspace: { w: { root, activePaneId: 'left', zoomedPaneId } },
    })
  }

  function openMenu(): void {
    render(<PaneTabMenu pane={left} workspaceId="w" trigger={<button type="button">tab</button>} />)
    fireEvent.contextMenu(screen.getByRole('button', { name: 'tab' }))
  }

  it('zooms the pane from its tab menu when the workspace is split', async () => {
    seed(split, null)
    const exec = vi.spyOn(commands, 'exec').mockResolvedValue({ ok: true, result: undefined })
    openMenu()
    await userEvent.setup().click(await screen.findByRole('menuitem', { name: /Zoom pane/ }))
    expect(exec).toHaveBeenCalledWith('pane.zoom', { paneId: 'left' })
  })

  it('offers to restore a zoomed pane', async () => {
    seed(split, 'left')
    openMenu()
    expect(await screen.findByRole('menuitem', { name: /Restore pane/ })).toBeInTheDocument()
  })

  it('leaves zoom out when the pane is alone in its workspace', async () => {
    seed(left, null)
    openMenu()
    expect(await screen.findByRole('menuitem', { name: 'Lock tab' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /Zoom pane/ })).toBeNull()
  })
})
