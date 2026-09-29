import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { useUIStore } from '../stores/uiStore'
import { type Workspace, useWorkspacesStore } from '../stores/workspacesStore'
import { DeckRail } from './DeckRail'

function seedWorkspaces(): void {
  const workspaces: Workspace[] = [
    { id: 's1', name: 'alpha', kind: 'agent', workDir: '/home/alpha', state: 'working' },
    { id: 's2', name: 'beta', kind: 'terminal', workDir: '/home/beta', state: 'idle' },
  ]
  useWorkspacesStore.setState({ workspaces, activeWorkspaceId: 's1' })
}

function rowFor(name: RegExp): HTMLElement {
  const main = screen.getByRole('button', { name })
  const tab = main.closest('.rail-tab')
  if (!tab) throw new Error('rail-tab wrapper not found')
  return tab as HTMLElement
}

describe('DeckRail', () => {
  let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
  let uiInit: ReturnType<typeof useUIStore.getState>

  beforeAll(() => {
    workspacesInit = useWorkspacesStore.getState()
    uiInit = useUIStore.getState()
  })

  afterEach(() => {
    cleanup()
    useWorkspacesStore.setState(workspacesInit, true)
    useUIStore.setState(uiInit, true)
    vi.restoreAllMocks()
  })

  it('renders one row per workspace and marks the active one', () => {
    seedWorkspaces()
    render(<DeckRail />)

    expect(screen.getByRole('button', { name: /alpha/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /beta/ })).toBeInTheDocument()

    expect(rowFor(/alpha/)).toHaveClass('active')
    expect(rowFor(/beta/)).not.toHaveClass('active')
  })

  it('switches the active workspace when a row is clicked', async () => {
    seedWorkspaces()
    const setActive = vi
      .spyOn(useWorkspacesStore.getState(), 'setActive')
      .mockImplementation(() => {})
    const leaveSettings = vi.spyOn(useUIStore.getState(), 'leaveSettings')

    render(<DeckRail />)
    await userEvent.setup().click(screen.getByRole('button', { name: /beta/ }))

    expect(setActive).toHaveBeenCalledWith('s2')
    expect(leaveSettings).toHaveBeenCalled()
  })

  it('adds a workspace via the New workspace control', async () => {
    seedWorkspaces()
    const addWorkspace = vi
      .spyOn(useWorkspacesStore.getState(), 'addWorkspace')
      .mockImplementation(() => {})
    const leaveSettings = vi.spyOn(useUIStore.getState(), 'leaveSettings')

    render(<DeckRail />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'New workspace' }))

    expect(addWorkspace).toHaveBeenCalledTimes(1)
    expect(leaveSettings).toHaveBeenCalled()
  })

  it('closes the clicked workspace with its own id', async () => {
    seedWorkspaces()
    const closeWorkspace = vi
      .spyOn(useWorkspacesStore.getState(), 'closeWorkspace')
      .mockImplementation(() => {})

    render(<DeckRail />)
    await userEvent.setup().click(within(rowFor(/beta/)).getByRole('button', { name: 'Close' }))

    expect(closeWorkspace).toHaveBeenCalledWith('s2')
  })

  it('drives the status dot from the workspace state (working vs idle)', () => {
    seedWorkspaces()
    render(<DeckRail />)

    const workingDot = screen.getByRole('img', { name: 'Working' })
    const idleDot = screen.getByRole('img', { name: 'Idle' })

    expect(workingDot).toHaveClass('workspace-dot', 'working')
    expect(workingDot).not.toHaveClass('idle')
    expect(idleDot).toHaveClass('workspace-dot', 'idle')
    expect(idleDot).not.toHaveClass('working')
  })

  it('gives interactive controls accessible names (a11y)', () => {
    seedWorkspaces()
    render(<DeckRail />)

    expect(screen.getByRole('button', { name: /alpha/ }).tagName).toBe('BUTTON')
    expect(screen.getByRole('button', { name: 'New workspace' })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Close' })).toHaveLength(2)
  })

  it('toggles the sidebar view via the pressed switch buttons', async () => {
    seedWorkspaces()
    expect(useUIStore.getState().sidebarView).toBe('workspaces')
    const setSidebarView = vi.spyOn(useUIStore.getState(), 'setSidebarView')

    render(<DeckRail />)

    const filesSwitch = screen.getByRole('button', { pressed: false })
    expect(screen.getByRole('button', { pressed: true })).toBeInTheDocument()

    await userEvent.setup().click(filesSwitch)
    expect(setSidebarView).toHaveBeenCalledWith('files')
  })

  describe('cmux-style rows', () => {
    const seedRows = () =>
      useWorkspacesStore.setState({
        workspaces: [
          {
            id: 's1',
            name: 'api',
            kind: 'terminal',
            workDir: '/src/api',
            state: 'idle',
            description: 'PR [#512](https://github.com/o/r/pull/512): fix refunds',
          },
          { id: 's2', name: 'web', kind: 'terminal', workDir: '/src/web', state: 'idle' },
        ],
        activeWorkspaceId: 's1',
      })

    it('shows the description with a working link outside the row button', () => {
      seedRows()
      render(<DeckRail />)
      const link = screen.getByRole('link', { name: '#512' })
      expect(link).toHaveAttribute('href', 'https://github.com/o/r/pull/512')
      expect(link).toHaveAttribute('target', '_blank')
      expect(link.closest('button')).toBeNull()
      expect(screen.getByText(/fix refunds/)).toBeInTheDocument()
    })

    it('pins a workspace to the top from its menu', async () => {
      seedRows()
      render(<DeckRail />)
      fireEvent.contextMenu(screen.getByRole('button', { name: /web/ }))
      await userEvent.setup().click(await screen.findByRole('menuitem', { name: 'Pin to top' }))
      const [first] = useWorkspacesStore.getState().workspaces
      expect(first).toMatchObject({ id: 's2', pinned: true })
      expect(screen.getByLabelText('Pinned')).toBeInTheDocument()
    })

    it('edits a description from the menu', async () => {
      seedRows()
      render(<DeckRail />)
      fireEvent.contextMenu(screen.getByRole('button', { name: /web/ }))
      const user = userEvent.setup()
      await user.click(await screen.findByRole('menuitem', { name: 'Add description' }))
      await user.type(
        screen.getByRole('textbox', { name: 'Workspace description' }),
        'deploy{Enter}',
      )
      expect(useWorkspacesStore.getState().workspaces[1].description).toBe('deploy')
    })

    it('shows each row’s shortcut digit only while hints are on', () => {
      seedRows()
      const { rerender } = render(<DeckRail />)
      expect(screen.queryByText('2')).toBeNull()
      useUIStore.setState({ digitHints: true })
      rerender(<DeckRail />)
      expect(screen.getByText('1')).toHaveClass('tab-digit')
      expect(screen.getByText('2')).toHaveClass('tab-digit')
    })
  })
})
