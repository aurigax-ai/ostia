import { create } from 'zustand'
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
}

let seq = 0
function nextId(): string {
  seq += 1
  return `s${seq}`
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
    setActive: (id) => set({ activeSessionId: id }),

    addSession: (workDir = '~') => {
      const session = makeSession(workDir)
      set((s) => ({ sessions: [...s.sessions, session], activeSessionId: session.id }))
      useLayoutStore.getState().ensure(session.id)
    },

    closeSession: (id) => {
      useLayoutStore.getState().removeSession(id)

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

    setWorkDir: (id, workDir) =>
      set((s) => ({
        sessions: s.sessions.map((c) =>
          c.id === id ? { ...c, workDir, name: nameFromWorkDir(workDir) } : c,
        ),
      })),
  }
})
