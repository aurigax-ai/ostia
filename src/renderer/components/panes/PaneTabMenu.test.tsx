import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { registerBuiltinCommands } from '@/commands/builtins'
import { commands } from '@/commands/registry'
import { ActionConfirmDialog } from '@/components/settings/ActionConfirmDialog'
import { paneIds, tabsOf } from '@/lib/layout/tree'
import type { LayoutNode, PaneNode, SplitNode } from '@/lib/layout/types'
import * as blockActions from '@/lib/terminal/blockActions'
import { useActionConfirmStore } from '@/stores/agents/actionConfirmStore'
import { useAttentionStore } from '@/stores/agents/attentionStore'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useBlocksStore } from '@/stores/terminal/blocksStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { usePaneRenameStore } from '@/stores/workspaces/paneRenameStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
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

  it('offers Rename Split Tab only for a pane inside a split tab, and starts naming it', async () => {
    const other: PaneNode = { type: 'pane', id: 'other', kind: 'terminal', title: 'bash' }
    seed(tabsOf('left', split as SplitNode, other), null)
    openMenu()
    await userEvent
      .setup()
      .click(await screen.findByRole('menuitem', { name: 'Rename Split Tab…' }))
    expect(usePaneRenameStore.getState().splitTabId).toBe('sp')
    usePaneRenameStore.getState().end()
    cleanup()
    seed(split, null)
    openMenu()
    expect(await screen.findByRole('menuitem', { name: 'Lock tab' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Rename Split Tab…' })).toBeNull()
  })

  it('an agent closes a busy tab without a confirm, but never a tab the human locked', async () => {
    seed(split, null)
    const exec = vi.spyOn(commands, 'exec').mockResolvedValue({ ok: true, result: undefined })
    openMenu()
    await userEvent.setup().click(await screen.findByRole('menuitem', { name: 'Lock tab' }))
    expect(exec).toHaveBeenCalledWith('pane.toggleLock', { paneId: 'left' })
  })
})

describe('PaneTabMenu close others and hibernation', () => {
  let layoutInit: ReturnType<typeof useLayoutStore.getState>
  let blocksInit: ReturnType<typeof useBlocksStore.getState>

  beforeAll(() => {
    layoutInit = useLayoutStore.getState()
    blocksInit = useBlocksStore.getState()
  })

  afterEach(() => {
    cleanup()
    useLayoutStore.setState(layoutInit, true)
    useBlocksStore.setState(blocksInit, true)
    vi.restoreAllMocks()
  })

  const shell: PaneNode = { type: 'pane', id: 'a', kind: 'terminal', title: 'zsh' }
  const agentTab: PaneNode = {
    type: 'pane',
    id: 'b',
    kind: 'terminal',
    title: 'claude',
    resume: { agent: 'claude', id: 'tok' },
  }

  function openMenu(pane: PaneNode, children: PaneNode[]): void {
    useLayoutStore.setState({
      byWorkspace: {
        w: { root: tabsOf(pane.id, ...children), activePaneId: pane.id, zoomedPaneId: null },
      },
    })
    render(<PaneTabMenu pane={pane} workspaceId="w" trigger={<button type="button">tab</button>} />)
    fireEvent.contextMenu(screen.getByRole('button', { name: 'tab' }))
  }

  it('starts a new session from the tab menu of an agent pane only', async () => {
    const exec = vi.spyOn(commands, 'exec').mockResolvedValue({ ok: true, result: undefined })
    const agentPane: PaneNode = { type: 'pane', id: 'ag', kind: 'agent', title: 'Agent' }
    openMenu(agentPane, [shell])
    await userEvent.setup().click(await screen.findByRole('menuitem', { name: 'New session' }))
    expect(exec).toHaveBeenCalledWith('agent.newSession', { paneId: 'ag' })
    cleanup()
    openMenu(shell, [agentPane])
    await screen.findByRole('menuitem', { name: /Rename/ })
    expect(screen.queryByRole('menuitem', { name: 'New session' })).toBeNull()
  })

  it('closes the other tabs of the group from the tab menu', async () => {
    const exec = vi.spyOn(commands, 'exec').mockResolvedValue({ ok: true, result: undefined })
    openMenu(shell, [shell, agentTab])
    await userEvent.setup().click(await screen.findByRole('menuitem', { name: 'Close other tabs' }))
    expect(exec).toHaveBeenCalledWith('tab.closeOthers', { paneId: 'a' })
  })

  it('leaves Close other tabs out when the tab is alone', async () => {
    openMenu(shell, [shell])
    expect(await screen.findByRole('menuitem', { name: 'Lock tab' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Close other tabs' })).toBeNull()
  })

  it('hibernates an agent tab, and offers no hibernation for a plain shell', async () => {
    const exec = vi.spyOn(commands, 'exec').mockResolvedValue({ ok: true, result: undefined })
    useBlocksStore.getState().promptStart('b', { line: 0 }, null)
    useBlocksStore.getState().commandStart('b', { line: 1 }, 'claude')
    useBlocksStore.getState().markAgent('b', 'claude')
    openMenu(agentTab, [shell, agentTab])
    await userEvent.setup().click(await screen.findByRole('menuitem', { name: 'Hibernate tab' }))
    expect(exec).toHaveBeenCalledWith('pane.hibernate', { paneId: 'b' })
    cleanup()
    openMenu(shell, [shell, agentTab])
    expect(await screen.findByRole('menuitem', { name: 'Lock tab' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /Hibernate tab|Wake tab/ })).toBeNull()
  })

  it('parks an idle running agent at once from the tab menu, and shows the reason when it cannot', async () => {
    useWorkspacesStore.setState({
      workspaces: [{ id: 'w', name: 'w', kind: 'terminal', workDir: '/w', state: 'idle' }],
    })
    vi.mocked(window.ostia.park.pane).mockResolvedValue({
      ok: true,
      id: 'abcdefghij',
      title: 'claude',
    })
    useBlocksStore.getState().promptStart('b', { line: 0 }, null)
    useBlocksStore.getState().commandStart('b', { line: 1 }, 'claude')
    useBlocksStore.getState().markAgent('b', 'claude')
    openMenu(agentTab, [shell, agentTab])
    const item = await screen.findByRole('menuitem', { name: 'Park' })
    expect(item).not.toHaveAttribute('aria-disabled', 'true')
    await userEvent.setup().click(item)
    expect(window.ostia.park.pane).toHaveBeenCalledWith('w', 'b', false)
    cleanup()
    useAttentionStore.getState().dispatch('b', { type: 'set', state: 'working', at: 1 })
    openMenu(agentTab, [shell, agentTab])
    const busy = await screen.findByRole('menuitem', { name: /^Park/ })
    expect(busy).toHaveAttribute('aria-disabled', 'true')
    expect(busy).toHaveTextContent('the agent is working')
    cleanup()
    openMenu(shell, [shell, agentTab])
    expect(await screen.findByRole('menuitem', { name: 'Lock tab' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /^Park/ })).toBeNull()
    useAttentionStore.setState({ byPane: {} })
    useWorkspacesStore.setState({ workspaces: [] })
  })

  it('wakes a hibernated agent tab instead', async () => {
    const exec = vi.spyOn(commands, 'exec').mockResolvedValue({ ok: true, result: undefined })
    const asleep: PaneNode = { ...agentTab, hibernated: true }
    openMenu(asleep, [shell, asleep])
    expect(screen.queryByRole('menuitem', { name: 'Hibernate tab' })).toBeNull()
    await userEvent.setup().click(await screen.findByRole('menuitem', { name: 'Wake tab' }))
    expect(exec).toHaveBeenCalledWith('pane.wake', { paneId: 'b' })
  })

  it('forks a hibernated agent tab into a new tab, and offers no fork for a plain shell', async () => {
    const run = vi.spyOn(blockActions, 'runWhenIdle').mockReturnValue(() => {})
    const asleep: PaneNode = { ...agentTab, hibernated: true }
    openMenu(asleep, [shell, asleep])
    await userEvent
      .setup()
      .click(await screen.findByRole('menuitem', { name: 'Fork conversation into a new tab' }))
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0][0]).not.toBe('b')
    expect(run.mock.calls[0][1]).toContain('--fork-session')
    cleanup()
    openMenu(shell, [shell, asleep])
    expect(await screen.findByRole('menuitem', { name: 'Lock tab' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Fork conversation into a new tab' })).toBeNull()
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
