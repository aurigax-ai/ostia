import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { commands } from '@/commands/registry'
import { claimResume, clearResumeClaims, RESUME_CLAIM_MS } from '@/lib/agents/resumeFolder'
import { findPane } from '@/lib/layout/tree'
import type { PaneNode } from '@/lib/layout/types'
import * as blockActions from '@/lib/terminal/blockActions'
import { useBlocksStore } from '@/stores/terminal/blocksStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { surfaceHost } from '@/stores/workspaces/surfaceSlotsStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'

vi.mock('@/components/editor/FileView', () => ({ FileView: () => null }))
vi.mock('@/components/editor/DiffView', () => ({ DiffView: () => null }))
vi.mock('@/components/browser/BrowserView', () => ({ BrowserView: () => null }))
vi.mock('./Terminal', () => ({
  TerminalView: ({ paneId, cwd }: { paneId: string; cwd?: string }) => (
    <div data-testid={`terminal-${paneId}`} data-cwd={cwd} />
  ),
}))

const { Pane } = await import('@/components/panes/Pane')
const { HibernatedView } = await import('./HibernatedView')
const { focusSurfaceWhenReady } = await import('@/stores/workspaces/surfaceSlotsStore')
const { SurfacePool } = await import('@/components/panes/SurfacePool')

let layoutInit: ReturnType<typeof useLayoutStore.getState>
let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
let blocksInit: ReturnType<typeof useBlocksStore.getState>

beforeAll(() => {
  layoutInit = useLayoutStore.getState()
  workspacesInit = useWorkspacesStore.getState()
  blocksInit = useBlocksStore.getState()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  useLayoutStore.setState(layoutInit, true)
  useWorkspacesStore.setState(workspacesInit, true)
  useBlocksStore.setState(blocksInit, true)
  clearResumeClaims()
  vi.useRealTimers()
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
  it('shows a solid state with the agent and Wake, mounts no terminal and spawns no shell', () => {
    seed()
    render(<SurfacePool />)
    const host = surfaceHost('h1')
    document.body.appendChild(host)
    expect(within(host).getByText('claude')).toBeInTheDocument()
    expect(within(host).getByText('Hibernated')).toBeInTheDocument()
    expect(within(host).getByRole('button', { name: 'Resume claude' })).toBeInTheDocument()
    expect(within(host).queryByTestId('terminal-h1')).toBeNull()
    expect(host.querySelector('.xterm, .hibernated-screen')).toBeNull()
    expect(window.ostia.pty.stashed).not.toHaveBeenCalled()
    expect(window.ostia.pty.attach).not.toHaveBeenCalled()
    expect(window.ostia.pty.write).not.toHaveBeenCalled()
    host.remove()
  })

  it('points the pane focus at the Wake button, and at nothing without an agent to wake', async () => {
    const { rerender } = render(<HibernatedView paneId="h1" resume={sleeping.resume} />)
    focusSurfaceWhenReady('h1', () => true)
    await vi.waitFor(() =>
      expect(screen.getByRole('button', { name: 'Resume claude' })).toHaveFocus(),
    )
    rerender(<HibernatedView paneId="h1" />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('wakes into a fresh terminal in place of the frozen screen and resumes the agent at its first idle prompt', async () => {
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
      "'claude' --resume tok-1",
      undefined,
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    )
    expect(window.ostia.pty.reportWaking).toHaveBeenCalledWith('h1', true)
    expect(within(host).getByTestId('terminal-h1')).toBeInTheDocument()
    expect(within(host).queryByText('Hibernated')).toBeNull()
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

  it('says the session runs in another tab, offers Close tab, and its Resume types nothing', async () => {
    const live: PaneNode = {
      type: 'pane',
      id: 'live',
      kind: 'terminal',
      title: 'Ostia coordinator',
      resume: { agent: 'claude', id: 'tok-1' },
    }
    useWorkspacesStore.setState({
      workspaces: [{ id: 's1', name: 'a', kind: 'terminal', workDir: '/a', state: 'idle' }],
      activeWorkspaceId: 's1',
    })
    useLayoutStore.setState({
      byWorkspace: {
        s1: {
          root: { type: 'tabs', id: 't', activeId: 'h1', children: [live, sleeping] },
          activePaneId: 'h1',
          zoomedPaneId: null,
        },
      },
    })
    const blocks = useBlocksStore.getState()
    blocks.promptStart('live', { line: 0 }, null)
    blocks.commandStart('live', { line: 1 }, "'claude' --resume tok-1")
    blocks.markAgent('live', 'claude')
    const typed = vi.spyOn(blockActions, 'runWhenIdle')
    render(<Pane tabs={[live, sleeping]} shownId="h1" activePaneId="h1" workspaceId="s1" />)
    render(<SurfacePool />)
    const host = surfaceHost('h1')
    document.body.appendChild(host)

    const notice = screen.getByRole('region', { name: 'Agent session open twice' })
    expect(within(notice).getByText(/“Ostia coordinator”/)).toBeInTheDocument()
    await userEvent.click(within(host).getByRole('button', { name: 'Resume claude' }))
    expect(typed).not.toHaveBeenCalled()
    expect(findPane(useLayoutStore.getState().byWorkspace.s1.root, 'h1')?.hibernated).toBe(true)
    const exec = vi.spyOn(commands, 'exec').mockResolvedValue({ ok: true, result: undefined })
    await userEvent.click(within(notice).getByRole('button', { name: 'Close tab' }))
    expect(exec).toHaveBeenCalledWith('pane.close', { paneId: 'h1' })
    host.remove()
  })

  it('says both tabs run the session when the agent runs here too', () => {
    const resume = { agent: 'claude' as const, id: 'tok-2' }
    const here: PaneNode = { type: 'pane', id: 'here', kind: 'terminal', title: 'here', resume }
    const there: PaneNode = { type: 'pane', id: 'there', kind: 'terminal', title: 'there', resume }
    useLayoutStore.setState({
      byWorkspace: {
        s1: {
          root: { type: 'tabs', id: 't', activeId: 'here', children: [here, there] },
          activePaneId: 'here',
          zoomedPaneId: null,
        },
      },
    })
    const blocks = useBlocksStore.getState()
    for (const id of ['here', 'there']) {
      blocks.promptStart(id, { line: 0 }, null)
      blocks.commandStart(id, { line: 1 }, "'claude' --resume tok-2")
      blocks.markAgent(id, 'claude')
    }
    render(<Pane tabs={[here, there]} shownId="here" activePaneId="here" workspaceId="s1" />)
    const notice = screen.getByRole('region', { name: 'Agent session open twice' })
    expect(within(notice).getByText(/running here and in the tab “there”/)).toBeInTheDocument()
    expect(within(notice).queryByText(/not resumed here/)).toBeNull()
  })

  it('drops the warning when another tab’s typed resume never started', () => {
    vi.useFakeTimers()
    const resume = { agent: 'claude' as const, id: 'tok-3' }
    const waiting: PaneNode = {
      type: 'pane',
      id: 'waiting',
      kind: 'terminal',
      title: 'waiting',
      resume,
      resumePending: true,
    }
    const typed: PaneNode = { type: 'pane', id: 'typed', kind: 'terminal', title: 'typed', resume }
    useLayoutStore.setState({
      byWorkspace: {
        s1: {
          root: { type: 'tabs', id: 't', activeId: 'waiting', children: [waiting, typed] },
          activePaneId: 'waiting',
          zoomedPaneId: null,
        },
      },
    })
    claimResume('typed', resume)
    render(
      <Pane tabs={[waiting, typed]} shownId="waiting" activePaneId="waiting" workspaceId="s1" />,
    )
    expect(screen.getByRole('region', { name: 'Agent session open twice' })).toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(RESUME_CLAIM_MS + 5)
    })
    expect(screen.queryByRole('region', { name: 'Agent session open twice' })).toBeNull()
    vi.useRealTimers()
  })

  it('a hibernated pane types nothing into its pane and wakes into one fresh terminal', async () => {
    seed()
    vi.spyOn(blockActions, 'runWhenIdle').mockReturnValue(() => {})
    render(
      <>
        <Pane tabs={[sleeping]} shownId="h1" activePaneId="h1" workspaceId="s1" />
        <SurfacePool />
      </>,
    )
    const host = surfaceHost('h1')
    document.body.appendChild(host)
    expect(within(host).getByText('Hibernated')).toBeInTheDocument()
    await userEvent.keyboard('typed-while-asleep{Enter}')
    expect(window.ostia.pty.write).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Hibernated')).toBeInTheDocument()

    await userEvent.click(within(host).getByRole('button', { name: 'Resume claude' }))
    expect(within(host).queryByText('Hibernated')).toBeNull()
    expect(within(host).getByTestId('terminal-h1')).toBeInTheDocument()
    expect(window.ostia.pty.write).not.toHaveBeenCalled()
    host.remove()
  })

  it('marks the tab hibernated', () => {
    seed()
    render(<Pane tabs={[sleeping]} shownId="h1" activePaneId={'h1'} workspaceId="w" />)
    expect(screen.getByLabelText('Hibernated')).toBeInTheDocument()
  })
})
