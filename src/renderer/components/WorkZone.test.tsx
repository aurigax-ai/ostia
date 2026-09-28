import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { resetIds } from '../layout/tree'
import { useLayoutStore } from '../stores/layoutStore'
import { useSessionsStore } from '../stores/sessionsStore'
import { useUIStore } from '../stores/uiStore'
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
  let sessionsInit: ReturnType<typeof useSessionsStore.getState>
  let layoutInit: ReturnType<typeof useLayoutStore.getState>
  let uiInit: ReturnType<typeof useUIStore.getState>

  beforeAll(() => {
    sessionsInit = useSessionsStore.getState()
    layoutInit = useLayoutStore.getState()
    uiInit = useUIStore.getState()
  })

  afterEach(() => {
    cleanup()
    useSessionsStore.setState(sessionsInit, true)
    useLayoutStore.setState(layoutInit, true)
    useUIStore.setState(uiInit, true)
    resetIds()
    vi.restoreAllMocks()
  })

  it('shows the empty state with the new-session shortcut when there are no sessions', () => {
    renderZone()

    expect(screen.getByRole('heading', { name: 'No sessions' })).toBeInTheDocument()
    expect(screen.getByText('Start a terminal in your home folder.')).toBeInTheDocument()
    const button = screen.getByRole('button', { name: /New session/ })
    expect(button).toHaveTextContent('Ctrl+Shift+T')
    expect(screen.queryByTestId(/^terminal-/)).toBeNull()
  })

  it('opens a terminal session at home from the empty state button', async () => {
    renderZone()

    await userEvent.setup().click(screen.getByRole('button', { name: /New session/ }))

    const [only] = useSessionsStore.getState().sessions
    expect(only).toMatchObject({ workDir: '~', name: 'home', kind: 'terminal' })
    expect(useSessionsStore.getState().activeSessionId).toBe(only.id)
    expect(screen.queryByRole('heading', { name: 'No sessions' })).toBeNull()
    const paneId = useLayoutStore.getState().bySession[only.id]?.activePaneId
    expect(screen.getByTestId(`terminal-${paneId}`)).toBeInTheDocument()
  })

  it('leaves Settings when the empty state opens a session', async () => {
    useUIStore.getState().openSettings()
    const leaveSettings = vi.spyOn(useUIStore.getState(), 'leaveSettings')
    renderZone()

    await userEvent.setup().click(screen.getByRole('button', { name: /New session/ }))

    expect(leaveSettings).toHaveBeenCalled()
  })

  it('returns to the empty state when the last session closes', () => {
    useSessionsStore.getState().addSession()
    renderZone()
    expect(screen.queryByRole('heading', { name: 'No sessions' })).toBeNull()

    const id = useSessionsStore.getState().sessions[0].id
    act(() => useSessionsStore.getState().closeSession(id))

    expect(screen.getByRole('heading', { name: 'No sessions' })).toBeInTheDocument()
    expect(screen.queryByTestId(/^terminal-/)).toBeNull()
    expect(useSessionsStore.getState().sessions).toEqual([])
  })
})
