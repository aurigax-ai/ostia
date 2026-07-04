import '@testing-library/jest-dom/vitest'
import type { AppInfo } from '@shared/types'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { useLayoutStore } from '../stores/layoutStore'
import { type Session, type SessionState, useSessionsStore } from '../stores/sessionsStore'
import { StatusStrip } from './StatusStrip'

/**
 * StatusStrip is the bottom telemetry footer. It derives three live counts from the stores:
 *   - `{n} working` / `{n} waiting` from the sessions' `state` (waiting hidden when zero),
 *   - `{n} panes` from the ACTIVE session's layout tree (0 when the session has no layout),
 * plus a leading branch placeholder, two ambient UsageMeters (ctx/wk), and the app
 * `name vX` fetched once over the `window.pine.info` bridge (a `…` placeholder until it lands).
 *
 * It has no interactive controls — every segment is a read-only <span> — so there are no
 * click/spy assertions to make; the a11y surface is the `contentinfo` footer landmark and the
 * two titled meters. All strings come from the English i18n catalog (default locale).
 *
 * Mocking: only the per-test `window.pine.info` fake from test/setup.ts (default resolves to
 * `{ name: 'pine', version: '0.0.0' }`). StatusStrip pulls in no Monaco/xterm/allotment; the
 * dict/UsageMeter render under jsdom untouched.
 */

/** Seed the active session set with the given per-session states (ids `s1`, `s2`, …). */
function seedSessions(states: SessionState[], activeId = 's1'): void {
  const sessions: Session[] = states.map((state, i) => ({
    id: `s${i + 1}`,
    name: `sess${i + 1}`,
    kind: 'terminal',
    workDir: '/home/me',
    state,
  }))
  useSessionsStore.setState({ sessions, activeSessionId: activeId })
}

/** Transition one seeded session to a new state (triggers a store-driven re-render). */
function setState(id: string, state: SessionState): void {
  useSessionsStore.setState((s) => ({
    sessions: s.sessions.map((c) => (c.id === id ? { ...c, state } : c)),
  }))
}

describe('StatusStrip', () => {
  let sessionsInit: ReturnType<typeof useSessionsStore.getState>
  let layoutInit: ReturnType<typeof useLayoutStore.getState>

  beforeAll(() => {
    // Snapshot pristine store state (data + stable action fns) before any test mutates it.
    sessionsInit = useSessionsStore.getState()
    layoutInit = useLayoutStore.getState()
  })

  afterEach(() => {
    // Unmount BEFORE touching the stores so a still-mounted tree never re-renders on reset.
    cleanup()
    // Replace (not merge) so seeded sessions/layouts never bleed between tests.
    useSessionsStore.setState(sessionsInit, true)
    useLayoutStore.setState(layoutInit, true)
    vi.restoreAllMocks()
  })

  it('renders the working/waiting/pane counts and app info from seeded state', async () => {
    seedSessions(['working', 'working', 'waiting', 'idle'])
    useLayoutStore.getState().ensure('s1') // one-terminal layout → 1 pane

    render(<StatusStrip />)

    // All three counts are derived from the seeded stores (2 working, 1 waiting, 1 pane).
    expect(screen.getByText('2 working')).toBeInTheDocument()
    expect(screen.getByText('1 waiting')).toBeInTheDocument()
    expect(screen.getByText('1 panes')).toBeInTheDocument()
    // Bridge value flushes into the footer after window.pine.info() resolves.
    expect(await screen.findByText('pine v0.0.0')).toBeInTheDocument()
  })

  it('hides the waiting segment when no session is waiting', async () => {
    seedSessions(['working', 'idle'])
    useLayoutStore.getState().ensure('s1')

    render(<StatusStrip />)
    await screen.findByText('pine v0.0.0')

    expect(screen.getByText('1 working')).toBeInTheDocument()
    expect(screen.queryByText(/waiting/)).not.toBeInTheDocument()
  })

  it('counts panes as 0 when the active session has no layout', async () => {
    seedSessions(['idle']) // no ensure() → bySession[s1] is undefined

    render(<StatusStrip />)
    await screen.findByText('pine v0.0.0')

    expect(screen.getByText('0 panes')).toBeInTheDocument()
  })

  it('shows the … placeholder first, then the name+version once window.pine.info resolves', async () => {
    seedSessions(['idle'])
    useLayoutStore.getState().ensure('s1')
    // Defer info() so we can observe the placeholder BEFORE the bridge lands.
    let resolveInfo: (info: AppInfo) => void = () => {}
    vi.mocked(window.pine.info).mockReturnValue(
      new Promise<AppInfo>((resolve) => {
        resolveInfo = resolve
      }),
    )

    render(<StatusStrip />)

    // Pending: the muted placeholder is shown, no name yet.
    expect(screen.getByText('…')).toBeInTheDocument()
    expect(screen.queryByText(/^Pine v/)).not.toBeInTheDocument()

    // Resolved: the custom payload flows through (proves it's not a hardcoded string).
    await act(async () => {
      resolveInfo({ name: 'Pine', version: '9.9.9', platform: 'linux' })
    })

    expect(screen.getByText('Pine v9.9.9')).toBeInTheDocument()
    expect(screen.queryByText('…')).not.toBeInTheDocument()
  })

  it('updates the working count when a session transitions to working', async () => {
    seedSessions(['idle', 'idle'])
    useLayoutStore.getState().ensure('s1')

    render(<StatusStrip />)
    expect(await screen.findByText('0 working')).toBeInTheDocument()

    act(() => setState('s2', 'working'))

    expect(screen.getByText('1 working')).toBeInTheDocument()
    expect(screen.queryByText('0 working')).not.toBeInTheDocument()
  })

  it('reveals the waiting segment when a session starts waiting', async () => {
    seedSessions(['working', 'idle'])
    useLayoutStore.getState().ensure('s1')

    render(<StatusStrip />)
    await screen.findByText('pine v0.0.0')
    expect(screen.queryByText(/waiting/)).not.toBeInTheDocument()

    act(() => setState('s2', 'waiting'))

    expect(screen.getByText('1 waiting')).toBeInTheDocument()
    expect(screen.getByText('1 working')).toBeInTheDocument() // unchanged
  })

  it('recomputes the pane count when the active session layout splits', async () => {
    seedSessions(['idle'])
    useLayoutStore.getState().ensure('s1')

    render(<StatusStrip />)
    expect(await screen.findByText('1 panes')).toBeInTheDocument()

    const paneId = useLayoutStore.getState().bySession.s1.activePaneId
    act(() => useLayoutStore.getState().split('s1', paneId, 'horizontal'))

    expect(screen.getByText('2 panes')).toBeInTheDocument()
  })

  it('exposes a contentinfo landmark and the two ambient usage meters (a11y)', async () => {
    seedSessions(['idle'])
    useLayoutStore.getState().ensure('s1')

    render(<StatusStrip />)
    await screen.findByText('pine v0.0.0')

    expect(screen.getByRole('contentinfo')).toBeInTheDocument()
    expect(screen.getByTitle('ctx: 58%')).toBeInTheDocument()
    expect(screen.getByTitle('wk: 90%')).toBeInTheDocument()
    // `main ↑2` is a STATIC Phase 4 placeholder (StatusStrip.tsx:30), not state-derived —
    // asserted here only to pin the current markup, not as reactivity coverage.
    expect(screen.getByText('main ↑2')).toBeInTheDocument()
  })
})
