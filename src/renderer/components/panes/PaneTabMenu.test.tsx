import '@testing-library/jest-dom/vitest'
import { registerBuiltinCommands } from '@/commands/builtins'
import { commands } from '@/commands/registry'
import { ActionConfirmDialog } from '@/components/settings/ActionConfirmDialog'
import { paneIds } from '@/layout/tree'
import type { LayoutNode, PaneNode } from '@/layout/types'
import * as blockActions from '@/lib/terminal/blockActions'
import { useActionConfirmStore } from '@/stores/agents/actionConfirmStore'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { PaneHeaderActions, PaneTabMenu } from './PaneTabMenu'

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

describe('user actions in the pane header and tab menu', () => {
  let layoutInit: ReturnType<typeof useLayoutStore.getState>
  let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
  let settingsInit: ReturnType<typeof useSettingsStore.getState>

  beforeAll(() => {
    registerBuiltinCommands()
    layoutInit = useLayoutStore.getState()
    workspacesInit = useWorkspacesStore.getState()
    settingsInit = useSettingsStore.getState()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    useLayoutStore.setState(layoutInit, true)
    useWorkspacesStore.setState(workspacesInit, true)
    useSettingsStore.setState(settingsInit, true)
    useActionConfirmStore.setState({ pending: null })
  })

  it('actions from settings.json show in the pane header and tab menu, and elevated ones ask first', async () => {
    const user = userEvent.setup()
    const pane: PaneNode = { ...left, resume: { agent: 'claude', id: 'abc' } }
    useWorkspacesStore.setState({ activeWorkspaceId: 'w' })
    useLayoutStore.setState({
      byWorkspace: { w: { root: pane, activePaneId: pane.id, zoomedPaneId: null } },
    })
    vi.mocked(window.ostia.fs.read).mockResolvedValueOnce({
      ok: true,
      version: 'v1',
      text: JSON.stringify({
        actions: [
          {
            id: 'split-down',
            title: 'Split below',
            command: 'pane.split',
            args: { direction: 'vertical' },
            icon: 'terminal',
            in: ['paneHeader'],
            paneKinds: ['terminal'],
          },
          { id: 'resume', title: 'Resume here', command: 'agent.resume', in: ['tabMenu'] },
        ],
      }),
    })
    await useSettingsStore.getState().init()
    const insert = vi.spyOn(blockActions, 'insertCommand').mockReturnValue(true)
    render(
      <>
        <PaneHeaderActions pane={pane} />
        <PaneTabMenu pane={pane} workspaceId="w" trigger={<button type="button">tab</button>} />
        <ActionConfirmDialog />
      </>,
    )

    await user.click(screen.getByRole('button', { name: 'Split below' }))
    await waitFor(() =>
      expect(paneIds(useLayoutStore.getState().byWorkspace.w.root)).toHaveLength(2),
    )

    fireEvent.contextMenu(screen.getByRole('button', { name: 'tab' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Resume here' }))
    const dialog = await screen.findByRole('dialog', { name: 'Run “Resume here”?' })
    expect(dialog).toHaveTextContent('agent.resume')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(insert).not.toHaveBeenCalled()
  })
})
