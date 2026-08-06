import type { WorkspaceSnapshot } from '@shared/types'
import { create } from 'zustand'
import { restoreWorkspace } from '../layout/snapshot'
import { useLayoutStore } from './layoutStore'

/** Live state a session can be in (drives the rail's color + motion). */
export type SessionState = 'idle' | 'working' | 'waiting' | 'done'

/** What kind of thing a session is — picks its rail icon. */
export type SessionKind = 'agent' | 'terminal' | 'scratch'

export interface Session {
  id: string
  name: string
  kind: SessionKind
  /**
   * The session's **anchor** — its root working directory. New panes start here,
   * agents are scoped here, and `workspace <path>` re-sets it. Individual terminal
   * surfaces keep their own cwd, free to wander from this anchor (docs/ARCHITECTURE.md).
   */
  workDir: string
  state: SessionState
}

interface SessionsState {
  sessions: Session[]
  activeSessionId: string
  setActive: (id: string) => void
  /** Open a new session anchored at `workDir` and focus it. */
  addSession: (workDir?: string) => void
  /** Close a session; if it was active, fall to a neighbour (prefer the left one). */
  closeSession: (id: string) => void
  /** Re-anchor a session (backs the `workspace <path>` shell command). */
  setWorkDir: (id: string, workDir: string) => void
  /** Update a session's live state (rail color/motion) and mirror the change to main so the
   *  gateway can emit `session.state`/`agent.needs-input`/`agent.done` (contract §7). No-op if
   *  the session is unknown or already in that state (avoids a spurious lifecycle emit). */
  setState: (id: string, state: SessionState) => void
  /**
   * The boot path (session restore). Given the previous run's snapshot, replace the seeded
   * home session with the restored sessions + layouts; given `null`, keep the seeded one.
   * Either way, announce the final sessions to main — they were built before `window.pine`
   * existed (or without going through `addSession`), so their `session-added` never fired and
   * main-side services would have no workDir for them.
   *
   * Call once, before the first render: `WorkZone`'s `ensure` must find the restored layouts
   * already in place.
   */
  hydrate: (snapshot: WorkspaceSnapshot | null) => void
}

let seq = 0
function nextId(): string {
  seq += 1
  return `s${seq}`
}

/**
 * Advance the session-id counter past every `s<n>` id in `ids` (restore). Same hazard as
 * `layout/tree.ts`'s `adoptIds`: the counter starts at 0 in a fresh process, so without this
 * the next `addSession` re-mints an id a restored session already holds.
 */
function adoptSessionIds(ids: string[]): void {
  for (const id of ids) {
    const n = Number(/^s(\d+)$/.exec(id)?.[1])
    if (Number.isFinite(n)) seq = Math.max(seq, n)
  }
}

/** The session's display name: the last path segment of its workDir. */
function nameFromWorkDir(workDir: string): string {
  if (!workDir || workDir === '~') return 'home'
  const trimmed = workDir.replace(/\/+$/, '')
  const last = trimmed.split('/').pop()
  return last || 'session'
}

function makeSession(workDir: string, kind: SessionKind = 'terminal'): Session {
  return { id: nextId(), name: nameFromWorkDir(workDir), kind, workDir, state: 'idle' }
}

export const useSessionsStore = create<SessionsState>((set, get) => {
  const initial = makeSession('~')

  return {
    sessions: [initial],
    activeSessionId: initial.id,
    setActive: (id) => {
      set({ activeSessionId: id })
      window.pine?.lifecycle?.emit?.({ type: 'session-activated', sessionId: id })
    },

    addSession: (workDir = '~') => {
      const session = makeSession(workDir)
      set((s) => ({ sessions: [...s.sessions, session], activeSessionId: session.id }))
      useLayoutStore.getState().ensure(session.id)
      window.pine?.lifecycle?.emit?.({ type: 'session-added', sessionId: session.id, workDir })
    },

    closeSession: (id) => {
      useLayoutStore.getState().removeSession(id)
      window.pine?.lifecycle?.emit?.({ type: 'session-closed', sessionId: id })

      const remaining = get().sessions.filter((c) => c.id !== id)
      if (remaining.length === 0) {
        // Never leave zero sessions — fall back to a fresh one at home.
        const fresh = makeSession('~')
        set({ sessions: [fresh], activeSessionId: fresh.id })
        useLayoutStore.getState().ensure(fresh.id)
        return
      }

      set((s) => {
        const idx = s.sessions.findIndex((c) => c.id === id)
        let activeSessionId = s.activeSessionId
        if (id === s.activeSessionId) {
          activeSessionId = remaining[Math.max(0, idx - 1)]?.id ?? remaining[0].id
        }
        return { sessions: remaining, activeSessionId }
      })
    },

    setWorkDir: (id, workDir) => {
      set((s) => ({
        sessions: s.sessions.map((c) =>
          c.id === id ? { ...c, workDir, name: nameFromWorkDir(workDir) } : c,
        ),
      }))
      window.pine?.lifecycle?.emit?.({ type: 'session-added', sessionId: id, workDir })
    },

    hydrate: (snapshot) => {
      if (snapshot) {
        const { sessions, activeSessionId, layouts } = restoreWorkspace(snapshot)
        adoptSessionIds(sessions.map((s) => s.id))
        // A restored session always comes back idle: its shell is brand new, so any
        // working/waiting state from the last run would be a lie (see main/sessionSnapshot).
        set({ sessions: sessions.map((s) => ({ ...s, state: 'idle' })), activeSessionId })
        useLayoutStore.getState().hydrate(layouts)
      } else {
        for (const s of get().sessions) useLayoutStore.getState().ensure(s.id)
      }

      for (const s of get().sessions) {
        window.pine?.lifecycle?.emit?.({
          type: 'session-added',
          sessionId: s.id,
          workDir: s.workDir,
        })
      }
      window.pine?.lifecycle?.emit?.({
        type: 'session-activated',
        sessionId: get().activeSessionId,
      })
    },

    setState: (id, state) => {
      const current = get().sessions.find((c) => c.id === id)
      if (!current || current.state === state) return
      set((s) => ({
        sessions: s.sessions.map((c) => (c.id === id ? { ...c, state } : c)),
      }))
      window.pine?.lifecycle?.emit?.({ type: 'session-state', sessionId: id, state })
    },
  }
})
