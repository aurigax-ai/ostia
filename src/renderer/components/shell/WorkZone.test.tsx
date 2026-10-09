import '@testing-library/jest-dom/vitest'
import { registerBuiltinCommands } from '@/commands/builtins'
import { DeckRail } from '@/components/rail/DeckRail'
import { TooltipProvider } from '@/components/ui/tooltip'
import { resetIds } from '@/layout/tree'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useUIStore } from '@/stores/app/uiStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { saveSnapshotNow } from '@/stores/workspaces/persistence'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import type { AppSnapshot } from '@shared/types'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { WorkZone } from './WorkZone'

vi.mock('@/components/terminal/Terminal', () => ({
  TerminalView: ({ paneId }: { paneId: string }) => <div data-testid={`terminal-${paneId}`} />,
}))
vi.mock('@/components/editor/Editor', () => ({ EditorView: () => null }))
vi.mock('@/components/editor/DiffView', () => ({ DiffView: () => null }))

function renderZone(): void {
  render(
    <TooltipProvider>
      <WorkZone />
    </TooltipProvider>,
  )
}

function renderShell(): void {
  render(
    <TooltipProvider>
      <DeckRail />
      <WorkZone />
    </TooltipProvider>,
  )
}

describe('WorkZone', () => {
  let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
  let layoutInit: ReturnType<typeof useLayoutStore.getState>
  let uiInit: ReturnType<typeof useUIStore.getState>

  beforeAll(() => {
    registerBuiltinCommands()
    workspacesInit = useWorkspacesStore.getState()
    layoutInit = useLayoutStore.getState()
    uiInit = useUIStore.getState()
  })

  afterEach(() => {
    cleanup()
    useWorkspacesStore.setState(workspacesInit, true)
    useLayoutStore.setState(layoutInit, true)
    useUIStore.setState(uiInit, true)
    resetIds()
    vi.restoreAllMocks()
  })

  function restart(): AppSnapshot | null {
    saveSnapshotNow()
    const saved = vi.mocked(window.ostia.workspace.save).mock.calls.at(-1)?.[0] ?? null
    cleanup()
    useWorkspacesStore.setState(workspacesInit, true)
    useLayoutStore.setState(layoutInit, true)
    useWorkspacesStore.getState().hydrate(saved && JSON.parse(JSON.stringify(saved)))
    renderShell()
    return saved
  }

  function openTerminalWorkspace(): void {
    useWorkspacesStore.getState().addWorkspace()
    useLayoutStore.getState().ensure(useWorkspacesStore.getState().workspaces[0].id)
  }

  it('shows the empty state with the new-workspace shortcut when there are no workspaces', () => {
    renderZone()

    expect(screen.getByRole('heading', { name: 'No workspaces' })).toBeInTheDocument()
    expect(screen.getByText('Start a terminal in your home folder.')).toBeInTheDocument()
    const button = screen.getByRole('button', { name: /New workspace/ })
    expect(button).toHaveTextContent('Ctrl+Shift+N')
    expect(screen.getByRole('button', { name: /New terminal/ })).toHaveTextContent('Ctrl+Shift+T')
    expect(screen.queryByTestId(/^terminal-/)).toBeNull()
  })

  it('opens a workspace with a running terminal from the empty state', async () => {
    renderZone()

    await userEvent.setup().click(screen.getByRole('button', { name: /New terminal/ }))

    const id = useWorkspacesStore.getState().activeWorkspaceId
    expect(id).not.toBeNull()
    const paneId = useLayoutStore.getState().byWorkspace[id ?? '']?.activePaneId
    expect(screen.getByTestId(`terminal-${paneId}`)).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'No workspaces' })).toBeNull()
  })

  it('opens an empty workspace at home that offers a terminal', async () => {
    renderZone()
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: /New workspace/ }))

    const [only] = useWorkspacesStore.getState().workspaces
    expect(only).toMatchObject({ workDir: '~', name: 'home', kind: 'terminal' })
    expect(useWorkspacesStore.getState().activeWorkspaceId).toBe(only.id)
    expect(screen.queryByRole('heading', { name: 'No workspaces' })).toBeNull()
    expect(useLayoutStore.getState().byWorkspace[only.id]).toBeUndefined()

    const terminal = screen.getByRole('button', { name: /New terminal/ })
    expect(terminal).toHaveTextContent('Ctrl+Shift+T')
    expect(screen.getByRole('button', { name: /New browser/ })).not.toHaveTextContent('Ctrl')
    await user.click(terminal)
    const paneId = useLayoutStore.getState().byWorkspace[only.id]?.activePaneId
    expect(screen.getByTestId(`terminal-${paneId}`)).toBeInTheDocument()
  })

  it('labels the empty workspace browser button with a user binding', async () => {
    const before = useSettingsStore.getState().keybindings
    useSettingsStore.setState({ keybindings: { 'tab.newBrowser': 'Ctrl+Shift+B' } })
    try {
      renderZone()
      await userEvent.setup().click(screen.getByRole('button', { name: /New workspace/ }))

      expect(screen.getByRole('button', { name: /New browser/ })).toHaveTextContent('Ctrl+Shift+B')
    } finally {
      act(() => {
        useSettingsStore.setState({ keybindings: before })
      })
    }
  })

  it('leaves Settings when the empty state opens a workspace', async () => {
    useUIStore.getState().openSettings()
    const showWorkspaces = vi.spyOn(useUIStore.getState(), 'showWorkspaces')
    renderZone()

    await userEvent.setup().click(screen.getByRole('button', { name: /New workspace/ }))

    expect(showWorkspaces).toHaveBeenCalled()
  })

  it('with auto-resume on, every agent resumes at startup: shown tab, background tab and unopened workspace', () => {
    const before = useSettingsStore.getState().agents
    useSettingsStore.setState({ agents: { ...before, autoResume: true } })
    const agent = (id: string) => ({
      type: 'pane' as const,
      id,
      title: 'claude',
      kind: 'terminal' as const,
      resume: { agent: 'claude' as const, id: `resume-${id}` },
      agentRunning: true as const,
    })
    try {
      useWorkspacesStore.getState().hydrate({
        v: 1,
        savedAt: '',
        activeWorkspaceId: 's1',
        groups: [],
        workspaces: [
          {
            id: 's1',
            name: 'agents',
            kind: 'terminal',
            workDir: '/w',
            root: {
              type: 'tabs',
              id: 'tabs-1',
              activeId: 'pane-1',
              children: [agent('pane-1'), agent('pane-2')],
            },
            activePaneId: 'pane-1',
          },
          {
            id: 's2',
            name: 'elsewhere',
            kind: 'terminal',
            workDir: '/w',
            root: agent('pane-3'),
            activePaneId: 'pane-3',
          },
        ],
      })
      renderZone()

      for (const id of ['pane-1', 'pane-2', 'pane-3']) {
        expect(screen.getByTestId(`terminal-${id}`)).toBeInTheDocument()
      }
      expect(screen.getAllByRole('tab', { selected: true })).toHaveLength(1)
    } finally {
      act(() => {
        useSettingsStore.setState({ agents: before })
      })
    }
  })

  it('returns to the empty state when the last workspace closes', () => {
    useWorkspacesStore.getState().addWorkspace()
    renderZone()
    expect(screen.queryByRole('heading', { name: 'No workspaces' })).toBeNull()

    const id = useWorkspacesStore.getState().workspaces[0].id
    act(() => useWorkspacesStore.getState().closeWorkspace(id))

    expect(screen.getByRole('heading', { name: 'No workspaces' })).toBeInTheDocument()
    expect(screen.queryByTestId(/^terminal-/)).toBeNull()
    expect(useWorkspacesStore.getState().workspaces).toEqual([])
  })

  it('boots with no workspaces when there is nothing to restore', () => {
    useWorkspacesStore.getState().hydrate(null)
    renderShell()

    expect(screen.getByRole('heading', { name: 'No workspaces' })).toBeInTheDocument()
    expect(screen.queryByTestId(/^terminal-/)).toBeNull()
    expect(document.querySelector('.rail-tab')).toBeNull()
  })

  it('restores zero workspaces after the last workspace was closed', async () => {
    openTerminalWorkspace()
    renderShell()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.getByRole('heading', { name: 'No workspaces' })).toBeInTheDocument()

    expect(restart()?.workspaces).toEqual([])

    expect(screen.getByRole('heading', { name: 'No workspaces' })).toBeInTheDocument()
    expect(screen.queryByTestId(/^terminal-/)).toBeNull()
    expect(document.querySelector('.rail-tab')).toBeNull()
  })

  it('keeps an emptied, renamed workspace across a restart', async () => {
    openTerminalWorkspace()
    renderShell()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Close tab' }))
    expect(screen.queryByTestId(/^terminal-/)).toBeNull()
    expect(screen.getByRole('button', { name: /New terminal/ })).toBeInTheDocument()

    await user.dblClick(screen.getByText('home'))
    const name = screen.getByRole('textbox', { name: 'Workspace name' })
    await user.clear(name)
    await user.type(name, 'payments{Enter}')
    expect(screen.getByText('payments')).toHaveClass('tab-title')

    restart()

    expect(screen.getByText('payments')).toHaveClass('tab-title')
    expect(screen.getByRole('button', { name: /New terminal/ })).toBeInTheDocument()
    expect(screen.queryByTestId(/^terminal-/)).toBeNull()
  })
})
