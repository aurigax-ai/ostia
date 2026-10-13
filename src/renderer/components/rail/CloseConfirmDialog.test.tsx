import '@testing-library/jest-dom/vitest'
import type { LayoutNode } from '@/layout/types'
import {
  confirmQuit,
  quitGroups,
  requestClosePane,
  requestCloseWorkspace,
} from '@/lib/workspaces/closeConfirm'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useEditorStatus } from '@/stores/files/editorStatusStore'
import { type CommandBlock, useBlocksStore } from '@/stores/terminal/blocksStore'
import { useCloseConfirmStore } from '@/stores/workspaces/closeConfirmStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { CloseConfirmDialog } from './CloseConfirmDialog'

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

const pane = (id: string): LayoutNode => ({ type: 'pane', id, title: 'Terminal', kind: 'terminal' })

function seed(runningCommand: string | null): void {
  useWorkspacesStore.setState({
    workspaces: [
      { id: 'w1', name: 'alpha', kind: 'terminal', workDir: '/a', state: 'idle' },
      { id: 'w2', name: 'beta', kind: 'terminal', workDir: '/b', state: 'idle' },
    ],
    activeWorkspaceId: 'w1',
  })
  useLayoutStore.setState({
    byWorkspace: {
      w1: { root: pane('p1'), activePaneId: 'p1', zoomedPaneId: null },
      w2: { root: pane('p2'), activePaneId: 'p2', zoomedPaneId: null },
    },
  })
  if (runningCommand !== null) {
    useBlocksStore.setState({
      running: { p1: 'b1' },
      byPane: { p1: [{ id: 'b1', paneId: 'p1', command: runningCommand } as CommandBlock] },
    })
  }
}

const workspaceIds = () => useWorkspacesStore.getState().workspaces.map((w) => w.id)

describe('close confirmation', () => {
  let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
  let layoutInit: ReturnType<typeof useLayoutStore.getState>
  let blocksInit: ReturnType<typeof useBlocksStore.getState>
  let settingsInit: ReturnType<typeof useSettingsStore.getState>

  beforeAll(() => {
    workspacesInit = useWorkspacesStore.getState()
    layoutInit = useLayoutStore.getState()
    blocksInit = useBlocksStore.getState()
    settingsInit = useSettingsStore.getState()
  })

  afterEach(() => {
    cleanup()
    useWorkspacesStore.setState(workspacesInit, true)
    useLayoutStore.setState(layoutInit, true)
    useBlocksStore.setState(blocksInit, true)
    useSettingsStore.setState(settingsInit, true)
    useCloseConfirmStore.setState({ pending: null })
  })

  it('closes a workspace without asking when nothing is running', async () => {
    seed(null)
    render(<CloseConfirmDialog />)

    await requestCloseWorkspace('w1')

    expect(workspaceIds()).toEqual(['w2'])
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('names the running command and keeps the workspace on Cancel', async () => {
    seed('sleep 100')
    render(<CloseConfirmDialog />)
    const user = userEvent.setup()

    const closing = requestCloseWorkspace('w1')
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('sleep 100')
    expect(dialog).toHaveTextContent('alpha')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await closing

    expect(workspaceIds()).toEqual(['w1', 'w2'])
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('asks again after a cancelled quit and quits on Quit', async () => {
    seed('sleep 100')
    render(<CloseConfirmDialog />)
    const user = userEvent.setup()

    let quit: Promise<boolean> = Promise.resolve(true)
    act(() => {
      quit = confirmQuit(quitGroups())
    })
    await screen.findByRole('dialog')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await expect(quit).resolves.toBe(false)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    act(() => {
      quit = confirmQuit(quitGroups())
    })
    await screen.findByRole('dialog')
    await user.click(screen.getByRole('button', { name: 'Quit' }))
    await expect(quit).resolves.toBe(true)
  })

  it('closes the workspace when the dialog is confirmed', async () => {
    seed('sleep 100')
    render(<CloseConfirmDialog />)
    const user = userEvent.setup()

    const closing = requestCloseWorkspace('w1')
    await screen.findByRole('dialog')
    await user.click(screen.getByRole('button', { name: 'Close workspace' }))
    await closing

    expect(workspaceIds()).toEqual(['w2'])
  })

  it('does not ask when confirmClose is off', async () => {
    seed('sleep 100')
    useSettingsStore.getState().setWorkspaces({ confirmClose: false })
    render(<CloseConfirmDialog />)

    await requestCloseWorkspace('w1')

    expect(workspaceIds()).toEqual(['w2'])
  })

  it('asks before closing the last pane of a workspace that has a running command', async () => {
    seed('npm run dev')
    render(<CloseConfirmDialog />)
    const user = userEvent.setup()

    const closing = requestClosePane('w1', 'p1')
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('npm run dev')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await closing
    expect(useLayoutStore.getState().byWorkspace.w1).toBeDefined()

    const again = requestClosePane('w1', 'p1')
    await screen.findByRole('dialog')
    await user.click(screen.getByRole('button', { name: 'Close pane' }))
    await again
    expect(useLayoutStore.getState().byWorkspace.w1).toBeUndefined()
  })

  it('asks before closing a tab that has a running command, and not for an idle tab beside it', async () => {
    seed('pnpm dev')
    useLayoutStore.setState({
      byWorkspace: {
        w1: {
          root: {
            type: 'tabs',
            id: 't1',
            activeId: 'p1',
            children: [pane('p1'), pane('p3')],
          } as LayoutNode,
          activePaneId: 'p1',
          zoomedPaneId: null,
        },
      },
    })
    render(<CloseConfirmDialog />)
    const user = userEvent.setup()

    await requestClosePane('w1', 'p3')
    expect(screen.queryByRole('dialog')).toBeNull()

    const closing = requestClosePane('w1', 'p1')
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('pnpm dev')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await closing
    expect(useLayoutStore.getState().byWorkspace.w1).toBeDefined()
  })

  it('asks before closing an editor tab with unsaved changes', async () => {
    seed(null)
    const editor = {
      type: 'pane',
      id: 'p9',
      title: 'main.rs',
      kind: 'editor',
      filePath: '/a/src/main.rs',
    } as LayoutNode
    useLayoutStore.setState({
      byWorkspace: { w1: { root: editor, activePaneId: 'p9', zoomedPaneId: null } },
    })
    useEditorStatus.getState().setDirty('/a/src/main.rs', true)
    render(<CloseConfirmDialog />)
    const user = userEvent.setup()

    const closing = requestClosePane('w1', 'p9')
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('main.rs has unsaved changes')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await closing
    expect(useLayoutStore.getState().byWorkspace.w1).toBeDefined()
    useEditorStatus.getState().setDirty('/a/src/main.rs', false)
  })

  it('resolves the quit question from the dialog and lists every workspace with commands', async () => {
    seed('sleep 100')
    useBlocksStore.setState((s) => ({
      running: { ...s.running, p2: 'b2' },
      byPane: {
        ...s.byPane,
        p2: [{ id: 'b2', paneId: 'p2', command: 'tail -f log' } as CommandBlock],
      },
    }))
    render(<CloseConfirmDialog />)
    const user = userEvent.setup()

    let quit: Promise<boolean> = Promise.resolve(true)
    act(() => {
      quit = confirmQuit(quitGroups())
    })
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('sleep 100')
    expect(dialog).toHaveTextContent('tail -f log')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    await expect(quit).resolves.toBe(false)
  })

  it('says what the quit loses, counted, above the workspaces', async () => {
    seed('sleep 100')
    useBlocksStore.setState((s) => ({
      running: { ...s.running, p2: 'b2' },
      byPane: { ...s.byPane, p2: [{ id: 'b2', paneId: 'p2', command: 'claude' } as CommandBlock] },
    }))
    const groups = quitGroups()
    expect(groups.map((g) => [g.commands, g.agents])).toEqual([
      [['sleep 100'], undefined],
      [[], ['claude']],
    ])
    render(<CloseConfirmDialog />)
    act(() => {
      void confirmQuit([
        ...groups,
        { workspaceId: 'w3', workspace: 'gamma', commands: ['make'], files: ['/c/a', '/c/b'] },
      ])
    })
    const losses = await screen.findByRole('list', {
      name: 'Quitting ends or discards everything listed here.',
    })
    expect(screen.getByRole('dialog')).toHaveTextContent('Quit and lose this work?')
    expect([...losses.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      '2 shell processes will be ended',
      '1 agent will be stopped',
      '2 files have unsaved changes',
    ])
    act(() => useCloseConfirmStore.getState().answer(false))
  })

  it('counts the files a quit deletes from scratch folders', async () => {
    render(<CloseConfirmDialog />)
    act(() => {
      void confirmQuit([
        { workspaceId: 'w1', workspace: 'S', commands: ['make'], files: [], scratchFiles: 1 },
      ])
    })
    const losses = await screen.findByRole('list', {
      name: 'Quitting ends or discards everything listed here.',
    })
    expect([...losses.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      '1 shell process will be ended',
      '1 file in a scratch folder will be deleted',
    ])
    act(() => useCloseConfirmStore.getState().answer(false))
  })

  it('confirms quit immediately when the setting is off or nothing runs', async () => {
    seed('sleep 100')
    useSettingsStore.getState().setWorkspaces({ confirmQuit: false })
    await expect(confirmQuit(quitGroups())).resolves.toBe(true)

    useSettingsStore.getState().setWorkspaces({ confirmQuit: true })
    useBlocksStore.setState({ running: {} })
    await expect(confirmQuit(quitGroups())).resolves.toBe(true)
  })

  it('KSH-C39 leaves a kept shell out of the restart question', async () => {
    seed('sleep 100')
    expect(quitGroups(new Set(['p1']))).toEqual([])
    await expect(confirmQuit(quitGroups(new Set(['p1'])))).resolves.toBe(true)
  })

  it('KSH-C40 still asks about a running command whose shell is not kept', () => {
    seed('sleep 100')
    expect(quitGroups(new Set()).map((g) => g.commands)).toEqual([['sleep 100']])
    expect(quitGroups(new Set(['p2'])).map((g) => g.commands)).toEqual([['sleep 100']])
  })

  describe('scratch workspaces', () => {
    function seedScratch(files: number): void {
      seed(null)
      useWorkspacesStore.setState((st) => ({
        workspaces: [
          ...st.workspaces,
          {
            id: 'w3',
            name: '1-aaaaaaaaaaaa',
            customName: 'Scratch',
            kind: 'scratch',
            workDir: '/tmp/ostia-scratch-1000/1-aaaaaaaaaaaa',
            state: 'idle',
          },
        ],
      }))
      vi.mocked(window.ostia.scratch.files).mockResolvedValue(files)
    }

    afterEach(() => {
      vi.mocked(window.ostia.scratch.files).mockResolvedValue(0)
      vi.mocked(window.ostia.scratch.reveal).mockClear()
    })

    it('closes an empty scratch workspace without asking', async () => {
      seedScratch(0)
      render(<CloseConfirmDialog />)

      await requestCloseWorkspace('w3')

      expect(workspaceIds()).toEqual(['w1', 'w2'])
      expect(window.ostia.scratch.files).toHaveBeenCalledWith('w3')
    })

    it('asks before deleting the files in its folder, offers Reveal, and deletes on confirm', async () => {
      seedScratch(2)
      useSettingsStore.getState().setWorkspaces({ confirmClose: false })
      render(<CloseConfirmDialog />)
      const user = userEvent.setup()

      const cancelled = requestCloseWorkspace('w3')
      const dialog = await screen.findByRole('dialog')
      expect(dialog).toHaveTextContent('Delete 2 files in the scratch folder?')
      expect(dialog).toHaveTextContent('Scratch')
      await user.click(screen.getByRole('button', { name: 'Reveal' }))
      expect(window.ostia.scratch.reveal).toHaveBeenCalledWith('w3')
      await user.click(screen.getByRole('button', { name: 'Cancel' }))
      await cancelled
      expect(workspaceIds()).toEqual(['w1', 'w2', 'w3'])

      const closing = requestCloseWorkspace('w3')
      await screen.findByRole('dialog')
      await user.click(screen.getByRole('button', { name: 'Delete' }))
      await closing
      expect(workspaceIds()).toEqual(['w1', 'w2'])
    })

    it('reports every scratch workspace to main at quit so main can count its files', () => {
      seedScratch(2)
      useSettingsStore.getState().setWorkspaces({ confirmQuit: false })
      expect(quitGroups()).toEqual([
        { workspaceId: 'w3', workspace: 'Scratch', commands: [], files: [] },
      ])
    })
  })
})
