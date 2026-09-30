import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
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
  TerminalView: ({ paneId }: { paneId: string }) => <div data-testid={`terminal-${paneId}`} />,
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
    expect(window.pine.pty.attach).not.toHaveBeenCalled()
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
    expect(whenIdle).toHaveBeenCalledWith('h1', 'claude --resume tok-1')
    expect(within(host).getByTestId('terminal-h1')).toBeInTheDocument()
    host.remove()
  })

  it('marks the tab hibernated and offers Resume in the header without an idle prompt', () => {
    seed()
    render(<Pane tabs={[sleeping]} shownId="h1" active />)
    expect(screen.getByLabelText('Hibernated')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Resume claude' })).toBeInTheDocument()
  })

  it('offers no Resume for a live terminal that is busy', () => {
    const live: PaneNode = { ...sleeping, hibernated: undefined }
    act(() => {
      render(<Pane tabs={[live]} shownId="h1" active />)
    })
    expect(screen.queryByRole('button', { name: 'Resume claude' })).toBeNull()
    expect(screen.queryByLabelText('Hibernated')).toBeNull()
  })
})
