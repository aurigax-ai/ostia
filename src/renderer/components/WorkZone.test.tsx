import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { registerBuiltinCommands } from '../commands/builtins'
import { resetIds } from '../layout/tree'
import { useLayoutStore } from '../stores/layoutStore'
import { useUIStore } from '../stores/uiStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { WorkZone } from './WorkZone'
import { TooltipProvider } from './ui/tooltip'

vi.mock('./Terminal', () => ({
  TerminalView: ({ paneId }: { paneId: string }) => <div data-testid={`terminal-${paneId}`} />,
}))
vi.mock('./Editor', () => ({ EditorView: () => null }))
vi.mock('./DiffView', () => ({ DiffView: () => null }))

function renderZone(): void {
  render(
    <TooltipProvider>
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

    await user.click(screen.getByRole('button', { name: 'New terminal' }))
    const paneId = useLayoutStore.getState().byWorkspace[only.id]?.activePaneId
    expect(screen.getByTestId(`terminal-${paneId}`)).toBeInTheDocument()
  })

  it('leaves Settings when the empty state opens a workspace', async () => {
    useUIStore.getState().openSettings()
    const showWorkspaces = vi.spyOn(useUIStore.getState(), 'showWorkspaces')
    renderZone()

    await userEvent.setup().click(screen.getByRole('button', { name: /New workspace/ }))

    expect(showWorkspaces).toHaveBeenCalled()
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
})
