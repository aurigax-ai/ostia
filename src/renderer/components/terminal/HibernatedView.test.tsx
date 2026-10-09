import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
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
import { findPane } from '@/layout/tree'
import type { PaneNode } from '@/layout/types'
import * as blockActions from '@/lib/blockActions'
import { useLayoutStore } from '@/stores/layoutStore'
import { surfaceHost } from '@/stores/surfaceSlotsStore'
import { useWorkspacesStore } from '@/stores/workspacesStore'

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

beforeAll(() => {
  layoutInit = useLayoutStore.getState()
  workspacesInit = useWorkspacesStore.getState()
})

afterEach(() => {
  cleanup()
  terms.length = 0
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
      'claude --resume tok-1',
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

  it('marks the tab hibernated', () => {
    seed()
    render(<Pane tabs={[sleeping]} shownId="h1" activePaneId={'h1'} workspaceId="w" />)
    expect(screen.getByLabelText('Hibernated')).toBeInTheDocument()
  })
})
