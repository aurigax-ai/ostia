import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const terms: FakeXterm[] = []

class FakeXterm {
  options: Record<string, unknown>
  written: string[] = []
  disposed = false
  selection = ''
  unicode = { activeVersion: '' }
  keyHandler: ((e: KeyboardEvent) => boolean) | null = null
  constructor(options: Record<string, unknown>) {
    this.options = options
    terms.push(this)
  }
  loadAddon(): void {}
  open(): void {}
  attachCustomKeyEventHandler(handler: (e: KeyboardEvent) => boolean): void {
    this.keyHandler = handler
  }
  hasSelection(): boolean {
    return this.selection !== ''
  }
  getSelection(): string {
    return this.selection
  }
  write(data: string): void {
    this.written.push(data)
  }
  dispose(): void {
    this.disposed = true
  }
}

vi.mock('@xterm/xterm', () => ({ Terminal: FakeXterm }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {} }))
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }))
import { commands } from '@/commands/registry'
import { RESUME_CLAIM_MS, claimResume, clearResumeClaims } from '@/lib/agents/resumeFolder'
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
vi.mock('@/components/extensions/ExtensionPanelView', () => ({ ExtensionPanelView: () => null }))
vi.mock('./Terminal', () => ({
  TerminalView: ({ paneId, cwd }: { paneId: string; cwd?: string }) => (
    <div data-testid={`terminal-${paneId}`} data-cwd={cwd} />
  ),
}))

const { Pane } = await import('@/components/panes/Pane')
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
  terms.length = 0
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
  it('keeps the stashed screen frozen and read-only, and spawns no shell', async () => {
    seed()
    vi.mocked(window.ostia.pty.stashed).mockResolvedValueOnce('old agent output\r\n')
    render(<SurfacePool />)
    const host = surfaceHost('h1')
    document.body.appendChild(host)
    expect(within(host).getByText('Asleep')).toBeInTheDocument()
    expect(within(host).queryByTestId('terminal-h1')).toBeNull()
    expect(window.ostia.pty.stashed).toHaveBeenCalledWith('h1')
    const [term] = terms
    expect(term?.options.disableStdin).toBe(true)
    await vi.waitFor(() => expect(term?.written).toEqual(['old agent output\r\n']))
    expect(window.ostia.pty.attach).not.toHaveBeenCalled()
    expect(window.ostia.pty.write).not.toHaveBeenCalled()
    host.remove()
  })

  it('shows nothing it did not get from main when there is no stash', async () => {
    seed()
    render(<SurfacePool />)
    const host = surfaceHost('h1')
    document.body.appendChild(host)
    await vi.waitFor(() => expect(window.ostia.pty.stashed).toHaveBeenCalledWith('h1'))
    await Promise.resolve()
    expect(terms[0]?.written).toEqual([])
    host.remove()
  })

  it('copies a selection from the frozen screen and lets every other key through', () => {
    seed()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(<SurfacePool />)
    const term = terms[0]
    if (!term?.keyHandler) throw new Error('no key handler')
    term.selection = 'old agent output'
    const copy = new KeyboardEvent('keydown', {
      key: 'C',
      code: 'KeyC',
      ctrlKey: true,
      shiftKey: true,
    })
    expect(term.keyHandler(copy)).toBe(false)
    expect(writeText).toHaveBeenCalledWith('old agent output')
    expect(term.keyHandler(new KeyboardEvent('keydown', { key: 'a' }))).toBe(false)
    expect(window.ostia.pty.write).not.toHaveBeenCalled()
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
    expect(within(host).queryByText('Asleep')).toBeNull()
    expect(terms[0]?.disposed).toBe(true)
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

  it('a hibernated pane keeps its last screen frozen and read-only, and wakes with one copy of it', async () => {
    seed()
    vi.mocked(window.ostia.pty.stashed).mockResolvedValue('frozen-screen-381 up\r\n')
    vi.spyOn(blockActions, 'runWhenIdle').mockReturnValue(() => {})
    render(
      <>
        <Pane tabs={[sleeping]} shownId="h1" activePaneId="h1" workspaceId="s1" />
        <SurfacePool />
      </>,
    )
    const host = surfaceHost('h1')
    document.body.appendChild(host)
    expect(within(host).getByText('Asleep')).toBeInTheDocument()
    const [frozen] = terms
    await vi.waitFor(() => expect(frozen?.written).toEqual(['frozen-screen-381 up\r\n']))
    for (const key of [...'typed-while-asleep', 'Enter']) {
      expect(frozen?.keyHandler?.(new KeyboardEvent('keydown', { key }))).toBe(false)
    }
    expect(frozen?.options.disableStdin).toBe(true)
    expect(window.ostia.pty.write).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Hibernated')).toBeInTheDocument()

    await userEvent.click(within(host).getByRole('button', { name: 'Resume claude' }))
    expect(within(host).queryByText('Asleep')).toBeNull()
    expect(within(host).getByTestId('terminal-h1')).toBeInTheDocument()
    expect(frozen?.disposed).toBe(true)
    expect(terms).toHaveLength(1)
    expect(frozen?.written).toEqual(['frozen-screen-381 up\r\n'])
    expect(window.ostia.pty.write).not.toHaveBeenCalled()
    host.remove()
  })

  it('marks the tab hibernated', () => {
    seed()
    render(<Pane tabs={[sleeping]} shownId="h1" activePaneId={'h1'} workspaceId="w" />)
    expect(screen.getByLabelText('Hibernated')).toBeInTheDocument()
  })
})
