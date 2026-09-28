import type { SessionLiveState, WorkspaceSnapshot } from '@shared/types'
import { create } from 'zustand'
import { restoreWorkspace } from '../layout/snapshot'
import { useLayoutStore } from './layoutStore'

export type SessionState = SessionLiveState

export type SessionKind = 'agent' | 'terminal' | 'scratch'

export interface Session {
  id: string
  name: string
  kind: SessionKind
  workDir: string
  state: SessionState
}

interface SessionsState {
  sessions: Session[]
  activeSessionId: string | null
  setActive: (id: string) => void
  addSession: (workDir?: string) => void
  closeSession: (id: string) => void
  setWorkDir: (id: string, workDir: string) => void
  setState: (id: string, state: SessionState) => void
  hydrate: (snapshot: WorkspaceSnapshot | null) => void
}

let seq = 0
function nextId(): string {
  seq += 1
  return `s${seq}`
}

function adoptSessionIds(ids: string[]): void {
  for (const id of ids) {
    const n = Number(/^s(\d+)$/.exec(id)?.[1])
    if (Number.isFinite(n)) seq = Math.max(seq, n)
  }
}

function nameFromWorkDir(workDir: string): string {
  if (!workDir || workDir === '~') return 'home'
  const trimmed = workDir.replace(/\/+$/, '')
  const last = trimmed.split('/').pop()
  return last || 'session'
}

function makeSession(workDir: string, kind: SessionKind = 'terminal'): Session {
  return { id: nextId(), name: nameFromWorkDir(workDir), kind, workDir, state: 'idle' }
}

export const useSessionsStore = create<SessionsState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
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

    set((s) => {
      const remaining = s.sessions.filter((c) => c.id !== id)
      const idx = s.sessions.findIndex((c) => c.id === id)
      let activeSessionId = s.activeSessionId
      if (id === s.activeSessionId) {
        activeSessionId = remaining[Math.max(0, idx - 1)]?.id ?? remaining[0]?.id ?? null
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
      set({ sessions: sessions.map((s) => ({ ...s, state: 'idle' })), activeSessionId })
      useLayoutStore.getState().hydrate(layouts)
    }

    for (const s of get().sessions) {
      window.pine?.lifecycle?.emit?.({
        type: 'session-added',
        sessionId: s.id,
        workDir: s.workDir,
      })
    }
    const activeSessionId = get().activeSessionId
    if (activeSessionId) {
      window.pine?.lifecycle?.emit?.({ type: 'session-activated', sessionId: activeSessionId })
    }
  },

  setState: (id, state) => {
    const current = get().sessions.find((c) => c.id === id)
    if (!current || current.state === state) return
    set((s) => ({
      sessions: s.sessions.map((c) => (c.id === id ? { ...c, state } : c)),
    }))
    window.pine?.lifecycle?.emit?.({ type: 'session-state', sessionId: id, state })
  },
}))
