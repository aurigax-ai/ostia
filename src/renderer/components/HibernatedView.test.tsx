import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { commands } from '../commands/registry'
import { findPane } from '../layout/tree'
import type { PaneNode } from '../layout/types'
import * as blockActions from '../lib/blockActions'
import { useLayoutStore } from '../stores/layoutStore'
import { surfaceHost } from '../stores/surfaceSlotsStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { Pane } from './Pane'
import { SurfacePool } from './SurfacePool'

vi.mock('./FileView', () => ({ FileView: () => null }))
vi.mock('./DiffView', () => ({ DiffView: () => null }))
vi.mock('./BrowserView', () => ({ BrowserView: () => null }))
vi.mock('./ExtensionPanelView', () => ({ ExtensionPanelView: () => null }))
vi.mock('./Terminal', () => ({
  TerminalView: ({ paneId, cwd }: { paneId: string; cwd?: string }) => (
    <div data-testid={`terminal-${paneId}`} data-cwd={cwd} />
  ),
}))

let layoutInit: ReturnType<typeof useLayoutStore.getState>
let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>

beforeAll(() => {
  layoutInit = useLayoutStore.getState()
  workspacesInit = useWorkspacesStore.getState()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  useLayoutStore.setState(layoutInit, true)
  useWorkspacesStore.setState(workspacesInit, true)
})

const sleeping: PaneNode = {
  type: 'pane',
  id: 'h1',
  kind: 'terminal',
  title: 'claude',
  resume: { agent: 'claude', id: 'tok-1' },
  hibernated: true,
}

function seed(): void {
  useWorkspacesStore.setState({
    workspaces: [{ id: 's1', name: 'a', kind: 'terminal', workDir: '/a', state: 'idle' }],
    activeWorkspaceId: 's1',
  })
  useLayoutStore.setState({
    byWorkspace: { s1: { root: sleeping, activePaneId: 'h1', zoomedPaneId: null } },
  })
}

describe('hibernated terminal pane', () => {
  it('shows the hibernated state instead of a terminal, and spawns no shell', () => {
    seed()
    render(<SurfacePool />)
    const host = surfaceHost('h1')
    document.body.appendChild(host)
    expect(within(host).getByText('Hibernated')).toBeInTheDocument()
    expect(within(host).getByText(/claude --resume tok-1/)).toBeInTheDocument()
    expect(within(host).queryByTestId('terminal-h1')).toBeNull()
    expect(window.ostia.pty.attach).not.toHaveBeenCalled()
    host.remove()
  })

  it('wakes into a fresh terminal and resumes the agent at its first idle prompt', async () => {
    seed()
    const whenIdle = vi.spyOn(blockActions, 'runWhenIdle').mockReturnValue(() => {})
    render(<SurfacePool />)
    const host = surfaceHost('h1')
    document.body.appendChild(host)
    await userEvent.click(within(host).getByRole('button', { name: 'Resume claude' }))
    const layout = useLayoutStore.getState().byWorkspace.s1
    expect(layout && findPane(layout.root, 'h1')?.hibernated).toBeUndefined()
    expect(whenIdle).toHaveBeenCalledWith(
      'h1',
      'claude --resume tok-1',
      undefined,
      expect.any(Function),
    )
    expect(within(host).getByTestId('terminal-h1')).toBeInTheDocument()
    host.remove()
  })

  it('starts the woken shell in the folder the agent session belongs to, not the pane folder', async () => {
    seed()
    useLayoutStore.setState({
      byWorkspace: {
        s1: {
          root: {
            ...sleeping,
            cwd: '/a',
            resume: { agent: 'claude', id: 'tok-1', cwd: '/a/tree' },
          },
          activePaneId: 'h1',
          zoomedPaneId: null,
        },
      },
    })
    vi.spyOn(blockActions, 'runWhenIdle').mockReturnValue(() => {})
    render(<SurfacePool />)
    const host = surfaceHost('h1')
    document.body.appendChild(host)
    await userEvent.click(within(host).getByRole('button', { name: 'Resume claude' }))
    expect(within(host).getByTestId('terminal-h1')).toHaveAttribute('data-cwd', '/a/tree')
    host.remove()
  })

  it('says the agent folder is gone and offers Close tab instead of Resume', async () => {
    seed()
    const gone: PaneNode = {
      type: 'pane',
      id: 'h1',
      kind: 'terminal',
      title: 'claude',
      resume: { agent: 'claude', id: 'tok-1', cwd: '/a/tree' },
      resumeFolderMissing: '/a/tree',
    }
    useLayoutStore.setState({
      byWorkspace: { s1: { root: gone, activePaneId: 'h1', zoomedPaneId: null } },
    })
    render(<Pane tabs={[gone]} shownId="h1" activePaneId="h1" workspaceId="s1" />)
    const notice = screen.getByRole('region', { name: 'Agent folder missing' })
    expect(within(notice).getByText(/\/a\/tree/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Resume claude' })).toBeNull()
    const exec = vi.spyOn(commands, 'exec').mockResolvedValue({ ok: true, result: undefined })
    await userEvent.click(within(notice).getByRole('button', { name: 'Close tab' }))
    expect(exec).toHaveBeenCalledWith('pane.close', { paneId: 'h1' })
  })

  it('marks the tab hibernated', () => {
    seed()
    render(<Pane tabs={[sleeping]} shownId="h1" activePaneId={'h1'} workspaceId="w" />)
    expect(screen.getByLabelText('Hibernated')).toBeInTheDocument()
  })
})
