import '@testing-library/jest-dom/vitest'
import { emptyWorkspaceSandbox } from '@shared/sandbox'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { registerBuiltinCommands } from '../commands/builtins'
import { commands } from '../commands/registry'
import type { PaneNode } from '../layout/types'
import { type CommandBlock, useBlocksStore } from '../stores/blocksStore'
import { useLayoutStore } from '../stores/layoutStore'
import { type MergeSummary, useMergeConfirmStore } from '../stores/mergeConfirmStore'
import { useUIStore } from '../stores/uiStore'
import { useWindowsStore } from '../stores/windowsStore'
import { type Workspace, useWorkspacesStore } from '../stores/workspacesStore'
import { CommandPalette } from './CommandPalette'
import { DeckRail } from './DeckRail'
import { MergeConfirmDialog } from './MergeConfirmDialog'

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

const pane = (id: string, title = 'zsh'): PaneNode => ({
  type: 'pane',
  id,
  title,
  kind: 'terminal',
})

function workspace(id: string, workDir = '/home/u/proj'): Workspace {
  return { id, name: id, kind: 'terminal', workDir, state: 'idle' }
}

function seed(ids: string[]): void {
  useWindowsStore.setState({ windowId: 'win1', list: [] })
  useWorkspacesStore.setState({
    workspaces: [...ids.map((id) => workspace(id)), workspace('elsewhere', '/srv/app')],
    activeWorkspaceId: ids[0],
  })
  useLayoutStore.setState({
    byWorkspace: Object.fromEntries(
      ids.map((id) => [id, { root: pane(`${id}-p`), activePaneId: `${id}-p`, zoomedPaneId: null }]),
    ),
  })
}

const summary: MergeSummary = {
  source: 'api',
  target: 'web',
  terminals: 2,
  editors: 1,
  browsers: 1,
  others: 0,
  running: [{ paneId: 'p1', title: 'server', command: 'npm run dev' }],
  chat: true,
  sandbox: false,
}

describe('merging workspaces', () => {
  let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
  let layoutInit: ReturnType<typeof useLayoutStore.getState>
  let windowsInit: ReturnType<typeof useWindowsStore.getState>
  let uiInit: ReturnType<typeof useUIStore.getState>
  let blocksInit: ReturnType<typeof useBlocksStore.getState>
  let confirmInit: ReturnType<typeof useMergeConfirmStore.getState>

  beforeAll(() => {
    if (!commands.has('palette.toggle')) registerBuiltinCommands()
    workspacesInit = useWorkspacesStore.getState()
    layoutInit = useLayoutStore.getState()
    windowsInit = useWindowsStore.getState()
    uiInit = useUIStore.getState()
    blocksInit = useBlocksStore.getState()
    confirmInit = useMergeConfirmStore.getState()
  })

  afterEach(() => {
    cleanup()
    useWorkspacesStore.setState(workspacesInit, true)
    useLayoutStore.setState(layoutInit, true)
    useWindowsStore.setState(windowsInit, true)
    useUIStore.setState(uiInit, true)
    useBlocksStore.setState(blocksInit, true)
    useMergeConfirmStore.setState(confirmInit, true)
    vi.mocked(window.ostia.sandbox.get).mockResolvedValue(null)
    vi.clearAllMocks()
  })

  describe('row menu', () => {
    it('offers Merge into <name> for the one workspace in the same folder', async () => {
      seed(['api', 'web'])
      render(<DeckRail />)
      fireEvent.contextMenu(screen.getByRole('button', { name: /api/ }))

      const item = await screen.findByRole('menuitem', { name: 'Merge into web' })
      expect(screen.queryByRole('menuitem', { name: /elsewhere/ })).toBeNull()
      await userEvent.setup().click(item)

      await waitFor(() => expect(useMergeConfirmStore.getState().pending).not.toBeNull())
      expect(useMergeConfirmStore.getState().pending?.summary).toMatchObject({
        source: 'api',
        target: 'web',
      })
    })

    it('lists several targets in a submenu', async () => {
      seed(['api', 'web', 'docs'])
      render(<DeckRail />)
      fireEvent.contextMenu(screen.getByRole('button', { name: /api/ }))
      const user = userEvent.setup()

      await user.click(await screen.findByRole('menuitem', { name: 'Merge into' }))

      expect(await screen.findByRole('menuitem', { name: 'web' })).toBeInTheDocument()
      expect(screen.getByRole('menuitem', { name: 'docs' })).toBeInTheDocument()
    })

    it('shows a refused target disabled, with the reason', async () => {
      seed(['api', 'web'])
      vi.mocked(window.ostia.sandbox.get).mockImplementation(async (id) =>
        id === 'web' ? { ...emptyWorkspaceSandbox(), enabled: true } : null,
      )
      render(<DeckRail />)
      fireEvent.contextMenu(screen.getByRole('button', { name: /api/ }))

      const item = await screen.findByRole('menuitem', { name: /Merge into web/ })
      expect(item).toHaveAttribute('aria-disabled', 'true')
      expect(item).toHaveTextContent('Only one of them is sandboxed')
    })

    it('has no merge entry when no other workspace shares the folder', async () => {
      seed(['api'])
      render(<DeckRail />)
      fireEvent.contextMenu(screen.getByRole('button', { name: /api/ }))

      await screen.findByRole('menuitem', { name: 'Rename' })
      await new Promise((r) => setTimeout(r, 0))
      expect(screen.queryByRole('menuitem', { name: /Merge into/ })).toBeNull()
    })
  })

  describe('palette', () => {
    it('lists the targets of Merge Into… and asks before merging the picked one', async () => {
      seed(['api', 'web'])
      useUIStore.setState({ paletteOpen: true })
      render(<CommandPalette />)
      const user = userEvent.setup()

      await user.click(await screen.findByRole('option', { name: /Merge Into…/ }))
      await user.click(await screen.findByRole('option', { name: /web/ }))

      await waitFor(() => expect(useMergeConfirmStore.getState().pending).not.toBeNull())
      expect(useMergeConfirmStore.getState().pending?.summary.target).toBe('web')
    })

    it('says why there is nothing to pick', async () => {
      seed(['api'])
      useUIStore.setState({ paletteOpen: true })
      render(<CommandPalette />)
      const user = userEvent.setup()

      await user.click(await screen.findByRole('option', { name: /Merge Into…/ }))

      expect(
        await screen.findByText('No other workspace in this window has the same folder'),
      ).toBeInTheDocument()
    })

    it('is not offered to agents over the control socket', () => {
      expect(commands.describe().some((c) => c.id === 'workspace.mergeInto')).toBe(false)
    })
  })

  describe('confirm dialog', () => {
    it('names both workspaces, lists what moves and what keeps running', async () => {
      render(<MergeConfirmDialog />)
      act(() => {
        void useMergeConfirmStore.getState().ask(summary)
      })

      expect(
        await screen.findByRole('alertdialog', { name: 'Merge “api” into “web”?' }),
      ).toBeInTheDocument()
      expect(screen.getByText('Terminals: 2')).toBeInTheDocument()
      expect(screen.getByText('Editors: 1')).toBeInTheDocument()
      expect(screen.getByText('Browsers: 1')).toBeInTheDocument()
      expect(screen.queryByText(/Other panes/)).toBeNull()
      expect(screen.getByText('server: npm run dev keeps running')).toBeInTheDocument()
      expect(screen.getByText(/name, description, pin and group don’t carry over/)).toBeVisible()
      expect(screen.getByText('Its chat is replaced by the chat in “web”.')).toBeInTheDocument()
      expect(screen.queryByText(/allowed until restart/)).toBeNull()
    })

    it('focuses Merge and resolves true when it is pressed', async () => {
      render(<MergeConfirmDialog />)
      let answer: Promise<boolean> = Promise.resolve(false)
      act(() => {
        answer = useMergeConfirmStore.getState().ask(summary)
      })

      const merge = await screen.findByRole('button', { name: 'Merge' })
      await waitFor(() => expect(merge).toHaveFocus())
      await userEvent.setup().click(merge)

      expect(await answer).toBe(true)
    })

    it('resolves false on Cancel', async () => {
      render(<MergeConfirmDialog />)
      let answer: Promise<boolean> = Promise.resolve(false)
      act(() => {
        answer = useMergeConfirmStore.getState().ask(summary)
      })

      await userEvent.setup().click(await screen.findByRole('button', { name: 'Cancel' }))

      expect(await answer).toBe(false)
    })
  })

  it('shows the running command of a source pane in the confirm opened from the menu', async () => {
    seed(['api', 'web'])
    useBlocksStore.setState({
      running: { 'api-p': 'b1' },
      byPane: { 'api-p': [{ id: 'b1', paneId: 'api-p', command: 'tail -f log' } as CommandBlock] },
    })
    render(
      <>
        <DeckRail />
        <MergeConfirmDialog />
      </>,
    )
    fireEvent.contextMenu(screen.getByRole('button', { name: /api/ }))
    await userEvent.setup().click(await screen.findByRole('menuitem', { name: 'Merge into web' }))

    expect(await screen.findByText('zsh: tail -f log keeps running')).toBeInTheDocument()
  })
})
