import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { LayoutNode } from '../layout/types'
import { confirmQuit, requestClosePane, requestCloseWorkspace } from '../lib/closeConfirm'
import { type CommandBlock, useBlocksStore } from '../stores/blocksStore'
import { useCloseConfirmStore } from '../stores/closeConfirmStore'
import { useEditorStatus } from '../stores/editorStatusStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
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
      quit = confirmQuit()
    })
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('sleep 100')
    expect(dialog).toHaveTextContent('tail -f log')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    await expect(quit).resolves.toBe(false)
  })

  it('confirms quit immediately when the setting is off or nothing runs', async () => {
    seed('sleep 100')
    useSettingsStore.getState().setWorkspaces({ confirmQuit: false })
    await expect(confirmQuit()).resolves.toBe(true)

    useSettingsStore.getState().setWorkspaces({ confirmQuit: true })
    useBlocksStore.setState({ running: {} })
    await expect(confirmQuit()).resolves.toBe(true)
  })
})
