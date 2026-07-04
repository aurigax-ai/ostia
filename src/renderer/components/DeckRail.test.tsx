import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { type Session, useSessionsStore } from '../stores/sessionsStore'
import { useUIStore } from '../stores/uiStore'
import { DeckRail } from './DeckRail'

/**
 * DeckRail is the sidebar session rail. Its top switch toggles the sidebar view
 * (Sessions ⇄ Files) via uiStore; the Sessions view lists one row per session with a
 * kind icon and a live status dot, highlights the active row, and wires each row to
 * setActive/closeSession plus a "New session" control to addSession.
 *
 * These tests assert the REAL rendered content + wiring: rows carry accessible names,
 * the active row is marked, the status dot reflects `state`, and clicks reach the
 * sessionsStore/uiStore actions (spied on the live state object). No heavy deps are
 * mocked — DeckRail renders SessionsView by default and never mounts Monaco/xterm/
 * allotment; the per-test `window.pine` fake from test/setup.ts covers the bridge.
 *
 * UNSURE: the two view-switch buttons are icon-only and expose NO accessible name (Base
 * UI's tooltip does not label the trigger), so they are reached by their aria-pressed
 * toggle state rather than an accessible name.
 */

/** Two sessions: an active, working agent and an idle terminal. */
function seedSessions(): void {
  const sessions: Session[] = [
    { id: 's1', name: 'alpha', kind: 'agent', workDir: '/home/alpha', state: 'working' },
    { id: 's2', name: 'beta', kind: 'terminal', workDir: '/home/beta', state: 'idle' },
  ]
  useSessionsStore.setState({ sessions, activeSessionId: 's1' })
}

/** The `.rail-tab` container wrapping the row whose title matches `name`. */
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
    // Unmount before restoring the stores so a live tree can't re-render mid-reset.
    cleanup()
    useSessionsStore.setState(sessionsInit, true)
    useUIStore.setState(uiInit, true)
    vi.restoreAllMocks()
  })

  it('renders one row per session and marks the active one', () => {
    seedSessions()
    render(<DeckRail />)

    // Both sessions render as named row buttons (name = state + title + workDir).
    expect(screen.getByRole('button', { name: /alpha/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /beta/ })).toBeInTheDocument()

    // The active session's row carries the `active` marker; the inactive one does not.
    expect(rowFor(/alpha/)).toHaveClass('active')
    expect(rowFor(/beta/)).not.toHaveClass('active')
  })

  it('switches the active session when a row is clicked', async () => {
    seedSessions()
    const setActive = vi
      .spyOn(useSessionsStore.getState(), 'setActive')
      .mockImplementation(() => {})
    // Selecting a session must also leave Settings, so it can't stay hidden behind it.
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
    // Creating a session must also leave Settings, so the new one surfaces immediately.
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
    // Two rows each have a "Close" button — scope to beta's row to hit the right id.
    await userEvent.setup().click(within(rowFor(/beta/)).getByRole('button', { name: 'Close' }))

    expect(closeSession).toHaveBeenCalledWith('s2')
  })

  it('drives the status dot from the session state (working vs idle)', () => {
    seedSessions()
    render(<DeckRail />)

    // The dot is a role="img" labelled by its state; its class encodes the state too.
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

    // Row buttons are named by their session title; the add + close controls are labelled.
    expect(screen.getByRole('button', { name: /alpha/ }).tagName).toBe('BUTTON')
    expect(screen.getByRole('button', { name: 'New session' })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Close' })).toHaveLength(2)
  })

  it('toggles the sidebar view via the pressed switch buttons', async () => {
    seedSessions()
    // Default view is 'sessions': the Sessions switch is pressed, Files is not.
    expect(useUIStore.getState().sidebarView).toBe('sessions')
    const setSidebarView = vi.spyOn(useUIStore.getState(), 'setSidebarView')

    render(<DeckRail />)

    // Only the two switch buttons expose aria-pressed; the un-pressed one is Files.
    const filesSwitch = screen.getByRole('button', { pressed: false })
    expect(screen.getByRole('button', { pressed: true })).toBeInTheDocument()

    await userEvent.setup().click(filesSwitch)
    expect(setSidebarView).toHaveBeenCalledWith('files')
  })
})
