import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { type Session, useSessionsStore } from '../stores/sessionsStore'
import { useUIStore } from '../stores/uiStore'
import { DeckRail } from './DeckRail'

function seedSessions(): void {
  const sessions: Session[] = [
    { id: 's1', name: 'alpha', kind: 'agent', workDir: '/home/alpha', state: 'working' },
    { id: 's2', name: 'beta', kind: 'terminal', workDir: '/home/beta', state: 'idle' },
  ]
  useSessionsStore.setState({ sessions, activeSessionId: 's1' })
}

function rowFor(name: RegExp): HTMLElement {
  const main = screen.getByRole('button', { name })
  const tab = main.closest('.rail-tab')
  if (!tab) throw new Error('rail-tab wrapper not found')
  return tab as HTMLElement
}

describe('DeckRail', () => {
  let sessionsInit: ReturnType<typeof useSessionsStore.getState>
  let uiInit: ReturnType<typeof useUIStore.getState>

  beforeAll(() => {
    sessionsInit = useSessionsStore.getState()
    uiInit = useUIStore.getState()
  })

  afterEach(() => {
    cleanup()
    useSessionsStore.setState(sessionsInit, true)
    useUIStore.setState(uiInit, true)
    vi.restoreAllMocks()
  })

  it('renders one row per session and marks the active one', () => {
    seedSessions()
    render(<DeckRail />)

    expect(screen.getByRole('button', { name: /alpha/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /beta/ })).toBeInTheDocument()

    expect(rowFor(/alpha/)).toHaveClass('active')
    expect(rowFor(/beta/)).not.toHaveClass('active')
  })

  it('switches the active session when a row is clicked', async () => {
    seedSessions()
    const setActive = vi
      .spyOn(useSessionsStore.getState(), 'setActive')
      .mockImplementation(() => {})
    const leaveSettings = vi.spyOn(useUIStore.getState(), 'leaveSettings')

    render(<DeckRail />)
    await userEvent.setup().click(screen.getByRole('button', { name: /beta/ }))

    expect(setActive).toHaveBeenCalledWith('s2')
    expect(leaveSettings).toHaveBeenCalled()
  })

  it('adds a session via the New session control', async () => {
    seedSessions()
    const addSession = vi
      .spyOn(useSessionsStore.getState(), 'addSession')
      .mockImplementation(() => {})
    const leaveSettings = vi.spyOn(useUIStore.getState(), 'leaveSettings')

    render(<DeckRail />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'New session' }))

    expect(addSession).toHaveBeenCalledTimes(1)
    expect(leaveSettings).toHaveBeenCalled()
  })

  it('closes the clicked session with its own id', async () => {
    seedSessions()
    const closeSession = vi
      .spyOn(useSessionsStore.getState(), 'closeSession')
      .mockImplementation(() => {})

    render(<DeckRail />)
    await userEvent.setup().click(within(rowFor(/beta/)).getByRole('button', { name: 'Close' }))

    expect(closeSession).toHaveBeenCalledWith('s2')
  })

  it('drives the status dot from the session state (working vs idle)', () => {
    seedSessions()
    render(<DeckRail />)

    const workingDot = screen.getByRole('img', { name: 'Working' })
    const idleDot = screen.getByRole('img', { name: 'Idle' })

    expect(workingDot).toHaveClass('session-dot', 'working')
    expect(workingDot).not.toHaveClass('idle')
    expect(idleDot).toHaveClass('session-dot', 'idle')
    expect(idleDot).not.toHaveClass('working')
  })

  it('gives interactive controls accessible names (a11y)', () => {
    seedSessions()
    render(<DeckRail />)

    expect(screen.getByRole('button', { name: /alpha/ }).tagName).toBe('BUTTON')
    expect(screen.getByRole('button', { name: 'New session' })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Close' })).toHaveLength(2)
  })

  it('toggles the sidebar view via the pressed switch buttons', async () => {
    seedSessions()
    expect(useUIStore.getState().sidebarView).toBe('sessions')
    const setSidebarView = vi.spyOn(useUIStore.getState(), 'setSidebarView')

    render(<DeckRail />)

    const filesSwitch = screen.getByRole('button', { pressed: false })
    expect(screen.getByRole('button', { pressed: true })).toBeInTheDocument()

    await userEvent.setup().click(filesSwitch)
    expect(setSidebarView).toHaveBeenCalledWith('files')
  })
})
